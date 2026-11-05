package nas

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

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
func TestIdentityProofAndLocalAdministrator(t *testing.T) {
	f := newFixture(t)
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	var keyFetches atomic.Int64
	portal := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keyFetches.Add(1)
		if r.URL.Path != "/api/auth/jwks.json" {
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
		payload := map[string]any{"iss": portal.URL, "aud": portal.URL + "/nas", "identity_issuer": "https://sso.example", "sub": sub, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(), "cnf": map[string]string{"jkt": thumb}}
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
	status(t, request(token, p), 401)
	for _, patch := range []map[string]any{{"htm": "POST"}, {"htu": portal.URL + "/dav/"}, {"ath": "wrong"}, {"iat": time.Now().Add(-2 * time.Minute).Unix()}} {
		status(t, request(token, proof(token, patch)), 401)
	}
	for _, patch := range []map[string]any{{"aud": "other"}, {"iss": "https://attacker.example"}, {"identity_issuer": "https://other-sso.example"}, {"exp": time.Now().Add(-time.Minute).Unix()}, {"exp": time.Now().Add(time.Hour).Unix()}} {
		bad := grant("owner", patch)
		status(t, request(bad, proof(bad, nil)), 401)
	}
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
	if keyFetches.Load() != 1 {
		t.Fatalf("verification was not local: %d fetches", keyFetches.Load())
	}
	status(t, f.request(t, "GET", "/api/account", "", nil, map[string]string{"Authorization": "Bearer " + token, "DPoP": proof(token, nil)}), 401)
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
