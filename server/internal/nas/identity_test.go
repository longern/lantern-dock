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
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

func identityTestSubject(seed string) string {
	digest := sha256.Sum256([]byte(seed))
	return "ld_" + base64.RawURLEncoding.EncodeToString(digest[:16])
}

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
		value, _ := json.Marshal(map[string]any{"issuer": issuer, "jwks_uri": uri, "lantern_dock": map[string]any{"protocol_version": 2}})
		return string(value)
	}
	document.Store(metadata(portal.URL, portal.URL+"/custom/keys"))
	keyDocument.Store(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{key1}})
	client := portal.Client()
	ctx := context.Background()
	keys := &rotatingKeys{ctx: ctx, uri: portal.URL, client: client}
	verify := func(raw string) error {
		signed, err := jose.ParseSigned(raw, []jose.SignatureAlgorithm{jose.EdDSA})
		if err != nil {
			return err
		}
		key, err := keys.verificationKey(ctx, signed.Signatures[0].Protected.KeyID)
		if err != nil {
			return err
		}
		_, err = signed.Verify(key)
		return err
	}
	token := func(key ed25519.PrivateKey, kid string) string {
		return signedJWT(t, key, jose.EdDSA, map[jose.HeaderKey]any{"kid": kid}, map[string]any{"sub": identityTestSubject("owner")})
	}
	one, two := token(private1, "one"), token(private2, "two")
	if err := verify(one); err != nil {
		t.Fatal(err)
	}
	keyDocument.Store(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{key1, key2}})
	if err := verify(two); err != nil {
		t.Fatal("unknown kid did not refresh", err)
	}
	if keyFetches.Load() != 2 || metadataFetches.Load() != 1 {
		t.Fatal("incorrect discovery/key cache behavior")
	}
	if err := verify(one); err != nil {
		t.Fatal("overlap rejected", err)
	}
	for _, kid := range []string{"unknown-one", "unknown-two", "unknown-three"} {
		if err := verify(token(private2, kid)); err == nil {
			t.Fatal("unknown key accepted", kid)
		}
	}
	if keyFetches.Load() != 2 {
		t.Fatal("unknown keys bypassed the global cooldown")
	}
	keyDocument.Store(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{key2}})
	keys.expires = time.Now().Add(-time.Second)
	keys.refreshAfter = time.Time{}
	if err := verify(two); err != nil {
		t.Fatal(err)
	}
	if err := verify(one); err == nil {
		t.Fatal("retired key remained trusted after refresh")
	}
	// A cached, valid key still works while metadata is unavailable.
	document.Store("unavailable")
	if err := verify(two); err != nil {
		t.Fatal("discarded live cache", err)
	}
	for _, bad := range []string{
		"unavailable",
		metadata("https://wrong.example", portal.URL+"/custom/keys"),
		metadata(portal.URL, "http://localhost/keys"),
		metadata(portal.URL, "https://untrusted.example/keys"),
		metadata(portal.URL, portal.URL+"/custom/keys") + ` {"extra":true}`,
		strings.Replace(metadata(portal.URL, portal.URL+"/custom/keys"), `"protocol_version":2`, `"protocol_version":1`, 1),
	} {
		document.Store(bad)
		keys.expires = time.Now().Add(-time.Second)
		keys.refreshAfter = time.Time{}
		before := keyFetches.Load()
		if err := verify(two); !errors.Is(err, errIdentityDiscovery) {
			t.Fatal("accepted untrusted metadata", err)
		}
		if keyFetches.Load() != before {
			t.Fatal("followed invalid discovery metadata")
		}
		beforeDiscovery := metadataFetches.Load()
		if err := verify(two); !errors.Is(err, errIdentityDiscovery) || metadataFetches.Load() != beforeDiscovery {
			t.Fatal("failed discovery was retried during cooldown", err)
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
			json.NewEncoder(w).Encode(map[string]any{"issuer": portal.URL, "jwks_uri": portal.URL + "/keys/current", "lantern_dock": map[string]any{"protocol_version": 2}})
			return
		}
		keyFetches.Add(1)
		if r.URL.Path != "/keys/current" {
			t.Error("unexpected identity lookup", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{"keys": []jose.JSONWebKey{{Key: public, KeyID: "portal", Algorithm: "EdDSA", Use: "sig"}}})
	}))
	defer portal.Close()
	if err := f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: portal.URL, AdminSubjects: []string{identityTestSubject("owner")}, HTTPClient: portal.Client()}); err != nil {
		t.Fatal(err)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk := jose.JSONWebKey{Key: &key.PublicKey}
	hash, _ := jwk.Thumbprint(crypto.SHA256)
	thumb := base64.RawURLEncoding.EncodeToString(hash)
	grant := func(sub string, patch map[string]any) string {
		payload := map[string]any{"iss": portal.URL, "aud": portal.URL + "/nas", "lantern_dock": map[string]any{"protocol_version": 2}, "sub": sub, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(), "jti": randomID(), "client_id": portal.URL + "/", "scope": "account:read", "cnf": map[string]string{"jkt": thumb}}
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
	token := grant(identityTestSubject("owner"), nil)
	p := proof(token, nil)
	r := request(token, p)
	status(t, r, 200)
	body := read(t, r)
	if !strings.Contains(body, `"role":"admin"`) || strings.Contains(body, "ADMIN_SUBJECTS") {
		t.Fatal(body)
	}
	_, wrongKey, _ := ed25519.GenerateKey(rand.Reader)
	badSignature := signedJWT(t, wrongKey, jose.EdDSA, map[jose.HeaderKey]any{"kid": "portal", "typ": "at+jwt"}, map[string]any{"sub": identityTestSubject("owner")})
	for range 4 {
		status(t, request(badSignature, proof(badSignature, nil)), 401)
	}
	if keyFetches.Load() != 1 {
		t.Fatal("invalid signatures caused a JWKS refresh")
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
	for _, patch := range []map[string]any{{"aud": "other"}, {"iss": "https://attacker.example"}, {"lantern_dock": map[string]any{"protocol_version": 1}}, {"lantern_dock": nil}, {"exp": time.Now().Add(-time.Minute).Unix()}, {"exp": time.Now().Add(time.Hour).Unix()}, {"exp": nil}, {"iat": nil}, {"client_id": ""}, {"jti": ""}, {"nbf": time.Now().Add(time.Minute).Unix()}} {
		bad := grant(identityTestSubject("owner"), patch)
		status(t, request(bad, proof(bad, nil)), 401)
	}
	unscoped := grant(identityTestSubject("owner"), map[string]any{"scope": "files:write"})
	r = request(unscoped, proof(unscoped, nil))
	status(t, r, 403)
	if !strings.Contains(r.Header.Get("WWW-Authenticate"), `scope="account:read"`) {
		t.Fatal("missing scope challenge")
	}
	read(t, r)
	member := grant(identityTestSubject("member"), nil)
	r = request(member, proof(member, nil))
	status(t, r, 200)
	if !strings.Contains(read(t, r), `"role":"member"`) {
		t.Fatal("member escalated")
	}
	for _, sub := range []string{"upstream,subject", "ld_" + strings.Repeat("A", 43), "ld_" + strings.Repeat("A", 21) + "B", identityTestSubject("member") + "="} {
		bad := grant(sub, nil)
		status(t, request(bad, proof(bad, nil)), 401)
	}
	// Removing an administrator applies to the next request, including old grants.
	delete(f.s.identity.admins, identityTestSubject("owner"))
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
	if err := f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: "http://portal.example"}); err == nil {
		t.Fatal("accepted HTTP")
	}
}

func TestNASIdentityOnlyNeedsPortalConfiguration(t *testing.T) {
	f := newFixture(t)
	cfg, err := IdentityEnvironment(func(key string) string {
		if strings.HasPrefix(key, "OIDC_") {
			t.Fatal("NAS requested upstream identity configuration", key)
		}
		if key == "SITE_ORIGIN" {
			return "https://portal.example"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.ConfigureIdentity(cfg); err != nil {
		t.Fatal(err)
	}
	r := f.request(t, "GET", "/api/account/config", "", nil, nil)
	status(t, r, 200)
	body := read(t, r)
	if !strings.Contains(body, `"enabled":true`) || !strings.Contains(body, `"issuer":"https://portal.example"`) {
		t.Fatal(body)
	}
}

func TestIdentityEnvironmentCommaSeparatedSubjects(t *testing.T) {
	owner, member := identityTestSubject("owner"), identityTestSubject("member")
	for _, test := range []struct {
		name string
		raw  string
		want []string
	}{
		{"unset or empty", "", nil},
		{"whitespace only", " \t\r\n ", nil},
		{"single", owner, []string{owner}},
		{"multiple", owner + "," + member, []string{owner, member}},
		{"surrounding whitespace", " \t" + owner + " ,\n " + member + "\r\n", []string{owner, member}},
		{"duplicate is idempotent", owner + "," + owner, []string{owner, owner}},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := IdentityEnvironment(func(key string) string {
				switch key {
				case "SITE_ORIGIN":
					return "https://portal.example"
				case "NAS_RESOURCE_ORIGIN":
					return "https://nas.example"
				case "ADMIN_SUBJECTS":
					return test.raw
				}
				return ""
			})
			if err != nil || !reflect.DeepEqual(cfg.AdminSubjects, test.want) {
				t.Fatalf("subjects = %v, error = %v; want %v", cfg.AdminSubjects, err, test.want)
			}
			if cfg.SiteOrigin != "https://portal.example" || cfg.ResourceOrigin != "https://nas.example" {
				t.Fatal("origin configuration was changed")
			}
			f := newFixture(t)
			if err := f.s.ConfigureIdentity(cfg); err != nil {
				t.Fatal(err)
			}
			wantAdmins := map[string]bool{}
			for _, sub := range test.want {
				wantAdmins[sub] = true
			}
			if !reflect.DeepEqual(f.s.identity.admins, wantAdmins) {
				t.Fatalf("admins = %v; want %v", f.s.identity.admins, wantAdmins)
			}
		})
	}
}

func TestIdentityEnvironmentRejectsLegacyAndMalformedSubjects(t *testing.T) {
	owner := identityTestSubject("owner")
	for _, raw := range []string{
		`[]`, `null`, `""`, `"` + owner + `"`, `["` + owner + `"]`,
		`["` + owner + `","` + identityTestSubject("member") + `"]`,
		"ld_" + strings.Repeat("A", 43), // Legacy full SHA-256 subject.
		`{}`, `[1]`, `[""]`, `owner`, `upstream-subject`, `upstream,subject`, `true`, `123`,
		"," + owner, owner + ",", owner + ",," + owner, owner + ", \t," + owner,
		owner + ",null", owner + ",[]", owner + ";" + owner,
		"LD_" + owner[3:], owner[:24], owner + "A", owner + "=",
		"ld_" + strings.Repeat("+", 22), "ld_" + strings.Repeat("/", 22),
		"ld_" + strings.Repeat("A", 21) + "B", // Nonzero unused Base64 bits.
		"ld_" + strings.Repeat("A", 20) + " A",
		"ld_" + strings.Repeat("A", 20) + "\nA",
		"ld_" + strings.Repeat("A", 20) + "\x00A", "ld_" + strings.Repeat("é", 22),
	} {
		t.Run(raw, func(t *testing.T) {
			cfg, err := IdentityEnvironment(func(key string) string {
				if key == "SITE_ORIGIN" {
					return "https://portal.example"
				}
				if key == "ADMIN_SUBJECTS" {
					return raw
				}
				return ""
			})
			if err == nil || len(cfg.AdminSubjects) != 0 {
				t.Fatalf("malformed admin configuration did not fail closed: %#v, %v", cfg, err)
			}
			// Direct callers must not bypass validation using a single malformed
			// element, including JSON text, separators or surrounding whitespace.
			f := newFixture(t)
			if err := f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: "https://portal.example", AdminSubjects: []string{owner, raw}}); err == nil || f.s.identity != nil {
				t.Fatal("direct configuration accepted malformed admin subject")
			}
		})
	}
}

func TestIdentityAdministratorConfigurationRequiresSiteOrigin(t *testing.T) {
	for _, raw := range []string{"", " \t\n", identityTestSubject("owner")} {
		cfg, err := IdentityEnvironment(func(key string) string {
			if key == "ADMIN_SUBJECTS" {
				return raw
			}
			return ""
		})
		if (err != nil) != (strings.TrimSpace(raw) != "") {
			t.Fatalf("unexpected missing-origin result for %q: %v", raw, err)
		}
		if err == nil && len(cfg.AdminSubjects) != 0 {
			t.Fatal("empty configuration created administrators")
		}
	}
	f := newFixture(t)
	if err := f.s.ConfigureIdentity(IdentityConfig{AdminSubjects: []string{identityTestSubject("owner")}}); err == nil {
		t.Fatal("direct configuration accepted administrators without an origin")
	}
}

func TestIdentityAdministratorSubjectsAreCanonicalAndCaseSensitive(t *testing.T) {
	upper := "ld_" + strings.Repeat("A", 22)
	lower := "ld_" + strings.Repeat("a", 21) + "A"
	for _, sub := range []string{
		upper, lower, "ld_1KzSHPuTIpRkcYiSJTXRlA", "ld_-TYdm_tjfPUQRGnIAmmSNw",
		"ld_" + strings.Repeat("A", 21) + "Q", "ld_" + strings.Repeat("A", 21) + "g",
		"ld_" + strings.Repeat("_", 21) + "w", "ld_" + strings.Repeat("-", 21) + "w",
	} {
		if !validSiteSubject(sub) {
			t.Fatalf("rejected canonical subject %q", sub)
		}
	}
	f := newFixture(t)
	if err := f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: "https://portal.example", AdminSubjects: []string{upper, upper}}); err != nil {
		t.Fatal(err)
	}
	if len(f.s.identity.admins) != 1 || !f.s.identity.admins[upper] || f.s.identity.admins[lower] {
		t.Fatal("administrator matching changed case or duplicate semantics")
	}
	for _, sub := range []string{"", " " + upper, upper + " ", "\t" + upper} {
		if err := f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: "https://portal.example", AdminSubjects: []string{sub}}); err == nil {
			t.Fatal("direct configuration accepted an empty or untrimmed subject")
		}
	}
	if validSiteSubject("upstream,subject") {
		t.Fatal("accepted raw upstream subject")
	}
}
