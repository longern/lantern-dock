package nas

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	resumePath     = inboxPath + "/resumable"
	tusVersion     = "1.0.0"
	resumeLifetime = 24 * time.Hour
	maxUploadChunk = 8 << 20
)

type resumableUpload struct {
	Upload
	Offset      int64  `json:"offset"`
	Fingerprint string `json:"fingerprint,omitempty"`
	metadata    string
}

const resumeSelect = `SELECT u.id,u.link_id,u.name,u.size,u.status,u.expires_at,r.offset,r.metadata
 FROM resumable_uploads r JOIN uploads u ON u.id=r.upload_id
 WHERE u.link_id=? AND r.batch_hash=?`

func scanResume(row scanner, extra ...any) (resumableUpload, error) {
	var u resumableUpload
	var expiry int64
	fields := []any{&u.ID, &u.LinkID, &u.Name, &u.Size, &u.Status, &expiry, &u.Offset, &u.metadata}
	err := row.Scan(append(fields, extra...)...)
	u.ExpiresAt = time.Unix(expiry, 0).UTC()
	if u.Status == "pending" && !u.ExpiresAt.After(time.Now()) {
		u.Status = "failed"
	}
	return u, err
}

func (s *Server) resumeTasks(ctx context.Context, l Link, batch []byte, cursor string) ([]resumableUpload, string, error) {
	const pageSize = 100
	now := time.Now().Unix()
	priority, created, id := 2, int64(0), ""
	if cursor != "" {
		var err error
		parts := strings.SplitN(cursor, ".", 3)
		if len(parts) != 3 || (parts[0] != "0" && parts[0] != "1") || !validID(parts[2]) {
			return nil, "", fault(400, "INVALID_QUERY", "errors.invalidListQuery")
		}
		priority, _ = strconv.Atoi(parts[0])
		created, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || created < 0 {
			return nil, "", fault(400, "INVALID_QUERY", "errors.invalidListQuery")
		}
		id = parts[2]
	}
	// Pending tasks always precede history. A keyset cursor stays valid even
	// when failed rows are removed or new uploads arrive between pages.
	rows, err := s.Store.DB.QueryContext(ctx, `WITH tasks AS (
 SELECT u.id,u.link_id,u.name,u.size,u.status,u.expires_at,r.offset,r.metadata,u.created_at,
        (u.status='pending' AND u.expires_at>?) AS priority
 FROM resumable_uploads r JOIN uploads u ON u.id=r.upload_id
 WHERE u.link_id=? AND r.batch_hash=?
)
 SELECT * FROM tasks WHERE (priority,created_at,id)<(?,?,?)
 ORDER BY priority DESC,created_at DESC,id DESC LIMIT ?`, now, l.ID, batch, priority, created, id, pageSize+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	tasks := []resumableUpload{}
	var next string
	for rows.Next() {
		if len(tasks) == pageSize {
			return tasks, next, nil
		}
		task, err := scanResume(rows, &created, &priority)
		if err != nil {
			return nil, "", err
		}
		_, task.Fingerprint = resumeMetadata(task.metadata)
		tasks = append(tasks, task)
		next = fmt.Sprintf("%d.%d.%s", priority, created, task.ID)
	}
	return tasks, "", rows.Err()
}

func resumeMetadata(value string) (name, fingerprint string) {
	seen := map[string]bool{}
	for _, field := range strings.Split(value, ",") {
		key, encoded, _ := strings.Cut(strings.TrimSpace(field), " ")
		if key == "" || seen[key] || strings.IndexFunc(key, func(r rune) bool { return r < '!' || r > '~' }) >= 0 {
			return "", ""
		}
		seen[key] = true
		bytes, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return "", ""
		}
		switch key {
		case "filename":
			if !utf8.Valid(bytes) {
				return "", ""
			}
			name = string(bytes)
		case "fingerprint":
			if len(bytes) != 64 || !validID(string(bytes[:32])) || !validID(string(bytes[32:])) {
				return "", ""
			}
			fingerprint = string(bytes)
		}
	}
	return name, fingerprint
}

func (s *Server) serveResumable(w http.ResponseWriter, r *http.Request, l Link) {
	batches := r.Header.Values("X-Upload-Batch")
	if len(batches) != 1 || !validID(batches[0]) {
		writeError(w, r, fault(400, "INVALID_UPLOAD_BATCH", "errors.invalidUploadBatch"))
		return
	}
	batch := sha256.Sum256([]byte(batches[0]))
	if r.Header.Get("Tus-Resumable") != tusVersion {
		w.Header().Set("Tus-Version", tusVersion)
		writeError(w, r, fault(412, "TUS_VERSION_UNSUPPORTED", "errors.uploadVersionUnsupported"))
		return
	}
	ctx := r.Context()
	if r.URL.Path == resumePath {
		switch r.Method {
		case "GET":
			tasks, next, err := s.resumeTasks(ctx, l, batch[:], r.URL.Query().Get("cursor"))
			if err != nil {
				writeError(w, r, err)
				return
			}
			if next != "" {
				w.Header().Set("Link", "<"+resumePath+"?cursor="+next+">; rel=\"next\"")
			}
			writeJSON(w, 200, tasks)
		case "POST":
			size, err := strconv.ParseInt(r.Header.Get("Upload-Length"), 10, 64)
			metadata := r.Header.Get("Upload-Metadata")
			if err != nil || size < 0 || len(metadata) > 2048 || r.ContentLength > 0 {
				writeError(w, r, fault(400, "INVALID_FILE", "errors.fileDetailsRequired"))
				return
			}
			if r.ContentLength < 0 {
				// The bridge can forward an empty POST with chunked framing.
				_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(15 * time.Second))
				if _, err := io.ReadFull(r.Body, make([]byte, 1)); err != io.EOF {
					writeError(w, r, fault(400, "INVALID_FILE", "errors.fileDetailsRequired"))
					return
				}
			}
			name, _ := resumeMetadata(metadata)
			u, err := s.Store.reserve(ctx, l.ID, name, size, batch[:], metadata)
			if err == nil && size == 0 {
				_, err = s.appendUpload(w, r, l, batch[:], u.ID, 0)
				if err != nil {
					cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
					_ = s.Store.Fail(cleanup, u.ID)
					cancel()
					s.cleanupInterrupted(u.ID)
				}
			}
			if err != nil {
				writeError(w, r, err)
				return
			}
			w.Header().Set("Location", resumePath+"/"+u.ID)
			if size > 0 {
				w.Header().Set("Upload-Expires", u.ExpiresAt.Format(http.TimeFormat))
			}
			w.WriteHeader(201)
		default:
			w.Header().Set("Allow", "GET, POST, OPTIONS")
			writeError(w, r, fault(405, "METHOD_NOT_ALLOWED", "errors.methodNotAllowed"))
		}
		return
	}
	id := strings.TrimPrefix(r.URL.Path, resumePath+"/")
	if !validID(id) {
		writeError(w, r, fault(404, "UPLOAD_NOT_FOUND", "errors.uploadNotFound"))
		return
	}
	if r.Method == "PATCH" {
		if r.Header.Get("Content-Type") != "application/offset+octet-stream" {
			writeError(w, r, fault(415, "UPLOAD_CONTENT_TYPE", "errors.uploadContentType"))
			return
		}
		offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
		if err != nil || offset < 0 {
			writeError(w, r, fault(400, "INVALID_UPLOAD_OFFSET", "errors.uploadOffset"))
			return
		}
		u, err := s.appendUpload(w, r, l, batch[:], id, offset)
		if err != nil {
			writeError(w, r, err)
			return
		}
		w.Header().Set("Upload-Offset", strconv.FormatInt(u.Offset, 10))
		if u.Status != "complete" {
			w.Header().Set("Upload-Expires", u.ExpiresAt.Format(http.TimeFormat))
		}
		w.WriteHeader(204)
		return
	}
	u, err := s.loadResume(ctx, l, batch[:], id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	switch r.Method {
	case "HEAD":
		w.Header().Set("Upload-Offset", strconv.FormatInt(u.Offset, 10))
		w.Header().Set("Upload-Length", strconv.FormatInt(u.Size, 10))
		w.Header().Set("Upload-Metadata", u.metadata)
		if u.Status != "complete" {
			w.Header().Set("Upload-Expires", u.ExpiresAt.Format(http.TimeFormat))
		}
		w.WriteHeader(200)
	case "DELETE":
		if err := s.Store.Cancel(ctx, u.Upload); err != nil {
			writeError(w, r, err)
			return
		}
		s.cleanupInterrupted(id)
		w.WriteHeader(204)
	default:
		w.Header().Set("Allow", "HEAD, PATCH, DELETE, OPTIONS")
		writeError(w, r, fault(405, "METHOD_NOT_ALLOWED", "errors.methodNotAllowed"))
	}
}

func (s *Server) loadResume(ctx context.Context, l Link, batch []byte, id string) (resumableUpload, error) {
	u, err := scanResume(s.Store.DB.QueryRowContext(ctx, resumeSelect+` AND u.id=?`, l.ID, batch, id))
	if errors.Is(err, sql.ErrNoRows) {
		return u, fault(404, "UPLOAD_NOT_FOUND", "errors.uploadNotFound")
	}
	if err == nil && u.Status == "failed" {
		return u, fault(410, "UPLOAD_CANCELLED", "errors.uploadCancelled")
	}
	return u, err
}

// A PATCH owns its file until the checkpoint is committed. Parallel PATCHes
// cannot append to the same offset, even when they start on different tabs.
func (s *Server) appendUpload(w http.ResponseWriter, r *http.Request, l Link, batch []byte, id string, offset int64) (resumableUpload, error) {
	u, err := s.loadResume(r.Context(), l, batch, id)
	if err != nil {
		return u, err
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		return u, fault(503, "UPLOAD_BUSY", "errors.uploadBusy")
	}
	ctx, cancel := context.WithDeadline(r.Context(), l.ExpiresAt)
	defer cancel()
	s.mu.Lock()
	if s.ctx.Err() != nil || s.active[id] != nil {
		s.mu.Unlock()
		return u, fault(409, "UPLOAD_UNAVAILABLE", "errors.uploadUnavailable")
	}
	s.active[id] = cancel
	s.jobs.Add(1)
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.active, id)
		s.mu.Unlock()
		s.removeFailedResume(id)
		s.jobs.Done()
	}()
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	interrupted := make(chan struct{})
	stopRead := context.AfterFunc(ctx, func() {
		_ = http.NewResponseController(w).SetReadDeadline(time.Now())
		close(interrupted)
	})
	defer func() {
		if !stopRead() {
			<-interrupted
		}
	}()

	u, err = s.loadResume(ctx, l, batch, id)
	if err != nil {
		return u, err
	}
	if u.Status == "complete" || u.Offset != offset {
		return u, fault(409, "UPLOAD_OFFSET_MISMATCH", "errors.uploadOffset")
	}
	limit := min(maxUploadChunk, u.Size-u.Offset)
	if r.ContentLength > limit {
		return u, fault(413, "UPLOAD_CHUNK_TOO_LARGE", "errors.uploadChunkTooLarge")
	}
	n, err := s.writeUploadChunk(w, r, ctx, l, u, limit)
	if err != nil {
		return u, err
	}
	return s.commitUploadChunk(ctx, u, l, n)
}

func (s *Server) writeUploadChunk(w http.ResponseWriter, r *http.Request, ctx context.Context, l Link, u resumableUpload, limit int64) (int64, error) {
	// A crash after rename but before the SQLite commit leaves a destination
	// with the old checkpoint. Restore it and truncate any uncommitted bytes.
	staged := staging(u.Upload)
	if _, err := s.private.Stat(staged); errors.Is(err, os.ErrNotExist) {
		if err = s.private.Rename(destination(u.Upload), staged); err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
	}
	f, err := s.private.OpenFile(staged, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if info.Size() < u.Offset {
		return 0, io.ErrUnexpectedEOF
	}
	if err = f.Truncate(u.Offset); err != nil {
		return 0, err
	}
	if _, err = f.Seek(u.Offset, io.SeekStart); err != nil {
		return 0, err
	}
	n, err := io.Copy(f, progressBody{ctx, http.MaxBytesReader(w, r.Body, limit), w, l.ExpiresAt})
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return 0, fault(413, "UPLOAD_CHUNK_TOO_LARGE", "errors.uploadChunkTooLarge")
	}
	if err != nil || ctx.Err() != nil || (r.ContentLength >= 0 && n != r.ContentLength) {
		return 0, fault(400, "UPLOAD_INTERRUPTED", "errors.uploadInterrupted")
	}
	if err = f.Sync(); err != nil {
		return 0, err
	}
	if err = f.Close(); err != nil {
		return 0, err
	}
	if u.Offset == 0 {
		if err = s.syncUploadDir("inbox/.staging"); err != nil {
			return 0, err
		}
	}
	return n, nil
}

func (s *Server) commitUploadChunk(ctx context.Context, u resumableUpload, l Link, n int64) (resumableUpload, error) {
	// Finish a fully written chunk even if the client loses its acknowledgement.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return u, err
	}
	defer tx.Rollback()
	now := time.Now()
	u.Offset += n
	u.ExpiresAt = time.Unix(min(l.ExpiresAt.Unix(), now.Add(resumeLifetime).Unix()), 0).UTC()
	if u.Offset == u.Size {
		u.Status = "complete"
		u.ExpiresAt = l.ExpiresAt
	}
	result, err := tx.ExecContext(ctx, `UPDATE uploads SET status=?,expires_at=? WHERE id=? AND status='pending'
 AND expires_at>? AND EXISTS(SELECT 1 FROM links WHERE id=? AND revoked=0 AND expires_at>?)`,
		u.Status, u.ExpiresAt.Unix(), u.ID, now.Unix(), l.ID, now.Unix())
	if err != nil {
		return u, err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return u, fault(410, "UPLOAD_CANCELLED", "errors.uploadCancelled")
	}
	if _, err = tx.ExecContext(ctx, `UPDATE resumable_uploads SET offset=? WHERE upload_id=?`, u.Offset, u.ID); err != nil {
		return u, err
	}
	if u.Status == "complete" {
		if err = s.publishUpload(u.Upload); err != nil {
			return u, err
		}
	}
	return u, tx.Commit()
}

func (s *Server) cleanupInterrupted(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cancel := s.active[id]; cancel != nil {
		cancel()
		return
	}
	s.removeFailedResume(id)
}

func (s *Server) removeFailedResume(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	u := Upload{ID: id}
	err := s.Store.DB.QueryRowContext(ctx, `SELECT u.link_id,u.name FROM uploads u
 JOIN resumable_uploads r ON r.upload_id=u.id WHERE u.id=? AND u.status='failed'`, id).Scan(&u.LinkID, &u.Name)
	if err == nil {
		_ = s.private.Remove(staging(u))
		_ = s.private.Remove(destination(u))
	}
}
