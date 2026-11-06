package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitializeDataRejectsInvalidArgumentsBeforeMutation(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	for _, args := range [][]string{{"--uid=0"}, {"--gid=-1"}, {"--uid=4294967295"}, {"--uid=admin"}, {"unexpected"}} {
		base := []string{"--public-dir=" + filepath.Join(root, "public"), "--data-dir=" + data}
		if err := initializeData(append(base, args...)); err == nil {
			t.Fatalf("accepted %v", args)
		}
		if _, err := os.Stat(data); !os.IsNotExist(err) {
			t.Fatal("validation created data directory", err)
		}
	}
}

func TestDataDirectoriesRejectAliasesAndOverlap(t *testing.T) {
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
		if _, err := separateDataDirectories(public, data); err == nil {
			t.Fatalf("accepted %s", data)
		}
	}
	if _, err := os.Stat(filepath.Join(public, "private")); !os.IsNotExist(err) {
		t.Fatal("validation created a public subdirectory", err)
	}
	data, err := separateDataDirectories(public, filepath.Join(root, "new", "data"))
	if err != nil || !strings.HasSuffix(data, "/new/data") {
		t.Fatalf("%s %v", data, err)
	}
}

func TestDataMigrationOnlyTouchesPrivateApplicationFiles(t *testing.T) {
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
	if err := prepareData(data, os.Getuid(), os.Getgid()); err != nil {
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

func TestDataMigrationRejectsSymlinksAndHardLinks(t *testing.T) {
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
			if err := prepareData(data, os.Getuid(), os.Getgid()); err == nil {
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

func TestDataMigrationRejectsNestedMountsIncludingSameFilesystem(t *testing.T) {
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
