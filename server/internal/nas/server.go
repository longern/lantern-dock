package nas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/longern/lantern-dock/server/internal/i18n"
	"golang.org/x/net/webdav"
	"golang.org/x/sys/unix"
)

type Server struct {
	identity        *identityAuth
	Store           *Store
	public, private *os.Root
	lock            *os.File
	dav             *webdav.Handler
	images          *imageCache
	mediaTool       string
	mediaIndexes    chan struct{}
	mediaVideos     chan struct{}
	mediaProbe      chan struct{}
	origins         map[string]bool
	ctx             context.Context
	cancel          context.CancelFunc
	mu              sync.Mutex
	active          map[string]func()
	slots           chan struct{}
	jobs            sync.WaitGroup
	catalogWake     chan struct{}
	catalogMu       sync.RWMutex
	catalogScanning bool
	catalogError    bool
	catalogKey      []byte
	searchRequests  chan struct{}
}

func New(publicDir, dataDir string, origins []string, options ...StoreOption) (*Server, error) {
	if err := os.MkdirAll(publicDir, 0755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, err
	}
	pub, err := filepath.EvalSymlinks(publicDir)
	if err != nil {
		return nil, err
	}
	pub, err = filepath.Abs(pub)
	if err != nil {
		return nil, err
	}
	data, err := filepath.EvalSymlinks(dataDir)
	if err != nil {
		return nil, err
	}
	data, err = filepath.Abs(data)
	if err != nil {
		return nil, err
	}
	if inside(pub, data) || inside(data, pub) {
		return nil, fmt.Errorf("public-dir and data-dir must be separate, non-overlapping directories")
	}
	store, err := OpenStore(data, options...)
	if err != nil {
		return nil, err
	}
	s := &Server{Store: store, origins: map[string]bool{}, active: map[string]func(){}, slots: make(chan struct{}, 32)}
	s.mediaTool, _ = exec.LookPath("exiftool")
	s.mediaIndexes = make(chan struct{}, 2)
	s.mediaVideos = make(chan struct{}, 2)
	s.mediaProbe = make(chan struct{}, 1)
	ok := false
	defer func() {
		if !ok {
			s.Close()
		}
	}()
	for _, origin := range origins {
		if origin == "" {
			continue
		}
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("origins must be exact HTTP(S) origins without a trailing slash")
		}
		s.origins[origin] = true
	}
	s.lock, err = os.OpenFile(filepath.Join(data, "server.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(s.lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return nil, fmt.Errorf("another server is using this data-dir: %w", err)
	}
	s.public, err = os.OpenRoot(pub)
	if err != nil {
		return nil, err
	}
	s.private, err = os.OpenRoot(data)
	if err != nil {
		return nil, err
	}
	if err = s.private.MkdirAll("inbox/.staging", 0700); err != nil {
		return nil, err
	}
	if s.images, err = newImageCache(s.private); err != nil {
		return nil, err
	}
	s.dav = &webdav.Handler{Prefix: filesPath, FileSystem: publicFS{s.public}, LockSystem: webdav.NewMemLS()}
	if err = s.recover(); err != nil {
		return nil, err
	}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	if err = s.initCatalog(); err != nil {
		return nil, err
	}
	s.jobs.Go(s.sweep)
	s.jobs.Go(s.runCatalog)
	ok = true
	return s, nil
}
func inside(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
func (s *Server) Close() error {
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Lock()
	for _, cancel := range s.active {
		cancel()
	}
	s.mu.Unlock()
	s.jobs.Wait()
	if s.images != nil {
		s.images.root.Close()
	}
	if s.public != nil {
		s.public.Close()
	}
	if s.private != nil {
		s.private.Close()
	}
	if s.lock != nil {
		s.lock.Close()
	}
	if s.Store != nil {
		return s.Store.Close()
	}
	return nil
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func responseTranslator(w http.ResponseWriter, r *http.Request) i18n.Translator {
	t := i18n.New(strings.Join(r.Header.Values("Accept-Language"), ","))
	w.Header().Set("Content-Language", t.Locale())
	w.Header().Add("Vary", "Accept-Language")
	return t
}
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	t := responseTranslator(w, r)
	var f *Fault
	if !errors.As(err, &f) {
		f = &Fault{503, "STORAGE_UNAVAILABLE", "errors.storageUnavailable"}
	}
	if f.Status == 401 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="lantern-dock-uploads"`)
	}
	if f.Code == "UPLOAD_RATE_LIMITED" {
		w.Header().Set("Retry-After", "60")
	}
	writeJSON(w, f.Status, map[string]string{"error": t.T(f.MessageKey), "code": f.Code})
}
func validRequestPath(value string) bool {
	if strings.ContainsAny(value, "\\\x00\r\n") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "." || part == ".." {
			return false
		}
	}
	return true
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if !validRequestPath(r.URL.Path) {
		writeError(w, r, fault(400, "INVALID_PATH", "errors.invalidPath"))
		return
	}
	w.Header().Add("Vary", "Origin")
	if origin := r.Header.Get("Origin"); origin != "" {
		if !s.origins[origin] {
			writeError(w, r, fault(403, "ORIGIN_DENIED", "errors.originDenied"))
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS, PROPFIND, SEARCH, POST, PUT, PATCH, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Accept-Language, Authorization, Content-Type, Depth, DPoP, If-None-Match, Range, If-Range, Tus-Resumable, Upload-Length, Upload-Metadata, Upload-Offset, X-Upload-Batch")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Disposition, Accept-Ranges, ETag, Link, Retry-After, WWW-Authenticate, DPoP-Nonce, DAV, DASL, Allow, Location, Tus-Resumable, Tus-Version, Tus-Extension, Upload-Length, Upload-Offset, Upload-Expires, Upload-Metadata")
	}
	switch {
	case r.URL.Path == mediaPath || strings.HasPrefix(r.URL.Path, mediaPath+"/"):
		s.serveMedia(w, r)
	case r.URL.Path == imagesPath || strings.HasPrefix(r.URL.Path, imagesPath+"/"):
		s.serveImage(w, r)
	case r.URL.Path == capabilitiesPath:
		s.serveCapabilities(w, r)
	case r.URL.Path == adminPath || strings.HasPrefix(r.URL.Path, adminPath+"/"):
		s.serveAdmin(w, r)
	case r.URL.Path == memberUploadPath || strings.HasPrefix(r.URL.Path, memberUploadPath+"/"):
		s.serveMemberUploads(w, r)
	case r.URL.Path == accountPath || strings.HasPrefix(r.URL.Path, accountPath+"/"):
		s.serveAccount(w, r)
	case r.URL.Path == "/healthz" && (r.Method == "GET" || r.Method == "HEAD"):
		w.WriteHeader(200)
	case r.URL.Path == filesPath || strings.HasPrefix(r.URL.Path, filesPath+"/"):
		s.serveDAV(w, r)
	case r.URL.Path == inboxPath || strings.HasPrefix(r.URL.Path, inboxPath+"/"):
		s.serveUploads(w, r)
	default:
		writeError(w, r, fault(404, "NOT_FOUND", "errors.notFound"))
	}
}
