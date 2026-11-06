package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeIdentityConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name, image, puid, pgid string
		uid, gid                int
		want                    runtimeIdentity
		bad                     string
	}{
		{name: "standalone keeps caller", uid: 501, gid: 20},
		{name: "image defaults", image: "65532", want: runtimeIdentity{true, 65532, 65532}},
		{name: "NAS identity", image: "65532", puid: "1000", pgid: "100", want: runtimeIdentity{true, 1000, 100}},
		{name: "native Docker user", image: "65532", uid: 1001, gid: 100, want: runtimeIdentity{true, 1001, 100}},
		{name: "matching variables and native user", image: "65532", puid: "1001", pgid: "100", uid: 1001, gid: 100, want: runtimeIdentity{true, 1001, 100}},
		{name: "partial variable", image: "65532", puid: "1000", want: runtimeIdentity{true, 1000, 65532}},
		{name: "leading zeros are decimal", image: "65532", puid: "01000", pgid: "00100", want: runtimeIdentity{true, 1000, 100}},
		{name: "root rejected", image: "65532", puid: "0", bad: "PUID"},
		{name: "root group rejected", image: "65532", pgid: "0", bad: "PGID"},
		{name: "negative rejected", image: "65532", puid: "-1", bad: "PUID"},
		{name: "overflow rejected", image: "65532", puid: "4294967295", bad: "PUID"},
		{name: "name rejected", image: "65532", puid: "admin", bad: "PUID"},
		{name: "whitespace rejected", image: "65532", puid: " 1000", bad: "PUID"},
		{name: "group must be explicit", image: "65532", uid: 1000, bad: "PGID"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := runtimeIdentityFor(tc.image, func(key string) string {
				if key == "PUID" {
					return tc.puid
				}
				if key == "PGID" {
					return tc.pgid
				}
				return ""
			}, tc.uid, tc.gid)
			if tc.bad != "" {
				if err == nil || !strings.Contains(err.Error(), tc.bad) {
					t.Fatalf("%+v, %v", got, err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %+v, %v; want %+v", got, err, tc.want)
			}
		})
	}
}

func TestRuntimeDirectoriesRejectAliasesAndOverlap(t *testing.T) {
	root := t.TempDir()
	public := filepath.Join(root, "public")
	if err := os.Mkdir(public, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(public, alias); err != nil {
		t.Fatal(err)
	}
	for _, data := range []string{public, root, filepath.Join(public, "private"), alias, filepath.Join(alias, "private"), "/"} {
		if _, err := separateRuntimeDirectories(public, data); err == nil {
			t.Fatalf("accepted %s", data)
		}
	}
	if _, err := os.Stat(filepath.Join(public, "private")); !os.IsNotExist(err) {
		t.Fatal("validation created a public subdirectory", err)
	}
	data, err := separateRuntimeDirectories(public, filepath.Join(root, "new", "data"))
	if err != nil || !strings.HasSuffix(data, "/new/data") {
		t.Fatalf("%s %v", data, err)
	}
}

func TestRuntimeMigrationOnlyTouchesPrivateApplicationFiles(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(data, "inbox", "collection"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"lantern-dock.sqlite", "lantern-dock.sqlite-wal", "lantern-dock.sqlite-shm", "server.lock", "inbox/collection/photo.jpg", "unrelated.txt"} {
		if err := os.WriteFile(filepath.Join(data, name), []byte("preserved content"), 0400); err != nil {
			t.Fatal(err)
		}
	}
	if err := prepareRuntimeData(data, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"lantern-dock.sqlite", "lantern-dock.sqlite-wal", "lantern-dock.sqlite-shm", "server.lock", "inbox/collection/photo.jpg"} {
		info, err := os.Stat(filepath.Join(data, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("%s has mode %o", name, info.Mode().Perm())
		}
		content, _ := os.ReadFile(filepath.Join(data, name))
		if string(content) != "preserved content" {
			t.Fatal("changed file contents")
		}
	}
	info, _ := os.Stat(filepath.Join(data, "unrelated.txt"))
	if info.Mode().Perm() != 0400 {
		t.Fatal("changed unrelated file")
	}
}

func TestRuntimeMigrationRejectsSymlinksAndHardLinks(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			data := filepath.Join(root, "data")
			outside := filepath.Join(root, "outside")
			if err := os.Mkdir(data, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(outside, []byte("private sentinel"), 0400); err != nil {
				t.Fatal(err)
			}
			var err error
			if kind == "symlink" {
				err = os.Symlink(outside, filepath.Join(data, "lantern-dock.sqlite"))
			} else {
				err = os.Link(outside, filepath.Join(data, "lantern-dock.sqlite"))
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := prepareRuntimeData(data, os.Getuid(), os.Getgid()); err == nil {
				t.Fatal("accepted linked state")
			}
			info, _ := os.Stat(outside)
			if info.Mode().Perm() != 0400 {
				t.Fatal("modified outside permissions")
			}
			content, _ := os.ReadFile(outside)
			if string(content) != "private sentinel" {
				t.Fatal("modified outside contents")
			}
		})
	}
}

func TestRuntimeMigrationRejectsNestedMountsIncludingSameFilesystem(t *testing.T) {
	for _, tc := range []struct {
		mount string
		bad   bool
	}{
		{mount: "/data"}, {mount: "/public"}, {mount: "/data-other"},
		{mount: "/data/inbox/mounted-public", bad: true},
		{mount: `/data/inbox/folder\040name`, bad: true},
	} {
		err := rejectNestedDataMounts("/data", "42 41 0:1 / "+tc.mount+" rw - ext4 /dev/test rw")
		if (err != nil) != tc.bad {
			t.Fatalf("mount %s: %v", tc.mount, err)
		}
	}
}
