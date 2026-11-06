package nas

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	"github.com/go-jose/go-jose/v4/jwt"
)

type IdentityConfig struct {
	SiteOrigin     string
	ResourceOrigin string
	AdminSubjects  []string
	HTTPClient     *http.Client
}
type IdentityUser struct {
	Issuer string `json:"issuer"`
	Sub    string `json:"sub"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Role   string `json:"role"`
}
type identityAuth struct {
	config                 IdentityConfig
	admins                 map[string]bool
	keys                   *rotatingKeys
	resourceOriginExplicit bool
}
type rotatingKeys struct {
	mu      sync.Mutex
	expires time.Time
	keys    oidc.KeySet
	ctx     context.Context
	uri     string
	client  *http.Client
}

var errIdentityDiscovery = errors.New("authorization server discovery failed")

func (k *rotatingKeys) VerifySignature(ctx context.Context, raw string) ([]byte, error) {
	k.mu.Lock()
	if k.keys == nil || time.Now().After(k.expires) {
		uri, err := k.discover(ctx)
		if err != nil {
			k.mu.Unlock()
			return nil, fmt.Errorf("%w: %v", errIdentityDiscovery, err)
		}
		k.keys = oidc.NewRemoteKeySet(k.ctx, uri)
		k.expires = time.Now().Add(5 * time.Minute)
	}
	keys := k.keys
	k.mu.Unlock()
	return keys.VerifySignature(ctx, raw)
}
func (k *rotatingKeys) discover(ctx context.Context) (string, error) {
	request, err := http.NewRequestWithContext(ctx, "GET", k.uri+"/.well-known/oauth-authorization-server", nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/json")
	response, err := k.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("metadata status %d", response.StatusCode)
	}
	var metadata struct {
		Issuer      string `json:"issuer"`
		JWKS        string `json:"jwks_uri"`
		LanternDock struct {
			ProtocolVersion int `json:"protocol_version"`
		} `json:"lantern_dock"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 128<<10))
	if err = decoder.Decode(&metadata); err != nil {
		return "", err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return "", fmt.Errorf("invalid metadata document")
	}
	keys, err := url.Parse(metadata.JWKS)
	issuer, _ := url.Parse(k.uri)
	// Discovery is trusted only under the explicitly configured portal origin.
	if err != nil || metadata.Issuer != k.uri || metadata.LanternDock.ProtocolVersion != 2 || keys.Scheme != "https" || keys.Host != issuer.Host || keys.User != nil || keys.RawQuery != "" || keys.Fragment != "" {
		return "", fmt.Errorf("untrusted issuer or jwks_uri")
	}
	return keys.String(), nil
}
func IdentityEnvironment(getenv func(string) string) (IdentityConfig, error) {
	cfg := IdentityConfig{SiteOrigin: getenv("SITE_ORIGIN"), ResourceOrigin: getenv("NAS_RESOURCE_ORIGIN")}
	if raw := getenv("ADMIN_SUBJECTS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &cfg.AdminSubjects); err != nil || cfg.AdminSubjects == nil {
			return cfg, fmt.Errorf("ADMIN_SUBJECTS must be a JSON array of site subject strings")
		}
	}
	if cfg.SiteOrigin == "" {
		if len(cfg.AdminSubjects) > 0 {
			return cfg, fmt.Errorf("SITE_ORIGIN is required with ADMIN_SUBJECTS")
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
	if cfg.SiteOrigin == "" {
		if len(cfg.AdminSubjects) > 0 {
			return fmt.Errorf("SITE_ORIGIN is required")
		}
		return nil
	}
	site, err := identityOrigin(cfg.SiteOrigin)
	if err != nil {
		return err
	}
	cfg.SiteOrigin = site
	resourceOriginExplicit := cfg.ResourceOrigin != ""
	if cfg.ResourceOrigin == "" {
		cfg.ResourceOrigin = site
	}
	cfg.ResourceOrigin, err = identityOrigin(cfg.ResourceOrigin)
	if err != nil {
		return fmt.Errorf("NAS_RESOURCE_ORIGIN must be an HTTPS origin")
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
	keys := &rotatingKeys{ctx: ctx, uri: site, client: client}
	if _, err = s.Store.DB.Exec(`CREATE TABLE IF NOT EXISTS identity_proofs (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS identity_proofs_expiry ON identity_proofs(expires_at);`); err != nil {
		return err
	}
	s.identity = &identityAuth{config: cfg, admins: admins, keys: keys, resourceOriginExplicit: resourceOriginExplicit}
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
	if !ok || !strings.EqualFold(scheme, "DPoP") || len(raw) > 8192 {
		return user, fault(401, "LOGIN_REQUIRED", "登录凭据无效。")
	}
	signed, err := jose.ParseSigned(raw, []jose.SignatureAlgorithm{jose.EdDSA})
	if err != nil || len(signed.Signatures) != 1 {
		return user, fault(401, "INVALID_IDENTITY", "身份凭据无效。")
	}
	header := signed.Signatures[0].Protected
	typ, _ := header.ExtraHeaders["typ"].(string)
	if (strings.ToLower(typ) != "at+jwt" && strings.ToLower(typ) != "application/at+jwt") || header.KeyID == "" || len(header.KeyID) > 128 {
		return user, fault(401, "INVALID_IDENTITY", "身份凭据类型不正确。")
	}
	payload, err := s.identity.keys.VerifySignature(r.Context(), raw)
	if err != nil {
		if errors.Is(err, errIdentityDiscovery) {
			return user, fault(503, "IDENTITY_DISCOVERY_UNAVAILABLE", "无法获取站点授权配置，请检查 NAS 到站点的 HTTPS 连接。")
		}
		return user, fault(401, "INVALID_IDENTITY", "身份凭据无效或已过期。")
	}
	var claims struct {
		jwt.Claims
		ClientID    string `json:"client_id"`
		Scope       string `json:"scope"`
		LanternDock struct {
			ProtocolVersion int `json:"protocol_version"`
		} `json:"lantern_dock"`
		Name  string `json:"name"`
		Email string `json:"email"`
		CNF   struct {
			JKT string `json:"jkt"`
		} `json:"cnf"`
	}
	if err = json.Unmarshal(payload, &claims); err != nil || claims.Issuer != s.identity.config.SiteOrigin || !claims.Audience.Contains(s.identity.config.SiteOrigin+"/nas") || claims.LanternDock.ProtocolVersion != 2 || !validSubject(claims.Subject) || claims.ClientID == "" || len(claims.ClientID) > 2048 || claims.ID == "" || len(claims.ID) > 128 || claims.CNF.JKT == "" || claims.IssuedAt == nil || claims.Expiry == nil {
		return user, fault(401, "INVALID_IDENTITY", "身份凭据不匹配。")
	}
	now := time.Now()
	issued, expires := claims.IssuedAt.Time(), claims.Expiry.Time()
	if issued.After(now.Add(5*time.Second)) || !expires.After(now) || !expires.After(issued) || expires.Sub(issued) > time.Minute || now.Sub(issued) > 65*time.Second || (claims.NotBefore != nil && claims.NotBefore.Time().After(now.Add(5*time.Second))) {
		return user, fault(401, "INVALID_IDENTITY", "身份凭据无效或已过期。")
	}
	if err = s.verifyProof(r, raw, claims.CNF.JKT); err != nil {
		return user, err
	}
	if !containsScope(claims.Scope, "account:read") {
		return user, fault(403, "INSUFFICIENT_SCOPE", "此凭据没有读取账户的权限。")
	}
	user = IdentityUser{Issuer: claims.Issuer, Sub: claims.Subject, Name: claims.Name, Email: claims.Email, Role: "member"}
	if s.identity.admins[user.Sub] {
		user.Role = "admin"
	}
	return user, nil
}
func containsScope(value, required string) bool {
	for _, scope := range strings.Split(value, " ") {
		if scope == required {
			return true
		}
	}
	return false
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
	public, ok := jwk.Key.(*ecdsa.PublicKey)
	if !ok || public.Curve != elliptic.P256() {
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
	if json.Unmarshal(payload, &proof) != nil || proof.Method != r.Method || !sameProofURI(proof.URI, s.identity.config.ResourceOrigin+r.URL.EscapedPath()) || proof.IAT < time.Now().Unix()-60 || proof.IAT > time.Now().Unix()+5 || len(proof.ID) < 16 || len(proof.ID) > 128 {
		return fail()
	}
	tokenHash := sha256.Sum256([]byte(token))
	if proof.Hash != base64.RawURLEncoding.EncodeToString(tokenHash[:]) {
		return fail()
	}
	proofHash := sha256.Sum256([]byte(thumbprint + "\x00" + proof.ID))
	key := base64.RawURLEncoding.EncodeToString(proofHash[:])
	result, err := s.Store.DB.ExecContext(r.Context(), `INSERT INTO identity_proofs(id,expires_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING`, key, time.Now().Unix()+120)
	if err != nil {
		return fault(503, "AUTH_STORAGE_UNAVAILABLE", "身份验证存储暂不可用，请稍后重试。")
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fault(503, "AUTH_STORAGE_UNAVAILABLE", "身份验证存储暂不可用，请稍后重试。")
	}
	if count != 1 {
		return fail()
	}
	_, _ = s.Store.DB.ExecContext(r.Context(), `DELETE FROM identity_proofs WHERE expires_at<?`, time.Now().Unix())
	return nil
}
func sameProofURI(proof, target string) bool {
	normalize := func(value string) string {
		u, err := url.Parse(value)
		if err != nil || !strings.EqualFold(u.Scheme, "https") || u.Host == "" || u.User != nil || strings.ContainsAny(value, "?#") {
			return ""
		}
		host := strings.ToLower(u.Host)
		if strings.HasSuffix(host, ":443") {
			host = strings.TrimSuffix(host, ":443")
		}
		path := u.EscapedPath()
		if path == "" {
			path = "/"
		}
		var normalized strings.Builder
		for i := 0; i < len(path); i++ {
			if path[i] == '%' {
				decoded, err := url.PathUnescape(path[i : i+3])
				if err != nil {
					return ""
				}
				c := decoded[0]
				if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", rune(c)) {
					normalized.WriteByte(c)
				} else {
					normalized.WriteString(strings.ToUpper(path[i : i+3]))
				}
				i += 2
			} else {
				normalized.WriteByte(path[i])
			}
		}
		return "https://" + host + normalized.String()
	}
	a, b := normalize(proof), normalize(target)
	return a != "" && a == b
}
func writeIdentityError(w http.ResponseWriter, err error) {
	var f *Fault
	if !errors.As(err, &f) {
		f = &Fault{503, "AUTH_UNAVAILABLE", "身份验证暂不可用。"}
	}
	code, description := "invalid_token", "The access token is missing, invalid or expired."
	switch f.Code {
	case "INVALID_PROOF":
		code, description = "invalid_dpop_proof", "The DPoP proof is invalid or has already been used."
	case "INSUFFICIENT_SCOPE":
		code, description = "insufficient_scope", "The account:read scope is required."
	}
	if f.Status == 503 {
		code, description = "temporarily_unavailable", "Identity verification is temporarily unavailable."
	}
	if f.Status == 401 || f.Status == 403 {
		challenge := `DPoP realm="lantern-dock", algs="ES256"`
		if f.Code != "LOGIN_REQUIRED" {
			challenge += `, error="` + code + `"`
		}
		if f.Code == "INSUFFICIENT_SCOPE" {
			challenge += `, scope="account:read"`
		}
		w.Header().Set("WWW-Authenticate", challenge)
	}
	writeJSON(w, f.Status, map[string]string{"error": code, "error_description": description, "message": f.Message, "code": f.Code})
}
func (s *Server) serveAccount(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.URL.Path == accountPath+"/config" && r.Method == "GET" {
		value := map[string]any{"enabled": s.identity != nil}
		if s.identity != nil {
			value["issuer"] = s.identity.config.SiteOrigin
			value["siteOrigin"] = s.identity.config.SiteOrigin
			value["resourceOrigin"] = s.identity.config.ResourceOrigin
		}
		writeJSON(w, 200, value)
		return
	}
	if r.URL.Path != accountPath || r.Method != "GET" {
		writeError(w, fault(404, "NOT_FOUND", "找不到这个账户接口。"))
		return
	}
	user, err := s.identityUser(r)
	if err != nil {
		writeIdentityError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"user": user, "administratorConfigured": len(s.identity.admins) > 0})
}
