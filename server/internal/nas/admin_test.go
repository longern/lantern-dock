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
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

type adminFixture struct {
	*fixture
	portal  *httptest.Server
	private ed25519.PrivateKey
	key     *ecdsa.PrivateKey
	jwk     jose.JSONWebKey
	thumb   string
}

func newAdminFixture(t *testing.T, resource string) *adminFixture {
	t.Helper()
	f := &adminFixture{fixture: newFixture(t)}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.private = private
	f.portal = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/oauth-authorization-server" {
			json.NewEncoder(w).Encode(map[string]any{"issuer": f.portal.URL, "jwks_uri": f.portal.URL + "/keys", "lantern_dock": map[string]any{"protocol_version": 2}})
			return
		}
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: public, KeyID: "admin-test", Algorithm: "EdDSA", Use: "sig"}}})
	}))
	t.Cleanup(f.portal.Close)
	if err = f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: f.portal.URL, ResourceOrigin: resource, AdminSubjects: []string{identityTestSubject("owner")}, HTTPClient: f.portal.Client()}); err != nil {
		t.Fatal(err)
	}
	f.key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.jwk = jose.JSONWebKey{Key: &f.key.PublicKey}
	hash, _ := f.jwk.Thumbprint(crypto.SHA256)
	f.thumb = base64.RawURLEncoding.EncodeToString(hash)
	return f
}
func (f *adminFixture) headers(t *testing.T, method, target, sub, scope string) map[string]string {
	t.Helper()
	token := signedJWT(t, f.private, jose.EdDSA, map[jose.HeaderKey]any{"kid": "admin-test", "typ": "at+jwt"}, map[string]any{"iss": f.portal.URL, "aud": f.portal.URL + "/nas", "sub": identityTestSubject(sub), "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(), "jti": randomID(), "client_id": f.portal.URL + "/", "scope": scope, "role": "admin", "cnf": map[string]string{"jkt": f.thumb}, "lantern_dock": map[string]int{"protocol_version": 2}})
	hash := sha256.Sum256([]byte(token))
	u, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	proof := signedJWT(t, f.key, jose.ES256, map[jose.HeaderKey]any{"typ": "dpop+jwt", "jwk": f.jwk}, map[string]any{"htm": method, "htu": f.s.identity.config.ResourceOrigin + u.EscapedPath(), "iat": time.Now().Unix(), "jti": randomID(), "ath": base64.RawURLEncoding.EncodeToString(hash[:])})
	return map[string]string{"Authorization": "DPoP " + token, "DPoP": proof, "Content-Type": "application/json"}
}
func (f *adminFixture) admin(t *testing.T, method, target, scope, body string) *http.Response {
	t.Helper()
	return f.request(t, method, target, "", strings.NewReader(body), f.headers(t, method, target, "owner", scope))
}
func validLinkInput() string {
	body, _ := json.Marshal(map[string]any{"title": "Photos", "expiresAt": time.Now().Add(time.Hour).UTC(), "maxFileBytes": 10, "maxTotalBytes": 20, "maxFiles": 3})
	return string(body)
}
func (f *adminFixture) createLink(t *testing.T) (Link, string) {
	t.Helper()
	r := f.admin(t, "POST", adminPath+"/links", linksWriteScope, validLinkInput())
	status(t, r, 201)
	var result struct {
		Link  Link   `json:"link"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if !validID(result.Link.ID) || len(result.Token) != 43 {
		t.Fatalf("bad created link: %+v", result.Link)
	}
	return result.Link, result.Token
}
func decodeResponse[T any](t *testing.T, r *http.Response) T {
	t.Helper()
	var result T
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	return result
}
func TestAdminRequiresBothLocalRoleAndOperationScope(t *testing.T) {
	f := newAdminFixture(t, "")
	link, token := f.link(t, 10, 20, 2)
	for _, operation := range []struct{ method, path, scope string }{
		{"GET", adminPath + "/links", linksReadScope},
		{"POST", adminPath + "/links", linksWriteScope},
		{"DELETE", adminPath + "/links/" + link.ID, linksWriteScope},
		{"GET", adminPath + "/inbox", inboxReadScope},
		{"GET", adminPath + "/inbox/" + randomID() + "/download", inboxReadScope},
	} {
		t.Run(operation.method+operation.path, func(t *testing.T) {
			status(t, f.request(t, operation.method, operation.path, "", strings.NewReader(validLinkInput()), nil), 401)
			status(t, f.request(t, operation.method, operation.path, token, strings.NewReader(validLinkInput()), nil), 401)
			for _, scope := range []string{"account:read", "links:write-extra", ""} {
				r := f.admin(t, operation.method, operation.path, scope, validLinkInput())
				status(t, r, 403)
				if !strings.Contains(r.Header.Get("WWW-Authenticate"), `scope="`+operation.scope+`"`) || !strings.Contains(read(t, r), `"error":"insufficient_scope"`) {
					t.Fatal("wrong scope challenge")
				}
			}
			for _, otherScope := range []string{linksReadScope, linksWriteScope, inboxReadScope} {
				if otherScope != operation.scope {
					status(t, f.admin(t, operation.method, operation.path, otherScope, validLinkInput()), 403)
				}
			}
			r := f.request(t, operation.method, operation.path, "", strings.NewReader(validLinkInput()), f.headers(t, operation.method, operation.path, "member", operation.scope))
			status(t, r, 403)
			if !strings.Contains(read(t, r), `"code":"ADMIN_REQUIRED"`) {
				t.Fatal("token role was trusted")
			}
		})
	}
	links, err := f.s.Store.ListLinks(context.Background())
	if err != nil || len(links) != 1 || links[0].Revoked {
		t.Fatal("unauthorized requests mutated links", err)
	}
	r := f.admin(t, "GET", accountPath, "account:read", "")
	status(t, r, 200)
	if !strings.Contains(read(t, r), `"capabilities":{"adminInbox":true,"adminLinks":true}`) {
		t.Fatal("missing admin capability")
	}
	delete(f.s.identity.admins, identityTestSubject("owner"))
	status(t, f.admin(t, "GET", adminPath+"/links", linksReadScope, ""), 403)
	r = f.admin(t, "GET", accountPath, "account:read", "")
	if !strings.Contains(read(t, r), `"adminLinks":false`) {
		t.Fatal("stale capability")
	}
}
func TestAdminLinkCreateListRevokeAndOneTimeSecret(t *testing.T) {
	f := newAdminFixture(t, "")
	link, token := f.createLink(t)
	u := f.reserve(t, token, "private.txt", 5)
	r := f.admin(t, "GET", adminPath+"/links", linksReadScope, "")
	status(t, r, 200)
	body := read(t, r)
	if strings.Contains(body, token) || strings.Contains(body, "token") || strings.Contains(body, "private.txt") || strings.Contains(body, f.data) {
		t.Fatal("list disclosed a secret or private path")
	}
	var listed struct {
		Links []Link `json:"links"`
		Next  *int   `json:"nextOffset"`
	}
	if json.Unmarshal([]byte(body), &listed) != nil || len(listed.Links) != 1 || listed.Links[0].UsedBytes != 5 || listed.Links[0].UsedFiles != 1 || listed.Next != nil {
		t.Fatal("wrong link usage", body)
	}
	var hash []byte
	if err := f.s.Store.DB.QueryRow(`SELECT token_hash FROM links WHERE id=?`, link.ID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	expected := sha256.Sum256([]byte(token))
	if string(hash) != string(expected[:]) {
		t.Fatal("token not hashed")
	}
	status(t, f.admin(t, "DELETE", adminPath+"/links/"+link.ID, linksWriteScope, ""), 204)
	status(t, f.admin(t, "DELETE", adminPath+"/links/"+link.ID, linksWriteScope, ""), 204)
	status(t, f.request(t, "POST", inboxPath, token, strings.NewReader(`{"name":"late.txt","size":1}`), nil), 410)
	status(t, f.request(t, "PUT", inboxPath+"/"+u.ID, token, strings.NewReader("hello"), nil), 410)
	status(t, f.admin(t, "DELETE", adminPath+"/links/"+randomID(), linksWriteScope, ""), 404)
	r = f.admin(t, "GET", adminPath+"/links", linksReadScope, "")
	if !strings.Contains(read(t, r), `"revoked":true`) {
		t.Fatal("revocation not persisted")
	}
}
func TestAdminCreateValidationAndPagination(t *testing.T) {
	f := newAdminFixture(t, "")
	for _, body := range []string{"", `null`, `[]`, `{}`, validLinkInput() + ` {}`, strings.Replace(validLinkInput(), `"maxFiles":3`, `"maxFiles":0`, 1), strings.Replace(validLinkInput(), `"maxTotalBytes":20`, `"maxTotalBytes":5`, 1), strings.Replace(validLinkInput(), `"title":"Photos"`, `"title":" "`, 1), strings.Replace(validLinkInput(), `"title":"Photos"`, `"title":"a\nb"`, 1), strings.Replace(validLinkInput(), `"title":"Photos"`, `"title":"`+strings.Repeat("a", 201)+`"`, 1), strings.Replace(validLinkInput(), `"maxFiles":3`, `"maxFiles":9007199254740992`, 1), strings.Replace(validLinkInput(), `"maxFiles":3`, `"maxFiles":1.2`, 1), strings.Replace(validLinkInput(), `"maxFiles":3`, `"maxFiles":3,"revoked":true`, 1), strings.Repeat(" ", 4097) + validLinkInput()} {
		status(t, f.admin(t, "POST", adminPath+"/links", linksWriteScope, body), 400)
	}
	headers := f.headers(t, "POST", adminPath+"/links", "owner", linksWriteScope)
	delete(headers, "Content-Type")
	status(t, f.request(t, "POST", adminPath+"/links", "", strings.NewReader(validLinkInput()), headers), 415)
	var expired map[string]any
	if err := json.Unmarshal([]byte(validLinkInput()), &expired); err != nil {
		t.Fatal(err)
	}
	expired["expiresAt"] = time.Now().Add(-time.Hour).UTC()
	expiredBody, _ := json.Marshal(expired)
	status(t, f.admin(t, "POST", adminPath+"/links", linksWriteScope, string(expiredBody)), 400)
	links, err := f.s.Store.ListLinks(context.Background())
	if err != nil || len(links) != 0 {
		t.Fatal("invalid creation persisted", err)
	}
	for i := 0; i < 3; i++ {
		f.createLink(t)
	}
	var ids []string
	for offset := 0; offset < 3; offset++ {
		r := f.admin(t, "GET", adminPath+"/links?limit=1&offset="+string(rune('0'+offset)), linksReadScope, "")
		status(t, r, 200)
		result := decodeResponse[struct {
			Links []Link `json:"links"`
			Next  *int   `json:"nextOffset"`
		}](t, r)
		if len(result.Links) != 1 || (offset < 2 && (result.Next == nil || *result.Next != offset+1)) || (offset == 2 && result.Next != nil) {
			t.Fatal("bad page", result)
		}
		ids = append(ids, result.Links[0].ID)
	}
	if ids[0] == ids[1] || ids[0] == ids[2] || ids[1] == ids[2] {
		t.Fatal("duplicate pagination rows")
	}
	for _, query := range []string{"limit=0", "limit=201", "limit=abc", "offset=-1", "offset=9007199254740992", "limit=1&limit=2", "other=1", "linkId=nope", "limit=1;other=2", "limit=%zz"} {
		status(t, f.admin(t, "GET", adminPath+"/links?"+query, linksReadScope, ""), 400)
	}
}
func TestAdminInboxIsPrivateCompletedAndDownloadableAfterRevocation(t *testing.T) {
	f := newAdminFixture(t, "https://nas.example")
	link, token := f.createLink(t)
	file := f.reserve(t, token, "照片.txt", 5)
	pending := f.reserve(t, token, "pending.txt", 2)
	status(t, f.request(t, "PUT", inboxPath+"/"+file.ID, token, strings.NewReader("hello"), nil), 201)
	other, otherToken := f.createLink(t)
	otherFile := f.reserve(t, otherToken, "other.txt", 5)
	status(t, f.request(t, "PUT", inboxPath+"/"+otherFile.ID, otherToken, strings.NewReader("other"), nil), 201)
	r := f.admin(t, "GET", adminPath+"/inbox?linkId="+link.ID, inboxReadScope, "")
	status(t, r, 200)
	result := decodeResponse[struct {
		Uploads []inboxFile `json:"uploads"`
		Next    *int        `json:"nextOffset"`
	}](t, r)
	if len(result.Uploads) != 1 || result.Uploads[0].ID != file.ID || result.Uploads[0].LinkID != link.ID || result.Uploads[0].Name != "照片.txt" || result.Uploads[0].CreatedAt.IsZero() || result.Next != nil {
		t.Fatal("bad private listing", result)
	}
	r = f.admin(t, "GET", adminPath+"/inbox?limit=1", inboxReadScope, "")
	status(t, r, 200)
	if !strings.Contains(read(t, r), `"nextOffset":1`) {
		t.Fatal("inbox not paged")
	}
	status(t, f.admin(t, "GET", adminPath+"/inbox?linkId=../", inboxReadScope, ""), 400)
	status(t, f.admin(t, "GET", adminPath+"/inbox/"+pending.ID+"/download", inboxReadScope, ""), 404)
	status(t, f.admin(t, "DELETE", adminPath+"/links/"+link.ID, linksWriteScope, ""), 204)
	target := adminPath + "/inbox/" + file.ID + "/download"
	for _, method := range []string{"GET", "HEAD"} {
		r = f.admin(t, method, target, inboxReadScope, "")
		status(t, r, 200)
		_, params, err := mime.ParseMediaType(r.Header.Get("Content-Disposition"))
		if err != nil || params["filename"] != "照片.txt" || r.Header.Get("Content-Type") != "application/octet-stream" || r.Header.Get("Cache-Control") != "no-store" || r.ContentLength != 5 {
			t.Fatal("unsafe download headers", r.Header)
		}
		body := read(t, r)
		if method == "GET" && body != "hello" || method == "HEAD" && body != "" {
			t.Fatal("wrong content", body)
		}
	}
	headers := f.headers(t, "GET", target, "owner", inboxReadScope)
	headers["Range"] = "bytes=1-3"
	r = f.request(t, "GET", target, "", nil, headers)
	status(t, r, 206)
	if read(t, r) != "ell" || r.Header.Get("Content-Range") != "bytes 1-3/5" {
		t.Fatal("invalid range")
	}
	headers = f.headers(t, "GET", target, "owner", inboxReadScope)
	headers["Range"] = "bytes=99-100"
	r = f.request(t, "GET", target, "", nil, headers)
	status(t, r, 416)
	if r.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("private range error may be cached")
	}
	status(t, f.request(t, "GET", target, token, nil, nil), 401)
	status(t, f.request(t, "GET", inboxPath+"/"+otherFile.ID+"/download", otherToken, nil, nil), 404)
	status(t, f.request(t, "GET", "/dav/inbox/"+other.ID+"/"+otherFile.ID+"-other.txt", "", nil, nil), 404)
	for _, bad := range []string{"../lantern-dock.sqlite", file.ID + "/other", "%2e%2e"} {
		r = f.admin(t, "GET", adminPath+"/inbox/"+bad+"/download", inboxReadScope, "")
		if r.StatusCode < 400 {
			t.Fatal("invalid path accepted")
		}
	}
}
func TestAdminDownloadRejectsSymlinksAndChangedFiles(t *testing.T) {
	for _, kind := range []string{"file", "directory", "outside", "staging", "size", "nonregular"} {
		t.Run(kind, func(t *testing.T) {
			f := newAdminFixture(t, "")
			link, token := f.createLink(t)
			u := f.reserve(t, token, "file.txt", 5)
			status(t, f.request(t, "PUT", inboxPath+"/"+u.ID, token, strings.NewReader("hello"), nil), 201)
			name := filepath.Join(f.data, "inbox", link.ID, u.ID+"-file.txt")
			if err := os.Remove(name); err != nil {
				t.Fatal(err)
			}
			var err error
			switch kind {
			case "file":
				err = os.Symlink(filepath.Join(f.data, "lantern-dock.sqlite"), name)
			case "outside":
				err = os.Symlink("/etc/passwd", name)
			case "staging":
				secret := filepath.Join(f.data, "inbox", ".staging", "private")
				if err = os.WriteFile(secret, []byte("hello"), 0600); err == nil {
					err = os.Symlink(secret, name)
				}
			case "size":
				err = os.WriteFile(name, []byte("changed"), 0600)
			case "nonregular":
				err = os.Mkdir(name, 0700)
			case "directory":
				dir := filepath.Dir(name)
				if err = os.Rename(dir, dir+"-moved"); err == nil {
					err = os.Symlink(dir+"-moved", dir)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			status(t, f.admin(t, "GET", adminPath+"/inbox/"+u.ID+"/download", inboxReadScope, ""), 404)
		})
	}
}
func TestAdminProofReplayMethodCORSAndStorageErrors(t *testing.T) {
	f := newAdminFixture(t, "https://nas.example")
	target := adminPath + "/links"
	headers := f.headers(t, "GET", target, "owner", linksReadScope)
	status(t, f.request(t, "GET", target, "", nil, headers), 200)
	status(t, f.request(t, "GET", target, "", nil, headers), 401)
	for _, method := range []string{"PUT", "HEAD", "PROPFIND"} {
		status(t, f.admin(t, method, target, linksWriteScope, ""), 405)
	}
	headers = f.headers(t, "POST", target, "owner", linksWriteScope)
	status(t, f.request(t, "GET", target, "", nil, headers), 401)
	for _, origin := range []string{f.portal.URL, "https://untrusted.example"} {
		r := f.request(t, "OPTIONS", target, "", nil, map[string]string{"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization, DPoP, Content-Type, Range"})
		if origin == f.portal.URL {
			status(t, r, 204)
			if r.Header.Get("Access-Control-Allow-Origin") != origin || !strings.Contains(r.Header.Get("Access-Control-Allow-Headers"), "Range") || !strings.Contains(r.Header.Get("Access-Control-Expose-Headers"), "Content-Disposition") {
				t.Fatal("incomplete CORS", r.Header)
			}
		} else {
			status(t, r, 403)
		}
	}
	// DPoP targets use the configured external HTTPS origin, never Host headers.
	old := f.s.identity.config.ResourceOrigin
	f.s.identity.config.ResourceOrigin = f.portal.URL
	headers = f.headers(t, "GET", target, "owner", linksReadScope)
	f.s.identity.config.ResourceOrigin = old
	status(t, f.request(t, "GET", target, "", nil, headers), 401)
	f.s.Store.DB.Close()
	r := f.admin(t, "GET", target, linksReadScope, "")
	status(t, r, 503)
	body, _ := io.ReadAll(r.Body)
	if strings.Contains(string(body), f.data) || strings.Contains(string(body), "database") {
		t.Fatal("storage details leaked")
	}
}
