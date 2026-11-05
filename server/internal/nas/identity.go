package nas

import (
	"context"
	"crypto"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
)

type IdentityConfig struct {
	SiteOrigin    string
	Issuer        string
	AdminSubjects []string
	HTTPClient    *http.Client
}
type IdentityUser struct {
	Issuer string `json:"issuer"`
	Sub    string `json:"sub"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Role   string `json:"role"`
}
type identityAuth struct {
	config   IdentityConfig
	admins   map[string]bool
	verifier *oidc.IDTokenVerifier
}
type rotatingKeys struct {
	mu      sync.Mutex
	expires time.Time
	keys    oidc.KeySet
	ctx     context.Context
	uri     string
}

func (k *rotatingKeys) VerifySignature(ctx context.Context, raw string) ([]byte, error) {
	k.mu.Lock()
	if k.keys == nil || time.Now().After(k.expires) {
		k.keys = oidc.NewRemoteKeySet(k.ctx, k.uri)
		k.expires = time.Now().Add(5 * time.Minute)
	}
	keys := k.keys
	k.mu.Unlock()
	return keys.VerifySignature(ctx, raw)
}
func IdentityEnvironment(getenv func(string) string) (IdentityConfig, error) {
	cfg := IdentityConfig{SiteOrigin: getenv("SITE_ORIGIN"), Issuer: getenv("OIDC_ISSUER_URL")}
	if raw := getenv("ADMIN_SUBJECTS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &cfg.AdminSubjects); err != nil || cfg.AdminSubjects == nil {
			return cfg, fmt.Errorf("ADMIN_SUBJECTS must be a JSON array of OIDC sub strings")
		}
	}
	if cfg.Issuer == "" {
		if len(cfg.AdminSubjects) > 0 {
			return cfg, fmt.Errorf("OIDC_ISSUER_URL is required with ADMIN_SUBJECTS")
		}
		return cfg, nil
	}
	return cfg, nil
}
func identityOrigin(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("SITE_ORIGIN must be an HTTPS origin")
	}
	return u.Scheme + "://" + u.Host, nil
}
func validSubject(sub string) bool {
	if len(sub) == 0 || len(sub) > 255 {
		return false
	}
	for _, b := range []byte(sub) {
		if b < 0x20 || b > 0x7e {
			return false
		}
	}
	return true
}

type limitedTransport struct{ base http.RoundTripper }
type limitedBody struct {
	io.Reader
	io.Closer
}

func (t limitedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "https" {
		return nil, fmt.Errorf("identity keys require HTTPS")
	}
	response, err := t.base.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	response.Body = limitedBody{io.LimitReader(response.Body, 128<<10), response.Body}
	return response, nil
}
func identityClient() (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if certFile := os.Getenv("SSL_CERT_FILE"); certFile != "" {
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		data, err := os.ReadFile(certFile)
		if err != nil {
			return nil, fmt.Errorf("cannot read SSL_CERT_FILE")
		}
		if !roots.AppendCertsFromPEM(data) {
			return nil, fmt.Errorf("SSL_CERT_FILE contains no certificates")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	return &http.Client{Transport: limitedTransport{transport}, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}
func (s *Server) ConfigureIdentity(cfg IdentityConfig) error {
	if cfg.Issuer == "" {
		if len(cfg.AdminSubjects) > 0 {
			return fmt.Errorf("OIDC_ISSUER_URL is required")
		}
		return nil
	}
	site, err := identityOrigin(cfg.SiteOrigin)
	if err != nil {
		return err
	}
	cfg.SiteOrigin = site
	issuer, err := url.Parse(cfg.Issuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" || issuer.User != nil || issuer.RawQuery != "" || issuer.Fragment != "" {
		return fmt.Errorf("OIDC_ISSUER_URL must be an HTTPS issuer URL")
	}
	admins := map[string]bool{}
	for _, sub := range cfg.AdminSubjects {
		if !validSubject(sub) {
			return fmt.Errorf("ADMIN_SUBJECTS contains an invalid sub")
		}
		admins[sub] = true
	}
	client := cfg.HTTPClient
	if client == nil {
		client, err = identityClient()
		if err != nil {
			return err
		}
	}
	ctx := oidc.ClientContext(s.ctx, client)
	keys := &rotatingKeys{ctx: ctx, uri: site + "/api/auth/jwks.json"}
	verifier := oidc.NewVerifier(site, keys, &oidc.Config{ClientID: site + "/nas", SupportedSigningAlgs: []string{"EdDSA"}})
	if _, err = s.Store.DB.Exec(`CREATE TABLE IF NOT EXISTS identity_proofs (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS identity_proofs_expiry ON identity_proofs(expires_at);`); err != nil {
		return err
	}
	s.identity = &identityAuth{config: cfg, admins: admins, verifier: verifier}
	s.origins[site] = true
	return nil
}
func (s *Server) identityUser(r *http.Request) (IdentityUser, error) {
	var user IdentityUser
	if s.identity == nil {
		return user, fault(503, "IDENTITY_DISABLED", "NAS 尚未配置身份验证。")
	}
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return user, fault(401, "LOGIN_REQUIRED", "请先登录。")
	}
	scheme, raw, ok := strings.Cut(values[0], " ")
	if !ok || scheme != "DPoP" || len(raw) > 8192 {
		return user, fault(401, "LOGIN_REQUIRED", "登录凭据无效。")
	}
	identity, err := s.identity.verifier.Verify(r.Context(), raw)
	if err != nil {
		return user, fault(401, "INVALID_IDENTITY", "身份凭据无效或已过期。")
	}
	var claims struct {
		IdentityIssuer string `json:"identity_issuer"`
		Name           string `json:"name"`
		Email          string `json:"email"`
		CNF            struct {
			JKT string `json:"jkt"`
		} `json:"cnf"`
	}
	if err = identity.Claims(&claims); err != nil || claims.IdentityIssuer != s.identity.config.Issuer || !validSubject(identity.Subject) || claims.CNF.JKT == "" || identity.IssuedAt.After(time.Now().Add(5*time.Second)) || identity.Expiry.Sub(identity.IssuedAt) > time.Minute || time.Since(identity.IssuedAt) > 65*time.Second {
		return user, fault(401, "INVALID_IDENTITY", "身份凭据不匹配。")
	}
	if err = s.verifyProof(r, raw, claims.CNF.JKT); err != nil {
		return user, err
	}
	user = IdentityUser{Issuer: claims.IdentityIssuer, Sub: identity.Subject, Name: claims.Name, Email: claims.Email, Role: "member"}
	if s.identity.admins[user.Sub] {
		user.Role = "admin"
	}
	return user, nil
}
func (s *Server) verifyProof(r *http.Request, token, thumbprint string) error {
	fail := func() error {
		return fault(401, "INVALID_PROOF", "无法验证请求的持有证明，请重新登录。")
	}
	values := r.Header.Values("DPoP")
	if len(values) != 1 || len(values[0]) > 8192 {
		return fail()
	}
	signed, err := jose.ParseSigned(values[0], []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(signed.Signatures) != 1 {
		return fail()
	}
	header := signed.Signatures[0].Protected
	jwk := header.JSONWebKey
	if header.ExtraHeaders["typ"] != "dpop+jwt" || jwk == nil || !jwk.IsPublic() || !jwk.Valid() {
		return fail()
	}
	hash, err := jwk.Thumbprint(crypto.SHA256)
	if err != nil || base64.RawURLEncoding.EncodeToString(hash) != thumbprint {
		return fail()
	}
	payload, err := signed.Verify(jwk.Key)
	if err != nil {
		return fail()
	}
	var proof struct {
		Method string `json:"htm"`
		URI    string `json:"htu"`
		IAT    int64  `json:"iat"`
		ID     string `json:"jti"`
		Hash   string `json:"ath"`
	}
	if json.Unmarshal(payload, &proof) != nil || proof.Method != r.Method || proof.URI != s.identity.config.SiteOrigin+r.URL.EscapedPath() || proof.IAT < time.Now().Unix()-60 || proof.IAT > time.Now().Unix()+5 || len(proof.ID) < 16 || len(proof.ID) > 128 {
		return fail()
	}
	tokenHash := sha256.Sum256([]byte(token))
	if proof.Hash != base64.RawURLEncoding.EncodeToString(tokenHash[:]) {
		return fail()
	}
	proofHash := sha256.Sum256([]byte(thumbprint + "\x00" + proof.ID))
	key := base64.RawURLEncoding.EncodeToString(proofHash[:])
	_, err = s.Store.DB.ExecContext(r.Context(), `INSERT INTO identity_proofs(id,expires_at) VALUES(?,?)`, key, time.Now().Unix()+120)
	if err != nil {
		return fail()
	}
	_, _ = s.Store.DB.ExecContext(r.Context(), `DELETE FROM identity_proofs WHERE expires_at<?`, time.Now().Unix())
	return nil
}
func (s *Server) serveAccount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("WWW-Authenticate", `DPoP realm="lantern-dock"`)
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.URL.Path == "/api/account/config" && r.Method == "GET" {
		value := map[string]any{"enabled": s.identity != nil}
		if s.identity != nil {
			value["issuer"] = s.identity.config.Issuer
			value["siteOrigin"] = s.identity.config.SiteOrigin
		}
		writeJSON(w, 200, value)
		return
	}
	if r.URL.Path != "/api/account" || r.Method != "GET" {
		writeError(w, fault(404, "NOT_FOUND", "找不到这个账户接口。"))
		return
	}
	user, err := s.identityUser(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"user": user, "administratorConfigured": len(s.identity.admins) > 0})
}
