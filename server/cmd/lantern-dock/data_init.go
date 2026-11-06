package main

import (
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

// A filesystem-only helper for the image entrypoint. Process identity belongs
// to the container launcher; ordinary serve/link commands never switch users.
func initializeData(args []string) error {
	flags := flag.NewFlagSet("init-data", flag.ContinueOnError)
	public := flags.String("public-dir", "/public", "public directory to keep separate")
	data := flags.String("data-dir", "/data", "private application data directory")
	uid := flags.Int("uid", 1000, "private state owner UID")
	gid := flags.Int("gid", 1000, "private state owner GID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *uid <= 0 || *gid <= 0 || *uid > 2147483647 || *gid > 2147483647 {
		return fmt.Errorf("init-data requires positive numeric UID/GID and directory flags only")
	}
	directory, err := separateDataDirectories(*public, *data)
	if err != nil {
		return err
	}
	if runtime.GOOS == "linux" {
		mounts, err := os.ReadFile("/proc/self/mountinfo")
		if err != nil {
			return err
		}
		if err := rejectNestedDataMounts(directory, string(mounts)); err != nil {
			return err
		}
	}
	return prepareData(directory, *uid, *gid)
}

// Resolve even a not-yet-created directory through its existing parents, so an
// alias cannot turn the private initialization into a change to public files.
func prospectivePath(name string) (string, error) {
	abs, err := filepath.Abs(name)
	if err != nil {
		return "", err
	}
	var missing []string
	for {
		resolved, err := filepath.EvalSymlinks(abs)
		if err == nil {
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return resolved, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		missing = append(missing, filepath.Base(abs))
		parent := filepath.Dir(abs)
		if parent == abs {
			return "", err
		}
		abs = parent
	}
}

func separateDataDirectories(public, data string) (string, error) {
	pub, err := prospectivePath(public)
	if err != nil {
		return "", err
	}
	private, err := prospectivePath(data)
	if err != nil {
		return "", err
	}
	inside := func(parent, child string) bool {
		rel, err := filepath.Rel(parent, child)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	if filepath.Dir(private) == private || inside(pub, private) || inside(private, pub) {
		return "", fmt.Errorf("public-dir and data-dir must be separate, non-overlapping directories; data-dir cannot be the filesystem root")
	}
	return private, nil
}

func rejectNestedDataMounts(directory string, mountinfo string) error {
	unescape := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	for _, line := range strings.Split(mountinfo, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		mount := unescape.Replace(fields[4])
		rel, err := filepath.Rel(directory, mount)
		if err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("refusing nested mount %s inside private data directory %s", mount, directory)
		}
	}
	return nil
}

// Initialize only LanternDock's state and inbox. Keep unrelated files, public
// folders, symlink targets and hard-linked files out of privileged migration.
func prepareData(directory string, uid, gid int) error {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	base, err := root.Stat(".")
	if err != nil {
		return err
	}
	device := base.Sys().(*syscall.Stat_t).Dev
	allowed := func(name string) bool {
		top := strings.SplitN(name, "/", 2)[0]
		return name == "." || top == "inbox" || top == "cache" || top == "lantern-dock.sqlite" || top == "lantern-dock.sqlite-wal" || top == "lantern-dock.sqlite-shm" || top == "server.lock"
	}
	return fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return walkErr
		}
		if !allowed(name) {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing symlink in private state: %s", name)
		}
		// O_NOFOLLOW closes the final-component symlink race. os.Root confines
		// the entire lookup; operate on the opened inode rather than its path.
		file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if os.IsNotExist(err) {
			return nil
		} // A running CLI/server may finish an upload.
		if err != nil {
			return err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return err
		}
		stat := info.Sys().(*syscall.Stat_t)
		if stat.Dev != device {
			return fmt.Errorf("refusing nested filesystem in private state: %s", name)
		}
		if !info.IsDir() && stat.Nlink == 0 {
			return nil
		}
		if !info.IsDir() && (!info.Mode().IsRegular() || stat.Nlink != 1) {
			return fmt.Errorf("refusing special or hard-linked private file: %s", name)
		}
		if int(stat.Uid) != uid || int(stat.Gid) != gid {
			if err := file.Chown(uid, gid); err != nil {
				return err
			}
		}
		ownerMode := os.FileMode(0600)
		if info.IsDir() {
			ownerMode = 0700
		}
		if info.Mode().Perm()&ownerMode != ownerMode {
			return file.Chmod(info.Mode().Perm() | ownerMode)
		}
		return nil
	})
}
