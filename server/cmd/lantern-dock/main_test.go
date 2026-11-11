package main

import (
	"bytes"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLinkCLI(t *testing.T) {
	// Container identity variables belong to the image launcher, not the CLI.
	t.Setenv("PUID", "not-a-user")
	t.Setenv("PGID", "0")
	t.Setenv("SECRET_KEY", strings.Repeat("c3", 32))
	data := t.TempDir()
	var output bytes.Buffer
	if err := run([]string{"link", "create", "--data-dir", data, "--site", "https://portal.example", "--max-file", "1MiB", "--max-total", "2MiB", "--max-files", "2"}, &output); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Link struct {
			ID           string `json:"id"`
			Title        string `json:"title"`
			MaxFileBytes int64  `json:"maxFileBytes"`
		}
		URL string `json:"url"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(result.URL)
	if u.Path != "/upload" || !strings.HasPrefix(u.Fragment, "token=") || result.Link.MaxFileBytes != 1<<20 || result.Link.Title != "Temporary inbox" {
		t.Fatal("bad link")
	}
	secret := strings.TrimPrefix(u.Fragment, "token=")
	if _, err := os.Stat(filepath.Join(data, "invitation.key")); !os.IsNotExist(err) {
		t.Fatal("CLI ignored configured SECRET_KEY")
	}
	output.Reset()
	if err := run([]string{"link", "list", "--data-dir", data}, &output); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), secret) {
		t.Fatal("list leaked token")
	}
	output.Reset()
	if err := run([]string{"link", "revoke", "--data-dir", data, result.Link.ID}, &output); err != nil {
		t.Fatal(err)
	}
}
func TestInvalidCLI(t *testing.T) {
	for _, value := range []string{"0", "-1GiB", "9223372036854775807GiB", "wat"} {
		if _, err := parseSize(value); err == nil {
			t.Fatal(value)
		}
	}
	for _, value := range []string{"http://public.example", "https://user:password@portal.example", "https://portal.example/?token=secret", "https://portal.example/#x"} {
		if _, err := siteURL(value); err == nil {
			t.Fatal(value)
		}
	}
}
