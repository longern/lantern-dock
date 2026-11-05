package nas

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
)

func signedJWT(t *testing.T, key any, alg jose.SignatureAlgorithm, headers map[jose.HeaderKey]any, payload map[string]any) string {
	t.Helper()
	options := &jose.SignerOptions{}
	for k, v := range headers {
		options.WithHeader(k, v)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: alg, Key: key}, options)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(payload)
	value, err := signer.Sign(body)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := value.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestDiscoveryRefreshRolloverAndTrustBoundary(t *testing.T) {
	public1, private1, _ := ed25519.GenerateKey(rand.Reader)
	public2, private2, _ := ed25519.GenerateKey(rand.Reader)
	key1 := jose.JSONWebKey{Key: public1, KeyID: "one", Algorithm: "EdDSA", Use: "sig"}
	key2 := jose.JSONWebKey{Key: public2, KeyID: "two", Algorithm: "EdDSA", Use: "sig"}
	var document, keyDocument atomic.Value
	var keyFetches, metadataFetches atomic.Int64
	var portal *httptest.Server
	portal = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/oauth-authorization-server":
			metadataFetches.Add(1)
			w.Write([]byte(document.Load().(string)))
		case "/custom/keys":
			keyFetches.Add(1)
			json.NewEncoder(w).Encode(keyDocument.Load())
		default:
			t.Error("unexpected lookup", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer portal.Close()
	metadata := func(issuer, uri string) string {
		value, _ := json.Marshal(map[string]any{"issuer": issuer, "jwks_uri": uri, "lantern_dock": map[string]any{"protocol_version": 1}})
		return string(value)
	}
	document.Store(metadata(portal.URL, portal.URL+"/custom/keys"))
	keyDocument.Store(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{key1}})
	client := portal.Client()
	ctx := oidc.ClientContext(context.Background(), client)
	keys := &rotatingKeys{ctx: ctx, uri: portal.URL, client: client}
	token := func(key ed25519.PrivateKey, kid string) string {
		return signedJWT(t, key, jose.EdDSA, map[jose.HeaderKey]any{"kid": kid}, map[string]any{"sub": "owner"})
	}
	one, two := token(private1, "one"), token(private2, "two")
	if _, err := keys.VerifySignature(ctx, one); err != nil {
		t.Fatal(err)
	}
	keyDocument.Store(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{key1, key2}})
	if _, err := keys.VerifySignature(ctx, two); err != nil {
		t.Fatal("unknown kid did not refresh", err)
	}
	if keyFetches.Load() != 2 || metadataFetches.Load() != 1 {
		t.Fatal("incorrect discovery/key cache behavior")
	}
	if _, err := keys.VerifySignature(ctx, one); err != nil {
		t.Fatal("overlap rejected", err)
	}
	keyDocument.Store(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{key2}})
	keys.expires = time.Now().Add(-time.Second)
	if _, err := keys.VerifySignature(ctx, two); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.VerifySignature(ctx, one); err == nil {
		t.Fatal("retired key remained trusted after refresh")
	}
	// A cached, valid key still works while metadata is unavailable.
	document.Store("unavailable")
	if _, err := keys.VerifySignature(ctx, two); err != nil {
		t.Fatal("discarded live cache", err)
	}
	for _, bad := range []string{
		"unavailable",
		metadata("https://wrong.example", portal.URL+"/custom/keys"),
		metadata(portal.URL, "http://localhost/keys"),
		metadata(portal.URL, "https://untrusted.example/keys"),
		metadata(portal.URL, portal.URL+"/custom/keys") + ` {"extra":true}`,
		strings.Replace(metadata(portal.URL, portal.URL+"/custom/keys"), `"protocol_version":1`, `"protocol_version":2`, 1),
	} {
		document.Store(bad)
		keys.expires = time.Now().Add(-time.Second)
		before := keyFetches.Load()
		if _, err := keys.VerifySignature(ctx, two); !errors.Is(err, errIdentityDiscovery) {
			t.Fatal("accepted untrusted metadata", err)
		}
		if keyFetches.Load() != before {
			t.Fatal("followed invalid discovery metadata")
		}
	}
}

func TestDPoPURIComparison(t *testing.T) {
	for _, value := range []string{"https://portal.example/api/account", "https://PORTAL.example:443/%61pi/account"} {
		if !sameProofURI(value, "https://portal.example/api/account") {
			t.Fatal("equivalent URI rejected", value)
		}
	}
	for _, value := range []string{"https://portal.example/api/account?x=1", "https://portal.example/api/account#part", "https://portal.example/other", "https://user@portal.example/api/account", "https://portal.example/api%2faccount", "https://other.example/api/account", "http://portal.example/api/account", "https://portal.example/%"} {
		if sameProofURI(value, "https://portal.example/api/account") {
			t.Fatal("different URI accepted", value)
		}
	}
}
func TestIdentityProofAndLocalAdministrator(t *testing.T) {
	f := newFixture(t)
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	var keyFetches atomic.Int64
	var metadataFetches atomic.Int64
	var portal *httptest.Server
	portal = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/oauth-authorization-server" {
			metadataFetches.Add(1)
			json.NewEncoder(w).Encode(map[string]any{"issuer": portal.URL, "jwks_uri": portal.URL + "/keys/current", "lantern_dock": map[string]any{"protocol_version": 1}})
			return
		}
		keyFetches.Add(1)
		if r.URL.Path != "/keys/current" {
			t.Error("unexpected identity lookup", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{"keys": []jose.JSONWebKey{{Key: public, KeyID: "portal", Algorithm: "EdDSA", Use: "sig"}}})
	}))
	defer portal.Close()
	if err := f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: portal.URL, Issuer: "https://sso.example", AdminSubjects: []string{"owner"}, HTTPClient: portal.Client()}); err != nil {
		t.Fatal(err)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk := jose.JSONWebKey{Key: &key.PublicKey}
	hash, _ := jwk.Thumbprint(crypto.SHA256)
	thumb := base64.RawURLEncoding.EncodeToString(hash)
	grant := func(sub string, patch map[string]any) string {
		payload := map[string]any{"iss": portal.URL, "aud": portal.URL + "/nas", "identity_issuer": "https://sso.example", "sub": sub, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(), "jti": randomID(), "client_id": portal.URL + "/", "scope": "account:read", "cnf": map[string]string{"jkt": thumb}}
		for k, v := range patch {
			payload[k] = v
		}
		return signedJWT(t, private, jose.EdDSA, map[jose.HeaderKey]any{"kid": "portal", "typ": "at+jwt"}, payload)
	}
	proof := func(token string, patch map[string]any) string {
		h := sha256.Sum256([]byte(token))
		payload := map[string]any{"jti": randomID(), "iat": time.Now().Unix(), "htm": "GET", "htu": portal.URL + "/api/account", "ath": base64.RawURLEncoding.EncodeToString(h[:])}
		for k, v := range patch {
			payload[k] = v
		}
		return signedJWT(t, key, jose.ES256, map[jose.HeaderKey]any{"typ": "dpop+jwt", "jwk": jwk}, payload)
	}
	request := func(token, p string) *http.Response {
		return f.request(t, "GET", "/api/account", "", nil, map[string]string{"Authorization": "DPoP " + token, "DPoP": p})
	}
	token := grant("owner", nil)
	p := proof(token, nil)
	r := request(token, p)
	status(t, r, 200)
	body := read(t, r)
	if !strings.Contains(body, `"role":"admin"`) || strings.Contains(body, "ADMIN_SUBJECTS") {
		t.Fatal(body)
	}
	encodedClaims, _ := base64.RawURLEncoding.DecodeString(strings.Split(token, ".")[1])
	var originalClaims map[string]any
	json.Unmarshal(encodedClaims, &originalClaims)
	for _, header := range []map[jose.HeaderKey]any{
		{"kid": "portal", "typ": "JWT"},
		{"kid": "portal", "typ": "dpop+jwt"},
		{"typ": "at+jwt"},
	} {
		wrongType := signedJWT(t, private, jose.EdDSA, header, originalClaims)
		status(t, request(wrongType, proof(wrongType, nil)), 401)
	}
	mediaType := signedJWT(t, private, jose.EdDSA, map[jose.HeaderKey]any{"kid": "portal", "typ": "application/at+jwt"}, originalClaims)
	status(t, request(mediaType, proof(mediaType, nil)), 200)
	replayed := request(token, p)
	status(t, replayed, 401)
	if !strings.Contains(replayed.Header.Get("WWW-Authenticate"), `DPoP realm="lantern-dock"`) || !strings.Contains(read(t, replayed), `"error":"invalid_dpop_proof"`) {
		t.Fatal("incorrect DPoP challenge")
	}
	for _, patch := range []map[string]any{{"htm": "POST"}, {"htu": portal.URL + "/dav/"}, {"ath": "wrong"}, {"iat": time.Now().Add(-2 * time.Minute).Unix()}} {
		status(t, request(token, proof(token, patch)), 401)
	}
	for _, patch := range []map[string]any{{"aud": "other"}, {"iss": "https://attacker.example"}, {"identity_issuer": "https://other-sso.example"}, {"exp": time.Now().Add(-time.Minute).Unix()}, {"exp": time.Now().Add(time.Hour).Unix()}, {"exp": nil}, {"iat": nil}, {"client_id": ""}, {"jti": ""}, {"nbf": time.Now().Add(time.Minute).Unix()}} {
		bad := grant("owner", patch)
		status(t, request(bad, proof(bad, nil)), 401)
	}
	unscoped := grant("owner", map[string]any{"scope": "files:write"})
	r = request(unscoped, proof(unscoped, nil))
	status(t, r, 403)
	if !strings.Contains(r.Header.Get("WWW-Authenticate"), `scope="account:read"`) {
		t.Fatal("missing scope challenge")
	}
	read(t, r)
	member := grant("member", nil)
	r = request(member, proof(member, nil))
	status(t, r, 200)
	if !strings.Contains(read(t, r), `"role":"member"`) {
		t.Fatal("member escalated")
	}
	// Removing an administrator applies to the next request, including old grants.
	delete(f.s.identity.admins, "owner")
	r = request(token, proof(token, nil))
	status(t, r, 200)
	if !strings.Contains(read(t, r), `"role":"member"`) {
		t.Fatal("stale administrator role")
	}
	if keyFetches.Load() != 1 || metadataFetches.Load() != 1 {
		t.Fatalf("verification was not local: %d fetches", keyFetches.Load())
	}
	denied := f.request(t, "GET", "/api/account", "", nil, map[string]string{"Authorization": "Bearer " + token, "DPoP": proof(token, nil)})
	status(t, denied, 401)
	if !strings.HasPrefix(denied.Header.Get("WWW-Authenticate"), "DPoP ") {
		t.Fatal("identity challenge was overwritten")
	}
	read(t, denied)
	f.s.Store.DB.Close()
	unavailable := request(token, proof(token, nil))
	status(t, unavailable, 503)
	if !strings.Contains(read(t, unavailable), `"error":"temporarily_unavailable"`) || unavailable.Header.Get("WWW-Authenticate") != "" {
		t.Fatal("storage failure incorrectly reported as login failure")
	}
}
func TestIdentityConfigurationAndBootstrap(t *testing.T) {
	for _, raw := range []string{`"owner"`, `null`, `[1]`, `[""]`} {
		cfg, err := IdentityEnvironment(func(key string) string {
			switch key {
			case "ADMIN_SUBJECTS":
				return raw
			case "SITE_ORIGIN":
				return "https://portal.example"
			case "OIDC_ISSUER_URL":
				return "https://sso.example"
			}
			return ""
		})
		if err == nil {
			f := newFixture(t)
			err = f.s.ConfigureIdentity(cfg)
		}
		if err == nil {
			t.Fatal("accepted bad subjects", raw)
		}
	}
	f := newFixture(t)
	r := f.request(t, "GET", "/api/account/config", "", nil, nil)
	status(t, r, 200)
	if !strings.Contains(read(t, r), `"enabled":false`) {
		t.Fatal("unexpected identity config")
	}
	if err := f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: "http://portal.example", Issuer: "https://sso.example"}); err == nil {
		t.Fatal("accepted HTTP")
	}
}
