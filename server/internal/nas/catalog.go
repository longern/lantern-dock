package nas

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"io"
	"mime"
	"os"
	"path"
	"strings"
	"time"
)

// The catalog contains metadata only. No original or thumbnail is decoded by
// the scanner. Pending changes are published atomically, so a cursor identifies
// a stable revision while subsequent directory walks leave that revision alone.
type catalogEntry struct {
	Path, Parent, Name, MIME, Modified, Version string
	Size, ModifiedNS                            int64
	Directory                                   bool
}
type catalogState struct {
	Revision string
	Ready    bool
	Updated  int64
}

func (s *Server) initCatalog() error {
	_, err := s.Store.DB.Exec(`
CREATE TABLE IF NOT EXISTS catalog (
 path TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL,
 mime TEXT NOT NULL, modified TEXT NOT NULL, version TEXT NOT NULL,
 size INTEGER NOT NULL, modified_ns INTEGER NOT NULL, directory INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS catalog_parent ON catalog(parent);
CREATE INDEX IF NOT EXISTS catalog_modified ON catalog(modified_ns DESC,path);
CREATE INDEX IF NOT EXISTS catalog_mime ON catalog(mime);
CREATE TABLE IF NOT EXISTS catalog_pending (
 path TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL,
 mime TEXT NOT NULL, modified TEXT NOT NULL, version TEXT NOT NULL,
 size INTEGER NOT NULL, modified_ns INTEGER NOT NULL, directory INTEGER NOT NULL, removed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_state (
 id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, ready INTEGER NOT NULL, updated INTEGER NOT NULL);
DELETE FROM catalog_pending;`)
	if err != nil {
		return err
	}
	if _, err = s.Store.DB.Exec(`INSERT OR IGNORE INTO catalog_state VALUES(1,?,0,0)`, randomID()); err != nil {
		return err
	}
	s.catalogKey = make([]byte, 32)
	if _, err = rand.Read(s.catalogKey); err != nil {
		return err
	}
	s.catalogWake = make(chan struct{}, 1)
	s.searchRequests = make(chan struct{}, 4)
	s.requestCatalogScan()
	return nil
}

func readCatalogState(ctx context.Context, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}) (catalogState, error) {
	var state catalogState
	err := db.QueryRowContext(ctx, `SELECT revision,ready,updated FROM catalog_state WHERE id=1`).Scan(&state.Revision, &state.Ready, &state.Updated)
	return state, err
}

var catalogMediaTypes = map[string]string{
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".heic": "image/heic", ".heif": "image/heif",
	".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
	".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".ogv": "video/ogg",
}

func catalogFile(name string, info os.FileInfo) catalogEntry {
	parent := path.Dir(name)
	if parent == "." {
		parent = ""
	}
	// Minimal container images need not ship the host's mime.types database.
	// Keep every media format supported by the UI discoverable on all NASes.
	ext := strings.ToLower(path.Ext(name))

	m := catalogMediaTypes[ext]
	if m == "" {
		m = mime.TypeByExtension(ext)
	}
	if info.IsDir() {
		m = "httpd/unix-directory"
	}
	if m == "" {
		m = "application/octet-stream"
	}
	if before, _, ok := strings.Cut(m, ";"); ok {
		m = before
	}
	return catalogEntry{Path: name, Parent: parent, Name: info.Name(), MIME: m,
		Modified: info.ModTime().UTC().Format(time.RFC3339Nano), ModifiedNS: info.ModTime().UnixNano(),
		Size: info.Size(), Directory: info.IsDir(), Version: imageVersion(name, info)}
}

func (s *Server) stageCatalog(ctx context.Context, entries []catalogEntry, removed bool) error {
	if len(entries) == 0 {
		return nil
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT OR REPLACE INTO catalog_pending VALUES(?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, item := range entries {
		if _, err = stmt.ExecContext(ctx, item.Path, item.Parent, item.Name, item.MIME, item.Modified, item.Version, item.Size, item.ModifiedNS, item.Directory, removed); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) publishCatalog(ctx context.Context, complete bool) error {
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	state, err := readCatalogState(ctx, tx)
	if err != nil {
		return err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM catalog_pending`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		if _, err = tx.ExecContext(ctx, `DELETE FROM catalog WHERE path IN (SELECT path FROM catalog_pending);
INSERT INTO catalog SELECT path,parent,name,mime,modified,version,size,modified_ns,directory FROM catalog_pending WHERE removed=0;
DELETE FROM catalog_pending;`); err != nil {
			return err
		}
	}
	if count > 0 || (!state.Ready && complete) {
		state.Revision = randomID()
	}
	if complete {
		state.Ready = true
		state.Updated = time.Now().Unix()
	}
	if _, err = tx.ExecContext(ctx, `UPDATE catalog_state SET revision=?,ready=?,updated=? WHERE id=1`, state.Revision, state.Ready, state.Updated); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) scanCatalog(ctx context.Context) error {
	state, err := readCatalogState(ctx, s.Store.DB)
	if err != nil {
		return err
	}
	old := map[string]string{}
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT path,version FROM catalog`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var name, version string
		if err = rows.Scan(&name, &version); err != nil {
			break
		}
		old[name] = version
	}
	rowErr := rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if rowErr != nil {
		return rowErr
	}
	if _, err = s.Store.DB.ExecContext(ctx, `DELETE FROM catalog_pending`); err != nil {
		return err
	}
	batch := make([]catalogEntry, 0, 128)
	flush := func() error {
		if err := s.stageCatalog(ctx, batch, false); err != nil {
			return err
		}
		batch = batch[:0]
		if !state.Ready {
			return s.publishCatalog(ctx, false)
		}
		return nil
	}
	add := func(name string, info os.FileInfo) error {
		item := catalogFile(name, info)
		previous := old[name]
		delete(old, name)
		if previous == item.Version {
			return nil
		}
		batch = append(batch, item)
		if len(batch) == cap(batch) {
			return flush()
		}
		return nil
	}
	// Never turn an unreadable subtree into a deletion. Search still reopens
	// every returned item through publicFS and cannot disclose its stale metadata.
	preserve := func(prefix string) {
		for name := range old {
			if name == prefix || strings.HasPrefix(name, prefix+"/") || prefix == "" {
				delete(old, name)
			}
		}
	}
	queue := []string{""}
	partial := false
	for len(queue) > 0 {
		if err = ctx.Err(); err != nil {
			return err
		}
		dir := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		file, openErr := (publicFS{s.public}).open(dir)
		if openErr != nil {
			if os.IsNotExist(openErr) {
				continue
			}
			preserve(dir)
			partial = true
			continue
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.IsDir() {
			file.Close()
			preserve(dir)
			partial = true
			continue
		}
		if err = add(dir, info); err != nil {
			file.Close()
			return err
		}
		for {
			if err = ctx.Err(); err != nil {
				file.Close()
				return err
			}
			names, readErr := file.Readdirnames(128)
			for _, name := range names {
				if !publicPathAllowed(name) {
					continue
				}
				relative := path.Join(dir, name)
				child, childErr := openPublicChild(file.File, name, 0)
				if childErr != nil {
					if !os.IsNotExist(childErr) {
						preserve(relative)
						partial = true
					}
					continue
				}
				entry, statErr := child.Stat()
				child.Close()
				if statErr != nil {
					preserve(relative)
					partial = true
					continue
				}
				if entry.IsDir() {
					queue = append(queue, relative)
				} else if entry.Mode().IsRegular() {
					if err = add(relative, entry); err != nil {
						file.Close()
						return err
					}
				}
			}
			if readErr != nil {
				if !errors.Is(readErr, io.EOF) {
					preserve(dir)
					partial = true
				}
				break
			}
		}
		file.Close()
	}
	if err = flush(); err != nil {
		return err
	}
	for name := range old {
		batch = append(batch, catalogEntry{Path: name})
		if len(batch) == cap(batch) {
			if err = s.stageCatalog(ctx, batch, true); err != nil {
				return err
			}
			batch = batch[:0]
		}
	}
	if err = s.stageCatalog(ctx, batch, true); err != nil {
		return err
	}
	if err = s.publishCatalog(ctx, !partial); err != nil {
		return err
	}
	if partial {
		return os.ErrPermission
	}
	return nil
}

func (s *Server) requestCatalogScan() {
	select {
	case s.catalogWake <- struct{}{}:
	default:
	}
}
func (s *Server) ensureCatalogScan() {
	s.catalogMu.RLock()
	busy := s.catalogScanning || s.catalogError
	s.catalogMu.RUnlock()
	if !busy && len(s.catalogWake) == 0 {
		s.requestCatalogScan()
	}
}
func (s *Server) runCatalog() {
	timer := time.NewTicker(time.Minute)
	defer timer.Stop()
	last := time.Time{}
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-timer.C:
		case <-s.catalogWake:
		}
		s.catalogMu.Lock()
		s.catalogScanning = true
		s.catalogMu.Unlock()
		// Coalesce explicit refreshes and avoid allowing public reads to turn
		// into an unbounded filesystem scanning workload.
		if delay := 5*time.Second - time.Since(last); delay > 0 {
			select {
			case <-s.ctx.Done():
				return
			case <-time.After(delay):
			}
		}
		// Refreshes received during the debounce interval describe the same
		// forthcoming walk. Only requests arriving during the walk need another.
		select {
		case <-s.catalogWake:
		default:
		}
		err := s.scanCatalog(s.ctx)
		s.catalogMu.Lock()
		s.catalogScanning = false
		s.catalogError = err != nil
		s.catalogMu.Unlock()
		last = time.Now()
	}
}

func (s *Server) catalogStatus(state catalogState) string {
	s.catalogMu.RLock()
	defer s.catalogMu.RUnlock()
	if s.catalogScanning || len(s.catalogWake) > 0 {
		return "scanning"
	}
	if s.catalogError || !state.Ready {
		return "error"
	}
	return "ready"
}
