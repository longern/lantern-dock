package nas

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

func (s *Server) serveUploads(w http.ResponseWriter, r *http.Request) {
	resumable := r.URL.Path == resumePath || strings.HasPrefix(r.URL.Path, resumePath+"/")
	if resumable {
		w.Header().Set("Tus-Resumable", tusVersion)
	}
	if r.Method == "OPTIONS" {
		if resumable {
			w.Header().Set("Tus-Version", tusVersion)
			w.Header().Set("Tus-Extension", "creation,expiration")
		}
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
		writeError(w, r, err)
		return
	}
	if resumable {
		s.serveResumable(w, r, l)
		return
	}
	if r.Method == "GET" && r.URL.Path == inboxPath {
		w.Header().Set("Tus-Version", tusVersion)
	}
	id := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, inboxPath), "/")
	s.serveUploadTask(w, r, l, id)
}

func (s *Server) serveUploadTask(w http.ResponseWriter, r *http.Request, l Link, id string) {
	if id == "" {
		switch r.Method {
		case "GET":
			if err := s.Store.Usage(r.Context(), &l); err != nil {
				writeError(w, r, err)
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
			if err := decoder.Decode(&input); err != nil || input.Size == nil {
				writeError(w, r, fault(400, "INVALID_FILE", "errors.fileDetailsRequired"))
				return
			}
			if err := decoder.Decode(new(any)); err != io.EOF {
				writeError(w, r, fault(400, "INVALID_FILE", "errors.singleJsonObjectRequired"))
				return
			}
			u, err := s.Store.Reserve(r.Context(), l.ID, input.Name, *input.Size)
			if err != nil {
				writeError(w, r, err)
				return
			}
			writeJSON(w, 201, u)
		default:
			w.Header().Set("Allow", "GET, POST, OPTIONS")
			writeError(w, r, fault(405, "METHOD_NOT_ALLOWED", "errors.methodNotAllowed"))
		}
		return
	}
	if !validID(id) {
		writeError(w, r, fault(404, "UPLOAD_NOT_FOUND", "errors.uploadNotFound"))
		return
	}
	u, err := s.Store.GetUpload(r.Context(), id, l.ID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if u.resumable {
		writeError(w, r, fault(404, "UPLOAD_NOT_FOUND", "errors.uploadNotFound"))
		return
	}
	switch r.Method {
	case "GET":
		writeJSON(w, 200, u)
	case "PUT":
		s.receive(w, r, u, l)
	case "DELETE":
		if err = s.Store.Cancel(r.Context(), u); err != nil {
			writeError(w, r, err)
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
		writeError(w, r, fault(405, "METHOD_NOT_ALLOWED", "errors.methodNotAllowed"))
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
		writeError(w, r, fault(400, "SIZE_MISMATCH", "errors.sizeMismatch"))
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		writeError(w, r, fault(503, "UPLOAD_BUSY", "errors.uploadBusy"))
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
		writeError(w, r, fault(503, "SHUTTING_DOWN", "errors.shuttingDown"))
		return
	}
	// Register the active writer before a failed task can be pruned.
	if err := s.Store.Start(ctx, u, l); err != nil {
		s.mu.Unlock()
		writeError(w, r, err)
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
		writeError(w, r, err)
		return
	}
	n, copyErr := io.Copy(f, progressBody{ctx, http.MaxBytesReader(w, r.Body, u.Size), w, l.ExpiresAt})
	syncErr := f.Sync()
	closeErr := f.Close()
	if copyErr != nil || n != u.Size || ctx.Err() != nil {
		writeError(w, r, fault(400, "UPLOAD_INTERRUPTED", "errors.uploadInterrupted"))
		return
	}
	if syncErr != nil {
		writeError(w, r, syncErr)
		return
	}
	if closeErr != nil {
		writeError(w, r, closeErr)
		return
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		writeError(w, r, err)
		return
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE uploads SET status='complete' WHERE id=? AND status='receiving' AND EXISTS(SELECT 1 FROM links WHERE id=? AND revoked=0 AND expires_at>?)`, u.ID, l.ID, time.Now().Unix())
	if err != nil {
		writeError(w, r, err)
		return
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		writeError(w, r, fault(410, "UPLOAD_CANCELLED", "errors.uploadCancelled"))
		return
	}
	if err = s.publishUpload(u); err != nil {
		writeError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		current, checkErr := s.Store.GetUpload(context.Background(), u.ID, l.ID)
		if checkErr == nil && current.Status == "complete" {
			complete = true
			writeJSON(w, 201, current)
			return
		}
		writeError(w, r, err)
		return
	}
	complete = true
	u.Status = "complete"
	u.ExpiresAt = l.ExpiresAt
	writeJSON(w, 201, u)
}
func (s *Server) publishUpload(u Upload) error {
	if err := s.private.MkdirAll(path.Dir(destination(u)), 0700); err != nil {
		return err
	}
	if err := s.private.Rename(staging(u), destination(u)); err != nil {
		return err
	}
	// Persist the new directory entry before committing the SQLite completion.
	for _, name := range []string{path.Dir(destination(u)), "inbox/.staging", "inbox", "."} {
		if err := s.syncUploadDir(name); err != nil {
			return err
		}
	}
	return nil
}
func (s *Server) syncUploadDir(name string) error {
	dir, err := s.private.Open(name)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func (s *Server) recover() error {
	if _, err := s.Store.DB.Exec(`UPDATE uploads SET status='failed' WHERE status='receiving'`); err != nil {
		return err
	}
	now := time.Now().Unix()
	rows, err := s.Store.DB.Query(`SELECT id,link_id,name FROM uploads WHERE status!='complete' AND NOT
 (status='pending' AND expires_at>? AND id IN (SELECT upload_id FROM resumable_uploads)
 AND link_id IN (SELECT id FROM links WHERE revoked=0 AND expires_at>?))`, now, now)
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
			now := time.Now().Unix()
			result, err := s.Store.DB.ExecContext(s.ctx, `UPDATE uploads SET status='failed'
 WHERE id=? AND status IN ('pending','receiving') AND (expires_at<=? OR
 EXISTS(SELECT 1 FROM links WHERE links.id=uploads.link_id AND (revoked=1 OR links.expires_at<=?)))`,
				id, now, now)
			if err == nil {
				if count, _ := result.RowsAffected(); count != 0 {
					s.cleanupInterrupted(id)
				}
			}
		}
		_ = s.pruneFailedUploads(s.ctx, time.Now().Add(-24*time.Hour))
	}
}

func (s *Server) pruneFailedUploads(ctx context.Context, cutoff time.Time) error {
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT id,link_id,name FROM uploads
 WHERE status='failed' AND created_at<=? ORDER BY created_at,id LIMIT 100`, cutoff.Unix())
	if err != nil {
		return err
	}
	var failed []Upload
	for rows.Next() {
		var u Upload
		if err := rows.Scan(&u.ID, &u.LinkID, &u.Name); err != nil {
			rows.Close()
			return err
		}
		failed = append(failed, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var failures error
	for _, u := range failed {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.pruneFailedUpload(ctx, u); err != nil {
			failures = errors.Join(failures, err)
		}
	}
	return failures
}

func (s *Server) pruneFailedUpload(ctx context.Context, u Upload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active[u.ID] != nil {
		return nil
	}
	// Keep the database row until the files are gone so cleanup can be retried
	// after a filesystem error or restart.
	for _, name := range []string{staging(u), destination(u)} {
		if err := s.private.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := s.syncUploadDir(path.Dir(name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	_, err := s.Store.DB.ExecContext(ctx, `DELETE FROM uploads WHERE id=? AND status='failed'`, u.ID)
	return err
}
