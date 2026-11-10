package nas

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResumableUploadIsScopedAndRestoresCommittedOffset(t *testing.T) {
	f := newFixture(t)
	link, token := f.link(t, 8, 8, 1)
	_, otherToken := f.link(t, 8, 8, 1)
	batch := strings.Repeat("a", 32)
	otherBatch := strings.Repeat("b", 32)

	options := f.request(t, "OPTIONS", resumePath, "", nil, map[string]string{
		"Origin": "https://portal.example",
	})
	status(t, options, 204)
	if options.Header.Get("Tus-Version") != tusVersion || !strings.Contains(options.Header.Get("Access-Control-Allow-Methods"), "PATCH") {
		t.Fatal(options.Header)
	}
	creation := map[string]string{
		"Tus-Resumable": tusVersion, "X-Upload-Batch": batch,
		"Upload-Length": "8", "Upload-Metadata": "filename " + base64.StdEncoding.EncodeToString([]byte("same.bin")),
	}
	created := f.request(t, "POST", resumePath, token, nil, creation)
	status(t, created, 201)
	location := created.Header.Get("Location")
	id := strings.TrimPrefix(location, resumePath+"/")
	if !validID(id) || created.Header.Get("Upload-Expires") == "" {
		t.Fatal(created.Header)
	}
	head := func(key, credential string, want int, offset string) {
		t.Helper()
		response := f.request(t, "HEAD", location, credential, nil, map[string]string{"Tus-Resumable": tusVersion, "X-Upload-Batch": key})
		status(t, response, want)
		if response.Header.Get("Upload-Offset") != offset {
			t.Fatal(response.Header)
		}
		if want == 200 && response.Header.Get("Upload-Metadata") != creation["Upload-Metadata"] {
			t.Fatal(response.Header)
		}
	}
	patch := func(offset, body string, want int) {
		t.Helper()
		response := f.request(t, "PATCH", location, token, strings.NewReader(body), map[string]string{
			"Tus-Resumable": tusVersion, "X-Upload-Batch": batch, "Upload-Offset": offset,
			"Content-Type": "application/offset+octet-stream",
		})
		status(t, response, want)
	}
	patch("0", "abcd", 204)
	patch("0", "xxxx", 409)
	head(batch, token, 200, "4")
	head(otherBatch, token, 404, "")
	head(batch, otherToken, 404, "")
	status(t, f.request(t, "GET", inboxPath+"/"+id, token, nil, nil), 404)
	list := func(key string) []resumableUpload {
		t.Helper()
		response := f.request(t, "GET", resumePath, token, nil, map[string]string{"Tus-Resumable": tusVersion, "X-Upload-Batch": key})
		status(t, response, 200)
		var tasks []resumableUpload
		if err := json.NewDecoder(response.Body).Decode(&tasks); err != nil {
			t.Fatal(err)
		}
		return tasks
	}
	if got := list(otherBatch); len(got) != 0 {
		t.Fatal(got)
	}

	u, err := f.s.Store.GetUpload(context.Background(), id, link.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a crash after the final rename but before updating SQLite.
	finalPath := filepath.Join(f.data, destination(u))
	if err := os.MkdirAll(filepath.Dir(finalPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(finalPath, []byte("abcdjunk"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(f.data, staging(u))); err != nil {
		t.Fatal(err)
	}
	if err := f.s.recover(); err != nil {
		t.Fatal(err)
	}
	head(batch, token, 200, "4")
	patch("4", "efgh", 204)
	head(batch, token, 200, "8")
	if got := list(batch); len(got) != 1 || got[0].Status != "complete" || got[0].Offset != 8 {
		t.Fatal(got)
	}
	content, err := os.ReadFile(finalPath)
	if err != nil || string(content) != "abcdefgh" {
		t.Fatalf("content=%q err=%v", content, err)
	}
}
