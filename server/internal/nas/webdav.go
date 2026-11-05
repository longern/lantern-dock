package nas

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/net/webdav"
)

type publicFS struct{ root *os.Root }

func rootName(name string) string {
	name = strings.TrimPrefix(name, "/")
	if name == "" {
		return "."
	}
	return name
}
func (f publicFS) Mkdir(context.Context, string, os.FileMode) error { return os.ErrPermission }
func (f publicFS) RemoveAll(context.Context, string) error          { return os.ErrPermission }
func (f publicFS) Rename(context.Context, string, string) error     { return os.ErrPermission }
func (f publicFS) Stat(_ context.Context, name string) (os.FileInfo, error) {
	return f.root.Stat(rootName(name))
}
func (f publicFS) OpenFile(_ context.Context, name string, flag int, _ os.FileMode) (webdav.File, error) {
	if flag != os.O_RDONLY {
		return nil, os.ErrPermission
	}
	return f.root.Open(rootName(name))
}
func (s *Server) serveDAV(w http.ResponseWriter, r *http.Request) {
	const allow = "GET, HEAD, OPTIONS, PROPFIND"
	w.Header().Set("Allow", allow)
	w.Header().Set("DAV", "1")
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && r.Method != "PROPFIND" {
		writeError(w, fault(405, "READ_ONLY", "公开文件仅支持浏览和下载。"))
		return
	}
	if r.Method == "PROPFIND" {
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(15 * time.Second))
		if d := r.Header.Get("Depth"); d != "0" && d != "1" {
			writeError(w, fault(403, "FINITE_DEPTH_REQUIRED", "目录读取需要 Depth: 0 或 1。"))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	}
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	s.dav.ServeHTTP(w, r)
}
