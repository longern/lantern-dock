package nas

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const fixtureSecret = "test-only-nas-secret-0123456789abcdef"

type fixture struct {
	s            *Server
	http         *httptest.Server
	public, data string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	f := &fixture{public: filepath.Join(root, "public"), data: filepath.Join(root, "data")}
	var err error
	f.s, err = New(f.public, f.data, []string{"https://portal.example"}, WithSecretKey(fixtureSecret))
	if err != nil {
		t.Fatal(err)
	}
	f.http = httptest.NewServer(f.s)
	t.Cleanup(func() { f.http.Close(); f.s.Close() })
	return f
}
func (f *fixture) link(t *testing.T, size, total, count int64) (Link, string) {
	t.Helper()
	l, token, err := f.s.Store.CreateLink(context.Background(), Link{Title: "收照片", ExpiresAt: time.Now().Add(time.Hour), MaxFileBytes: size, MaxTotalBytes: total, MaxFiles: count})
	if err != nil {
		t.Fatal(err)
	}
	return l, token
}
func (f *fixture) request(t *testing.T, method, path, token string, body io.Reader, headers map[string]string) *http.Response {
	t.Helper()
	r, err := http.NewRequest(method, f.http.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	resp, err := f.http.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}
func read(t *testing.T, r *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(r.Body)
	r.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func status(t *testing.T, r *http.Response, want int) {
	t.Helper()
	if r.StatusCode != want {
		t.Fatalf("status=%d want=%d body=%s", r.StatusCode, want, read(t, r))
	}
}
func (f *fixture) reserve(t *testing.T, token, name string, size int64) Upload {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"name": name, "size": size})
	r := f.request(t, "POST", "/api/uploads", token, bytes.NewReader(body), nil)
	status(t, r, 201)
	var u Upload
	if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	return u
}
func TestPublicDAVIsReadOnlyAndConfined(t *testing.T) {
	f := newFixture(t)
	data := "hello 中文"
	if err := os.WriteFile(filepath.Join(f.public, "你好.txt"), []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(f.data, "private.txt")
	os.WriteFile(secret, []byte("TOP-SECRET"), 0600)
	os.Symlink(secret, filepath.Join(f.public, "escape.txt"))
	r := f.request(t, "PROPFIND", "/dav/", "", strings.NewReader(`<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>`), map[string]string{"Depth": "1"})
	status(t, r, 207)
	xml := read(t, r)
	if !strings.Contains(xml, "%E4%BD%A0%E5%A5%BD.txt") || strings.Contains(xml, "TOP-SECRET") {
		t.Fatal(xml)
	}
	r = f.request(t, "GET", "/dav/%E4%BD%A0%E5%A5%BD.txt", "", nil, nil)
	status(t, r, 200)
	if read(t, r) != data {
		t.Fatal("wrong file")
	}
	r = f.request(t, "GET", "/dav/%E4%BD%A0%E5%A5%BD.txt", "", nil, map[string]string{"Range": "bytes=0-4"})
	status(t, r, 206)
	if read(t, r) != "hello" {
		t.Fatal("range lost")
	}
	r = f.request(t, "HEAD", "/dav/%E4%BD%A0%E5%A5%BD.txt", "", nil, nil)
	status(t, r, 200)
	if r.ContentLength != int64(len(data)) || read(t, r) != "" {
		t.Fatal("bad HEAD")
	}
	for _, method := range []string{"PUT", "DELETE", "MKCOL", "MOVE", "COPY", "PROPPATCH", "LOCK", "UNLOCK"} {
		status(t, f.request(t, method, "/dav/你好.txt", "", nil, nil), 405)
	}
	for _, p := range []string{"/dav/escape.txt", "/dav/%2e%2e/data/private.txt"} {
		r = f.request(t, "GET", p, "", nil, nil)
		if r.StatusCode < 400 || strings.Contains(read(t, r), "TOP-SECRET") {
			t.Fatal("escaped root")
		}
	}
	status(t, f.request(t, "PROPFIND", "/dav/", "", nil, map[string]string{"Depth": "infinity"}), 403)
	r = f.request(t, "OPTIONS", "/dav/", "", nil, nil)
	status(t, r, 204)
	if strings.Contains(r.Header.Get("Allow"), "PUT") {
		t.Fatal("advertised writes")
	}
}
func TestReceiveAndScope(t *testing.T) {
	f := newFixture(t)
	l, token := f.link(t, 100, 200, 2)
	_, other := f.link(t, 100, 200, 2)
	status(t, f.request(t, "GET", "/api/uploads", "", nil, nil), 401)
	u := f.reserve(t, token, "照片.txt", 5)
	status(t, f.request(t, "GET", "/api/uploads/"+u.ID, other, nil, nil), 404)
	r := f.request(t, "PUT", "/api/uploads/"+u.ID, token, strings.NewReader("hello"), nil)
	status(t, r, 201)
	contents, err := os.ReadFile(filepath.Join(f.data, "inbox", l.ID, u.ID+"-照片.txt"))
	if err != nil || string(contents) != "hello" {
		t.Fatalf("not durable: %s %v", contents, err)
	}
	status(t, f.request(t, "PUT", "/api/uploads/"+u.ID, token, strings.NewReader("again"), nil), 409)
	status(t, f.request(t, "DELETE", "/api/uploads/"+u.ID, token, nil, nil), 409)
	status(t, f.request(t, "GET", "/dav/inbox/"+l.ID+"/"+u.ID+"-照片.txt", "", nil, nil), 404)
	status(t, f.request(t, "GET", "/api/uploads/"+u.ID+"/content", token, nil, nil), 404)
	info := f.request(t, "GET", "/api/uploads", token, nil, nil)
	text := read(t, info)
	if strings.Contains(text, "照片.txt") || strings.Contains(text, "inbox") {
		t.Fatal("listed private contents")
	}
	if err = f.s.Store.Usage(context.Background(), &l); err != nil || l.UsedBytes != 5 || l.UsedFiles != 1 {
		t.Fatalf("bad usage: %+v %v", l, err)
	}
}
func TestQuotaReservationsAreAtomicAndReleased(t *testing.T) {
	f := newFixture(t)
	l, token := f.link(t, 10, 10, 2)
	var wg sync.WaitGroup
	results := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Go(func() { _, err := f.s.Store.Reserve(context.Background(), l.ID, "file", 6); results <- err })
	}
	wg.Wait()
	close(results)
	ok := 0
	for err := range results {
		if err == nil {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("%d reservations bypassed quota", ok)
	}
	rows, err := f.s.Store.DB.Query(`SELECT id FROM uploads WHERE status='pending'`)
	if err != nil {
		t.Fatal(err)
	}
	var id string
	for rows.Next() {
		rows.Scan(&id)
	}
	rows.Close()
	status(t, f.request(t, "DELETE", "/api/uploads/"+id, token, nil, nil), 204)
	u := f.reserve(t, token, "next", 6)
	status(t, f.request(t, "PUT", "/api/uploads/"+u.ID, token, strings.NewReader("x"), nil), 400)
	// A rejected length does not consume a task: the client can cancel its reservation.
	status(t, f.request(t, "DELETE", "/api/uploads/"+u.ID, token, nil, nil), 204)
	u = f.reserve(t, token, "last", 10)
	status(t, f.request(t, "PUT", "/api/uploads/"+u.ID, token, strings.NewReader("0123456789"), nil), 201)
	if err = f.s.Store.Usage(context.Background(), &l); err != nil || l.UsedBytes != 10 {
		t.Fatalf("quota accounting: %+v %v", l, err)
	}
}
func TestExpiryRevocationAndCancellation(t *testing.T) {
	f := newFixture(t)
	l, token := f.link(t, 100, 100, 1)
	u := f.reserve(t, token, "pending", 50)
	status(t, f.request(t, "DELETE", "/api/uploads/"+u.ID, token, nil, nil), 204)
	status(t, f.request(t, "PUT", "/api/uploads/"+u.ID, token, strings.NewReader(strings.Repeat("x", 50)), nil), 409)
	u = f.reserve(t, token, "expired", 50)
	f.s.Store.DB.Exec(`UPDATE uploads SET expires_at=? WHERE id=?`, time.Now().Unix()-1, u.ID)
	f.reserve(t, token, "replacement", 50)
	f.s.Store.DB.Exec(`UPDATE links SET expires_at=? WHERE id=?`, time.Now().Unix()-1, l.ID)
	status(t, f.request(t, "GET", "/api/uploads", token, nil, nil), 410)
	l, token = f.link(t, 100, 100, 1)
	if err := f.s.Store.Revoke(context.Background(), l.ID); err != nil {
		t.Fatal(err)
	}
	status(t, f.request(t, "GET", "/api/uploads", token, nil, nil), 410)
}
func TestStreamCancellationReleasesCapacity(t *testing.T) {
	f := newFixture(t)
	l, token := f.link(t, 1024, 1024, 1)
	u := f.reserve(t, token, "partial.bin", 1024)
	reader, writer := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, "PUT", f.http.URL+"/api/uploads/"+u.ID, reader)
	request.ContentLength = 1024
	request.Header.Set("Authorization", "Bearer "+token)
	done := make(chan struct{})
	go func() {
		defer close(done)
		r, _ := f.http.Client().Do(request)
		if r != nil {
			r.Body.Close()
		}
	}()
	writer.Write([]byte("partial"))
	deadline := time.Now().Add(5 * time.Second)
	for {
		task, _ := f.s.Store.GetUpload(context.Background(), u.ID, l.ID)
		if task.Status == "receiving" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("upload not receiving")
		}
		time.Sleep(10 * time.Millisecond)
	}
	status(t, f.request(t, "DELETE", "/api/uploads/"+u.ID, token, nil, nil), 204)
	cancel()
	writer.Close()
	<-done
	for {
		task, _ := f.s.Store.GetUpload(context.Background(), u.ID, l.ID)
		_, err := os.Stat(filepath.Join(f.data, staging(u)))
		if task.Status == "failed" && os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("partial file not cleaned")
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.reserve(t, token, "retry.bin", 1024)
}
func TestNamesCorsAndMalformedBodies(t *testing.T) {
	f := newFixture(t)
	_, token := f.link(t, 100, 200, 2)
	for _, name := range []string{"../outside", "a/b", "a\\b", "\x00", ".", "..", strings.Repeat("x", 181)} {
		body, _ := json.Marshal(map[string]any{"name": name, "size": 1})
		status(t, f.request(t, "POST", "/api/uploads", token, bytes.NewReader(body), nil), 400)
	}
	for _, body := range []string{`{"name":"a"}`, `{"name":"a","size":-1}`, `{"name":"a","size":1} {}`, `{"name":"a","size":1,"extra":true}`} {
		status(t, f.request(t, "POST", "/api/uploads", token, strings.NewReader(body), nil), 400)
	}
	status(t, f.request(t, "OPTIONS", "/api/uploads", "", nil, map[string]string{"Origin": "https://evil.example"}), 403)
	r := f.request(t, "OPTIONS", "/api/uploads", "", nil, map[string]string{"Origin": "https://portal.example"})
	status(t, r, 204)
	if r.Header.Get("Access-Control-Allow-Origin") != "https://portal.example" {
		t.Fatal("CORS missing")
	}
}
func TestPersistenceRecoveryAndSingleInstance(t *testing.T) {
	root := t.TempDir()
	public, data := filepath.Join(root, "public"), filepath.Join(root, "data")
	s, err := New(public, data, nil, WithSecretKey(fixtureSecret))
	if err != nil {
		t.Fatal(err)
	}
	if second, err := New(public, data, nil, WithSecretKey(fixtureSecret)); err == nil {
		second.Close()
		t.Fatal("two servers opened one store")
	}
	l, token, err := s.Store.CreateLink(context.Background(), Link{Title: "persist", ExpiresAt: time.Now().Add(time.Hour), MaxFileBytes: 10, MaxTotalBytes: 10, MaxFiles: 1})
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.Store.Reserve(context.Background(), l.ID, "partial", 10)
	if err != nil {
		t.Fatal(err)
	}
	s.Store.Start(context.Background(), u, l)
	s.private.WriteFile(staging(u), []byte("unfinished"), 0600)
	s.private.MkdirAll("inbox/"+l.ID, 0700)
	s.private.WriteFile(destination(u), []byte("renamed before commit"), 0600)
	s.Close()
	s, err = New(public, data, nil, WithSecretKey(fixtureSecret))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = s.Store.Authenticate(context.Background(), token); err != nil {
		t.Fatal("link lost", err)
	}
	task, _ := s.Store.GetUpload(context.Background(), u.ID, l.ID)
	if task.Status != "failed" {
		t.Fatal("not recovered")
	}
	for _, name := range []string{staging(u), destination(u)} {
		if _, err = s.private.Stat(name); !os.IsNotExist(err) {
			t.Fatal("abandoned file survived", name)
		}
	}
	if _, err = s.Store.Reserve(context.Background(), l.ID, "retry", 10); err != nil {
		t.Fatal("reservation leaked", err)
	}
}
func TestOverlappingDirectoriesRejected(t *testing.T) {
	root := t.TempDir()
	if s, err := New(root, filepath.Join(root, "private"), nil, WithSecretKey(fixtureSecret)); err == nil {
		s.Close()
		t.Fatal("private state exposed")
	}
}
