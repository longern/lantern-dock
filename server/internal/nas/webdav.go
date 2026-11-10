package nas

import (
	"context"
	"encoding/xml"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/net/webdav"
	"golang.org/x/sys/unix"
)

type publicFS struct{ root *os.Root }

func publicPathAllowed(name string) bool {
	if !validRequestPath(name) {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") || strings.EqualFold(part, "#recycle") || strings.EqualFold(part, "@Recycle") {
			return false
		}
	}
	return true
}
func (f publicFS) Mkdir(context.Context, string, os.FileMode) error { return os.ErrPermission }
func (f publicFS) RemoveAll(context.Context, string) error          { return os.ErrPermission }
func (f publicFS) Rename(context.Context, string, string) error     { return os.ErrPermission }
func (f publicFS) Stat(_ context.Context, name string) (os.FileInfo, error) {
	file, err := f.open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return file.Stat()
}
func (f publicFS) OpenFile(_ context.Context, name string, flag int, _ os.FileMode) (webdav.File, error) {
	if flag != os.O_RDONLY {
		return nil, os.ErrPermission
	}
	return f.open(name)
}

// Open each component relative to an already-open directory without following
// symlinks. A check followed by Root.Open would allow aliases (or symlink swaps)
// to reach excluded directories even when the requested name looks public.
func (f publicFS) open(name string) (*publicFile, error) {
	if name == "." {
		name = ""
	}
	if !publicPathAllowed(name) {
		return nil, os.ErrNotExist
	}
	file, err := f.root.Open(".")
	if err != nil {
		return nil, err
	}
	parts := strings.FieldsFunc(name, func(c rune) bool { return c == '/' })
	for i, part := range parts {
		flags := 0
		if i < len(parts)-1 || strings.HasSuffix(name, "/") {
			flags |= unix.O_DIRECTORY
		}
		next, err := openPublicChild(file, part, flags)
		file.Close()
		if err != nil {
			return nil, err
		}
		file = next
	}
	info, err := file.Stat()
	if err != nil || (!info.IsDir() && !info.Mode().IsRegular()) {
		file.Close()
		return nil, os.ErrNotExist
	}
	return &publicFile{file}, nil
}

func openPublicChild(directory *os.File, name string, flags int) (*os.File, error) {
	fd, err := unix.Openat(int(directory.Fd()), name, flags|unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		if err == unix.ELOOP || err == unix.ENOTDIR {
			err = os.ErrNotExist
		}
		return nil, &os.PathError{Op: "open", Path: name, Err: err}
	}
	return os.NewFile(uintptr(fd), name), nil
}

type publicFile struct{ *os.File }

// x/net/webdav exposes these protected discovery properties through its
// optional property interface. Writes remain denied by serveDAV.
func (f *publicFile) DeadProps() (map[xml.Name]webdav.Property, error) {
	return map[xml.Name]webdav.Property{
		{Space: "DAV:", Local: "supported-query-grammar-set"}: {XMLName: xml.Name{Space: "DAV:", Local: "supported-query-grammar-set"}, InnerXML: []byte(`<d:supported-query-grammar xmlns:d="DAV:"><d:grammar><d:basicsearch/></d:grammar></d:supported-query-grammar>`)},
		{Space: "DAV:", Local: "supported-method-set"}:        {XMLName: xml.Name{Space: "DAV:", Local: "supported-method-set"}, InnerXML: []byte(`<d:supported-method xmlns:d="DAV:" name="GET"/><d:supported-method xmlns:d="DAV:" name="HEAD"/><d:supported-method xmlns:d="DAV:" name="OPTIONS"/><d:supported-method xmlns:d="DAV:" name="PROPFIND"/><d:supported-method xmlns:d="DAV:" name="SEARCH"/>`)},
	}, nil
}
func (f *publicFile) Patch([]webdav.Proppatch) ([]webdav.Propstat, error) {
	return nil, os.ErrPermission
}

func (f *publicFile) Readdir(count int) ([]os.FileInfo, error) {
	var visible []os.FileInfo
	for {
		remaining := count
		if count > 0 {
			remaining -= len(visible)
		}
		// Readdir uses the File's display name for lstat on Unix. Enumerate
		// names, then inspect children relative to this actual directory FD.
		entries, err := f.File.Readdirnames(remaining)
		for _, name := range entries {
			if !publicPathAllowed(name) {
				continue
			}
			child, openErr := openPublicChild(f.File, name, 0)
			if openErr != nil {
				if os.IsNotExist(openErr) || os.IsPermission(openErr) {
					continue
				}
				return visible, openErr
			}
			info, statErr := child.Stat()
			child.Close()
			if statErr != nil {
				return visible, statErr
			}
			if info.IsDir() || info.Mode().IsRegular() {
				visible = append(visible, info)
			}
		}
		if count <= 0 || len(visible) == count || err != nil {
			return visible, err
		}
	}
}

// Cache only successful reads. Error responses must never become a cached
// directory or file representation after permissions or a path have changed.
type davCacheWriter struct {
	http.ResponseWriter
	policy string
}

func (w davCacheWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w davCacheWriter) WriteHeader(status int) {
	policy := w.policy
	if status >= 400 {
		policy = "no-store"
	}
	w.Header().Set("Cache-Control", policy)
	w.ResponseWriter.WriteHeader(status)
}
func (w davCacheWriter) Write(data []byte) (int, error) {
	return w.ResponseWriter.Write(data)
}

func (s *Server) serveDAV(w http.ResponseWriter, r *http.Request) {
	if !publicPathAllowed(r.URL.Path) {
		writeError(w, r, fault(404, "NOT_FOUND", "errors.notFound"))
		return
	}
	const allow = "GET, HEAD, OPTIONS, PROPFIND, SEARCH"
	w.Header().Set("Allow", allow)
	w.Header().Set("DAV", "1, <"+searchNamespace+">")
	w.Header().Set("DASL", "<DAV:basicsearch>")
	if r.Method == "SEARCH" {
		s.serveSearch(w, r)
		return
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && r.Method != "PROPFIND" {
		writeError(w, r, fault(405, "READ_ONLY", "errors.readOnly"))
		return
	}
	if r.Method == "PROPFIND" {
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(15 * time.Second))
		if d := r.Header.Get("Depth"); d != "0" && d != "1" {
			writeError(w, r, fault(403, "FINITE_DEPTH_REQUIRED", "errors.finiteDepthRequired"))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	}
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	policy := "private, no-cache"
	if r.Method == "PROPFIND" {
		policy = "private, max-age=15"
	}
	w.Header().Set("Cache-Control", policy)
	s.dav.ServeHTTP(davCacheWriter{w, policy}, r)
}
