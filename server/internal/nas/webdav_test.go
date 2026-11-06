package nas

import (
	"context"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func publicTestFile(t *testing.T, directory, name, data string) {
	t.Helper()
	name = filepath.Join(directory, name)
	if err := os.MkdirAll(filepath.Dir(name), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(data), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestDAVExcludesRecycleBinsFromListingsAndDirectRequests(t *testing.T) {
	f := newFixture(t)
	for _, name := range []string{"#recycle", "@Recycle", "nested/#RECYCLE", "nested/@rEcYcLe"} {
		publicTestFile(t, f.public, name+"/deleted.txt", "DELETED-PRIVATE-CONTENTS")
	}
	for _, name := range []string{"recycle", "#recycled", "@Recycle-old", "vacation#recycle", "nested/visible.txt"} {
		publicTestFile(t, f.public, name, "public content")
		r := f.request(t, "GET", "/dav/"+url.PathEscape(name), "", nil, nil)
		status(t, r, 200)
		if read(t, r) != "public content" {
			t.Fatal("ordinary file was changed")
		}
	}
	for _, directory := range []string{"", "nested/"} {
		r := f.request(t, "PROPFIND", "/dav/"+directory, "", nil, map[string]string{"Depth": "1"})
		status(t, r, 207)
		xml := strings.ToLower(read(t, r))
		for _, hidden := range []string{"%23recycle/", "@recycle/", "%40recycle/", "deleted.txt", "deleted-private-contents"} {
			if strings.Contains(xml, hidden) {
				t.Fatalf("listing exposed %q: %s", hidden, xml)
			}
		}
		if directory == "nested/" && !strings.Contains(xml, "visible.txt") {
			t.Fatal("filter removed ordinary nested files")
		}
	}
	for _, target := range []string{
		"%23recycle", "%23recycle/", "%23recycle/deleted.txt",
		"%40Recycle/", "@Recycle/deleted.txt",
		"nested/%23RECYCLE/deleted.txt", "nested/%40rEcYcLe/",
		"%23recy%63le/deleted.txt", "nested%2F%23recycle%2Fdeleted.txt",
	} {
		for _, method := range []string{"GET", "HEAD", "PROPFIND", "OPTIONS"} {
			r := f.request(t, method, "/dav/"+target, "", nil, map[string]string{"Depth": "1", "Range": "bytes=0-5", "If-None-Match": "*"})
			status(t, r, 404)
			if strings.Contains(read(t, r), "DELETED-PRIVATE-CONTENTS") {
				t.Fatalf("%s %s exposed recycled data", method, target)
			}
		}
	}
	for _, method := range []string{"GET", "HEAD", "PROPFIND"} {
		status(t, f.request(t, method, "/dav/%2523recycle/deleted.txt", "", nil, map[string]string{"Depth": "0"}), 404)
	}
	// Filtering is read-only and leaves the NAS-managed trash untouched.
	data, err := os.ReadFile(filepath.Join(f.public, "#recycle/deleted.txt"))
	if err != nil || string(data) != "DELETED-PRIVATE-CONTENTS" {
		t.Fatal("filter changed the recycle bin")
	}
}

func TestDAVDoesNotFollowSymlinkAliasesIntoRecycleBins(t *testing.T) {
	f := newFixture(t)
	publicTestFile(t, f.public, "#recycle/deleted.txt", "DELETED-PRIVATE-CONTENTS")
	publicTestFile(t, f.public, "visible.txt", "public content")
	for name, target := range map[string]string{
		"alias-dir": "#recycle", "alias-file": "#recycle/deleted.txt", "alias-public": "visible.txt",
	} {
		if err := os.Symlink(target, filepath.Join(f.public, name)); err != nil {
			t.Fatal(err)
		}
	}
	r := f.request(t, "PROPFIND", "/dav/", "", nil, map[string]string{"Depth": "1"})
	status(t, r, 207)
	xml := read(t, r)
	if strings.Contains(xml, "alias-") || !strings.Contains(xml, "visible.txt") {
		t.Fatal("directory listing exposed aliases or lost public files", xml)
	}
	for _, target := range []string{"alias-dir", "alias-dir/deleted.txt", "alias-file", "alias-public"} {
		for _, method := range []string{"GET", "HEAD", "PROPFIND"} {
			status(t, f.request(t, method, "/dav/"+target, "", nil, map[string]string{"Depth": "0"}), 404)
		}
	}
}

func TestPublicFilesystemFiltersIncrementalDirectoryReads(t *testing.T) {
	f := newFixture(t)
	for _, name := range []string{"#recycle/deleted.txt", "@Recycle/deleted.txt", "a.txt", "b.txt", "c.txt"} {
		publicTestFile(t, f.public, name, "fixture")
	}
	if err := os.Symlink("#recycle", filepath.Join(f.public, "alias")); err != nil {
		t.Fatal(err)
	}
	fs := publicFS{f.s.public}
	for _, count := range []int{0, -1, 1, 2, 10} {
		file, err := fs.OpenFile(context.Background(), "/", os.O_RDONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for i := 0; ; i++ {
			if i > 10 {
				t.Fatal("directory read did not terminate")
			}
			entries, err := file.Readdir(count)
			if err != nil && !errors.Is(err, io.EOF) {
				t.Fatal(err)
			}
			for _, entry := range entries {
				names = append(names, entry.Name())
			}
			if count <= 0 || errors.Is(err, io.EOF) {
				break
			}
		}
		file.Close()
		slices.Sort(names)
		if !slices.Equal(names, []string{"a.txt", "b.txt", "c.txt"}) {
			t.Fatalf("Readdir(%d) = %v", count, names)
		}
	}
	for _, name := range []string{"#recycle", "@Recycle/deleted.txt"} {
		if _, err := fs.Stat(context.Background(), name); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("Stat(%q) = %v", name, err)
		}
		if file, err := fs.OpenFile(context.Background(), name, os.O_RDONLY, 0); !errors.Is(err, os.ErrNotExist) {
			if file != nil {
				file.Close()
			}
			t.Fatalf("OpenFile(%q) = %v", name, err)
		}
	}
	publicTestFile(t, f.public, "only-hidden/#recycle/deleted.txt", "fixture")
	file, err := fs.OpenFile(context.Background(), "only-hidden", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	entries, err := file.Readdir(1)
	if len(entries) != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("all-filtered directory must return EOF: %v, %v", entries, err)
	}
}
