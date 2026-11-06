package nas

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const imageCacheLimit = 1 << 30
const imageBodyLimit = 8 << 20

type cachedImage struct {
	size int64
	used time.Time
}
type imageCache struct {
	root               *os.Root
	mu                 sync.Mutex
	entries            map[string]cachedImage
	bytes, limit       int64
	requests, renderer chan struct{}
}

func imageHash(value []byte) string { return fmt.Sprintf("%x", sha256.Sum256(value)) }
func cacheImageName(name string) bool {
	stem, ext, ok := strings.Cut(name, ".")
	return ok && len(stem) == 64 && strings.Trim(stem, "0123456789abcdef") == "" && (ext == "jpg" || ext == "json")
}
func newImageCache(private *os.Root) (*imageCache, error) {
	if err := private.MkdirAll("cache/images", 0700); err != nil {
		return nil, err
	}
	root, err := private.OpenRoot("cache/images")
	if err != nil {
		return nil, err
	}
	c := &imageCache{root: root, entries: map[string]cachedImage{}, limit: imageCacheLimit, requests: make(chan struct{}, 8), renderer: make(chan struct{}, 1)}
	dir, err := root.Open(".")
	if err != nil {
		root.Close()
		return nil, err
	}
	names, err := dir.Readdirnames(-1)
	dir.Close()
	if err != nil {
		root.Close()
		return nil, err
	}
	for _, name := range names {
		entry, err := root.Lstat(name)
		if err != nil {
			continue
		}
		if cacheImageName(name) && entry.Mode().IsRegular() {
			c.entries[name] = cachedImage{entry.Size(), entry.ModTime()}
			c.bytes += entry.Size()
		} else if strings.HasPrefix(name, ".tmp-") && entry.Mode().IsRegular() {
			_ = root.Remove(name)
		}
	}
	c.trim()
	return c, nil
}
func (c *imageCache) get(name string) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[name]
	if !ok {
		return nil
	}
	file, err := c.root.OpenFile(name, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		c.forget(name)
		return nil
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > imageBodyLimit || info.Size() <= 0 {
		c.forget(name)
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(file, imageBodyLimit+1))
	if err != nil || len(data) > imageBodyLimit {
		return nil
	}
	entry.used = time.Now()
	c.entries[name] = entry
	return data
}
func (c *imageCache) forget(name string) {
	c.bytes -= c.entries[name].size
	delete(c.entries, name)
	_ = c.root.Remove(name)
}
func (c *imageCache) put(name string, data []byte) {
	if !cacheImageName(name) || len(data) == 0 || len(data) > imageBodyLimit {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	temporary := ".tmp-" + randomID()
	file, err := c.root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return
	} // A full cache disk must not break image delivery.
	defer c.root.Remove(temporary)
	_, err = file.Write(data)
	closeErr := file.Close()
	if err != nil || closeErr != nil || c.root.Rename(temporary, name) != nil {
		return
	}
	c.bytes += int64(len(data)) - c.entries[name].size
	c.entries[name] = cachedImage{int64(len(data)), time.Now()}
	c.trim()
}
func (c *imageCache) trim() {
	if c.bytes <= c.limit && len(c.entries) <= 20000 {
		return
	}
	names := make([]string, 0, len(c.entries))
	for name := range c.entries {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return c.entries[names[i]].used.Before(c.entries[names[j]].used) })
	for _, name := range names {
		if c.bytes <= c.limit && len(c.entries) <= 20000 {
			break
		}
		c.forget(name)
	}
}
