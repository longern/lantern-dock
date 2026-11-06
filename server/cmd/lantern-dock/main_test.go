package main

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestLinkCLI(t *testing.T) {
	// Container identity variables belong to the image launcher, not the CLI.
	t.Setenv("PUID", "not-a-user")
	t.Setenv("PGID", "0")
	data := t.TempDir()
	var output bytes.Buffer
	if err := run([]string{"link", "create", "--data-dir", data, "--site", "https://portal.example", "--max-file", "1MiB", "--max-total", "2MiB", "--max-files", "2"}, &output); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Link struct {
			ID           string `json:"id"`
			MaxFileBytes int64  `json:"maxFileBytes"`
		}
		URL string `json:"url"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(result.URL)
	if !strings.HasPrefix(u.Fragment, "/upload/") || result.Link.MaxFileBytes != 1<<20 {
		t.Fatal("bad link")
	}
	secret := strings.TrimPrefix(u.Fragment, "/upload/")
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
