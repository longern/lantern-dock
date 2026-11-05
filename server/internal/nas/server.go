package nas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/webdav"
	"golang.org/x/sys/unix"
)

type Server struct {
	identity        *identityAuth
	Store           *Store
	public, private *os.Root
	lock            *os.File
	dav             *webdav.Handler
	origins         map[string]bool
	ctx             context.Context
	cancel          context.CancelFunc
	mu              sync.Mutex
	active          map[string]func()
	slots           chan struct{}
	jobs            sync.WaitGroup
}

func New(publicDir, dataDir string, origins []string) (*Server, error) {
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
	store, err := OpenStore(data)
	if err != nil {
		return nil, err
	}
	s := &Server{Store: store, origins: map[string]bool{}, active: map[string]func(){}, slots: make(chan struct{}, 32)}
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
	s.dav = &webdav.Handler{Prefix: "/dav", FileSystem: publicFS{s.public}, LockSystem: webdav.NewMemLS()}
	if err = s.recover(); err != nil {
		return nil, err
	}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.jobs.Go(s.sweep)
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
func writeError(w http.ResponseWriter, err error) {
	var f *Fault
	if !errors.As(err, &f) {
		f = &Fault{503, "STORAGE_UNAVAILABLE", "收件服务暂不可用，请稍后重试。"}
	}
	if f.Status == 401 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="lantern-dock-uploads"`)
	}
	writeJSON(w, f.Status, map[string]string{"error": f.Message, "code": f.Code})
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
		writeError(w, fault(400, "INVALID_PATH", "请求路径无效。"))
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Add("Vary", "Origin")
		if !s.origins[origin] {
			writeError(w, fault(403, "ORIGIN_DENIED", "此网页来源未获允许。"))
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS, PROPFIND, POST, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Depth, DPoP")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag, WWW-Authenticate, DPoP-Nonce")
	}
	switch {
	case r.URL.Path == "/api/account" || strings.HasPrefix(r.URL.Path, "/api/account/"):
		s.serveAccount(w, r)
	case r.URL.Path == "/healthz" && (r.Method == "GET" || r.Method == "HEAD"):
		w.WriteHeader(200)
	case r.URL.Path == "/dav" || strings.HasPrefix(r.URL.Path, "/dav/"):
		s.serveDAV(w, r)
	case r.URL.Path == "/api/uploads" || strings.HasPrefix(r.URL.Path, "/api/uploads/"):
		s.serveUploads(w, r)
	default:
		writeError(w, fault(404, "NOT_FOUND", "找不到这个地址。"))
	}
}
func (s *Server) serveUploads(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	headers := r.Header.Values("Authorization")
	token := ""
	if len(headers) == 1 {
		scheme, value, ok := strings.Cut(headers[0], " ")
		if ok && strings.EqualFold(scheme, "Bearer") {
			token = value
		}
	}
	l, err := s.Store.Authenticate(r.Context(), token)
	if err != nil {
		writeError(w, err)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/uploads")
	if id == "" || id == "/" {
		switch r.Method {
		case "GET":
			if err = s.Store.Usage(r.Context(), &l); err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, 200, l)
		case "POST":
			_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(15 * time.Second))
			var input struct {
				Name string `json:"name"`
				Size *int64 `json:"size"`
			}
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
			decoder.DisallowUnknownFields()
			if err = decoder.Decode(&input); err != nil || input.Size == nil {
				writeError(w, fault(400, "INVALID_FILE", "请提供文件名和文件大小。"))
				return
			}
			if err = decoder.Decode(new(any)); err != io.EOF {
				writeError(w, fault(400, "INVALID_FILE", "请求必须是单个 JSON 对象。"))
				return
			}
			u, err := s.Store.Reserve(r.Context(), l.ID, input.Name, *input.Size)
			if err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, 201, u)
		default:
			w.Header().Set("Allow", "GET, POST, OPTIONS")
			writeError(w, fault(405, "METHOD_NOT_ALLOWED", "此接口不支持该请求方法。"))
		}
		return
	}
	id = strings.TrimPrefix(id, "/")
	if len(id) != 32 || strings.Trim(id, "0123456789abcdef") != "" {
		writeError(w, fault(404, "UPLOAD_NOT_FOUND", "找不到这个上传任务。"))
		return
	}
	u, err := s.Store.GetUpload(r.Context(), id, l.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	switch r.Method {
	case "GET":
		writeJSON(w, 200, u)
	case "PUT":
		s.receive(w, r, u, l)
	case "DELETE":
		if err = s.Store.Cancel(r.Context(), u); err != nil {
			writeError(w, err)
			return
		}
		s.mu.Lock()
		cancel := s.active[u.ID]
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		w.WriteHeader(204)
	default:
		w.Header().Set("Allow", "GET, PUT, DELETE, OPTIONS")
		writeError(w, fault(405, "METHOD_NOT_ALLOWED", "此接口不支持该请求方法。"))
	}
}
func staging(u Upload) string     { return "inbox/.staging/" + u.ID + ".part" }
func destination(u Upload) string { return path.Join("inbox", u.LinkID, u.ID+"-"+u.Name) }

type progressBody struct {
	ctx      context.Context
	body     io.Reader
	response http.ResponseWriter
	expires  time.Time
}

func (b progressBody) Read(p []byte) (int, error) {
	deadline := time.Now().Add(time.Minute)
	if b.expires.Before(deadline) {
		deadline = b.expires
	}
	_ = http.NewResponseController(b.response).SetReadDeadline(deadline)
	if err := b.ctx.Err(); err != nil {
		return 0, err
	}
	return b.body.Read(p)
}

func (s *Server) receive(w http.ResponseWriter, r *http.Request, u Upload, l Link) {
	if r.ContentLength >= 0 && r.ContentLength != u.Size {
		writeError(w, fault(400, "SIZE_MISMATCH", "文件大小与上传任务不一致。"))
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		writeError(w, fault(503, "UPLOAD_BUSY", "同时上传的文件过多，请稍后重试。"))
		return
	}
	if err := s.Store.Start(r.Context(), u, l); err != nil {
		writeError(w, err)
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), l.ExpiresAt)
	defer cancel()
	interrupted := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		_ = http.NewResponseController(w).SetReadDeadline(time.Now())
		close(interrupted)
	})
	stopServer := context.AfterFunc(s.ctx, cancel)
	defer stopServer()
	defer func() {
		if !stop() {
			<-interrupted
		}
	}()
	s.mu.Lock()
	if s.ctx.Err() != nil {
		s.mu.Unlock()
		_ = s.Store.Fail(context.Background(), u.ID)
		writeError(w, fault(503, "SHUTTING_DOWN", "服务正在关闭。"))
		return
	}
	s.active[u.ID] = cancel
	s.jobs.Add(1)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.active, u.ID); s.mu.Unlock(); s.jobs.Done() }()
	complete := false
	defer func() {
		if !complete {
			_ = s.private.Remove(staging(u))
			// A commit can lose its acknowledgement. Preserve completed files,
			// including when their committed state cannot be checked yet.
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if s.Store.Fail(cleanup, u.ID) == nil {
				current, err := s.Store.GetUpload(cleanup, u.ID, l.ID)
				if err == nil && current.Status != "complete" {
					_ = s.private.Remove(destination(u))
				}
			}
		}
	}()
	f, err := s.private.OpenFile(staging(u), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		writeError(w, err)
		return
	}
	n, copyErr := io.Copy(f, progressBody{ctx, http.MaxBytesReader(w, r.Body, u.Size), w, l.ExpiresAt})
	syncErr := f.Sync()
	closeErr := f.Close()
	if copyErr != nil || n != u.Size || ctx.Err() != nil {
		writeError(w, fault(400, "UPLOAD_INTERRUPTED", "上传未完成，请重试。"))
		return
	}
	if syncErr != nil {
		writeError(w, syncErr)
		return
	}
	if closeErr != nil {
		writeError(w, closeErr)
		return
	}
	if err = s.private.MkdirAll(path.Join("inbox", u.LinkID), 0700); err != nil {
		writeError(w, err)
		return
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE uploads SET status='complete' WHERE id=? AND status='receiving' AND EXISTS(SELECT 1 FROM links WHERE id=? AND revoked=0 AND expires_at>?)`, u.ID, l.ID, time.Now().Unix())
	if err != nil {
		writeError(w, err)
		return
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		writeError(w, fault(410, "UPLOAD_CANCELLED", "上传已取消或收件链接已失效。"))
		return
	}
	if err = s.private.Rename(staging(u), destination(u)); err != nil {
		writeError(w, err)
		return
	}
	// Persist the new directory entry before committing the SQLite completion.
	for _, name := range []string{path.Dir(destination(u)), "inbox/.staging", "inbox", "."} {
		dir, err := s.private.Open(name)
		if err != nil {
			writeError(w, err)
			return
		}
		err = dir.Sync()
		_ = dir.Close()
		if err != nil {
			writeError(w, err)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		current, checkErr := s.Store.GetUpload(context.Background(), u.ID, l.ID)
		if checkErr == nil && current.Status == "complete" {
			complete = true
			writeJSON(w, 201, current)
			return
		}
		writeError(w, err)
		return
	}
	complete = true
	u.Status = "complete"
	u.ExpiresAt = l.ExpiresAt
	writeJSON(w, 201, u)
}
func (s *Server) recover() error {
	if _, err := s.Store.DB.Exec(`UPDATE uploads SET status='failed' WHERE status='receiving'`); err != nil {
		return err
	}
	rows, err := s.Store.DB.Query(`SELECT id,link_id,name FROM uploads WHERE status!='complete'`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var u Upload
		if err = rows.Scan(&u.ID, &u.LinkID, &u.Name); err != nil {
			return err
		}
		if err = s.private.Remove(staging(u)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err = s.private.Remove(destination(u)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return rows.Err()
}
func (s *Server) sweep() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}
		rows, err := s.Store.DB.QueryContext(s.ctx, `SELECT uploads.id FROM uploads JOIN links ON links.id=uploads.link_id WHERE status IN ('pending','receiving') AND (uploads.expires_at<=? OR links.expires_at<=? OR links.revoked=1)`, time.Now().Unix(), time.Now().Unix())
		if err != nil {
			continue
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				ids = append(ids, id)
			}
		}
		rows.Close()
		for _, id := range ids {
			s.mu.Lock()
			cancel := s.active[id]
			s.mu.Unlock()
			if cancel != nil {
				cancel()
			}
			_ = s.Store.Fail(s.ctx, id)
		}
	}
}
