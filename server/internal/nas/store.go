package nas

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/longern/lantern-dock/server/internal/i18n"
	_ "modernc.org/sqlite"
)

// Fault keeps a catalog key until response serialization. Background media and
// storage work never capture a caller's language or cache translated errors.
type Fault struct {
	Status           int
	Code, MessageKey string
}

func (e *Fault) Error() string { return i18n.New("").T(e.MessageKey) }
func fault(status int, code, messageKey string) error {
	return &Fault{Status: status, Code: code, MessageKey: messageKey}
}

type Store struct {
	DB        *sql.DB
	Directory string
}
type Link struct {
	ID            string    `json:"id"`
	Title         string    `json:"title"`
	ExpiresAt     time.Time `json:"expiresAt"`
	MaxFileBytes  int64     `json:"maxFileBytes"`
	MaxTotalBytes int64     `json:"maxTotalBytes"`
	MaxFiles      int64     `json:"maxFiles"`
	Revoked       bool      `json:"revoked"`
	UsedBytes     int64     `json:"usedBytes"`
	UsedFiles     int64     `json:"usedFiles"`
}
type Upload struct {
	ID        string    `json:"id"`
	LinkID    string    `json:"-"`
	Name      string    `json:"name"`
	Size      int64     `json:"size"`
	Status    string    `json:"status"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func OpenStore(directory string) (*Store, error) {
	directory, err := filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	dbPath := filepath.Join(directory, "lantern-dock.sqlite")
	file, err := os.OpenFile(dbPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = file.Close(); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: dbPath}
	q := u.Query()
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "temp_store(MEMORY)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS links (
 id TEXT PRIMARY KEY, token_hash BLOB NOT NULL UNIQUE, title TEXT NOT NULL,
 expires_at INTEGER NOT NULL, max_file_bytes INTEGER NOT NULL CHECK(max_file_bytes>0),
 max_total_bytes INTEGER NOT NULL CHECK(max_total_bytes>0), max_files INTEGER NOT NULL CHECK(max_files>0),
 revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS uploads (
 id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES links(id), name TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size>=0), status TEXT NOT NULL CHECK(status IN ('pending','receiving','complete','failed')),
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS uploads_link ON uploads(link_id,status,expires_at);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Store{DB: db, Directory: directory}, nil
}
func (s *Store) Close() error { return s.DB.Close() }
func (s *Store) CreateLink(ctx context.Context, link Link) (Link, string, error) {
	if strings.TrimSpace(link.Title) == "" || len(link.Title) > 200 || strings.IndexFunc(link.Title, unicode.IsControl) >= 0 {
		return Link{}, "", fmt.Errorf("title must be 1–200 bytes without control characters")
	}
	if !link.ExpiresAt.After(time.Now()) || link.MaxFileBytes <= 0 || link.MaxTotalBytes < link.MaxFileBytes || link.MaxFiles <= 0 {
		return Link{}, "", fmt.Errorf("expiry must be in the future; positive limits and max-file <= max-total are required")
	}
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return Link{}, "", err
	}
	token := base64.RawURLEncoding.EncodeToString(key[:])
	hash := sha256.Sum256([]byte(token))
	link.ID = randomID()
	link.ExpiresAt = time.Unix(link.ExpiresAt.Unix(), 0).UTC()
	link.Revoked = false
	link.UsedBytes = 0
	link.UsedFiles = 0
	_, err := s.DB.ExecContext(ctx, `INSERT INTO links(id,token_hash,title,expires_at,max_file_bytes,max_total_bytes,max_files,created_at) VALUES(?,?,?,?,?,?,?,?)`, link.ID, hash[:], link.Title, link.ExpiresAt.Unix(), link.MaxFileBytes, link.MaxTotalBytes, link.MaxFiles, time.Now().Unix())
	return link, token, err
}

const linkColumns = `id,title,expires_at,max_file_bytes,max_total_bytes,max_files,revoked`

type scanner interface{ Scan(...any) error }

func scanLink(row scanner) (Link, error) {
	var l Link
	var expiry int64
	err := row.Scan(&l.ID, &l.Title, &expiry, &l.MaxFileBytes, &l.MaxTotalBytes, &l.MaxFiles, &l.Revoked)
	l.ExpiresAt = time.Unix(expiry, 0).UTC()
	return l, err
}
func live(l Link) error {
	if l.Revoked {
		return fault(410, "LINK_REVOKED", "errors.linkRevoked")
	}
	if !time.Now().Before(l.ExpiresAt) {
		return fault(410, "LINK_EXPIRED", "errors.linkExpired")
	}
	return nil
}
func (s *Store) Authenticate(ctx context.Context, token string) (Link, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 {
		return Link{}, fault(401, "INVALID_UPLOAD_TOKEN", "errors.invalidUploadToken")
	}
	hash := sha256.Sum256([]byte(token))
	l, err := scanLink(s.DB.QueryRowContext(ctx, `SELECT `+linkColumns+` FROM links WHERE token_hash=?`, hash[:]))
	if errors.Is(err, sql.ErrNoRows) {
		return Link{}, fault(401, "INVALID_UPLOAD_TOKEN", "errors.invalidUploadToken")
	}
	if err != nil {
		return Link{}, err
	}
	return l, live(l)
}

const usageWhere = `(status='complete' OR (status IN ('pending','receiving') AND expires_at>?))`

func (s *Store) Usage(ctx context.Context, l *Link) error {
	return s.DB.QueryRowContext(ctx, `SELECT COALESCE(SUM(size),0),COUNT(*) FROM uploads WHERE link_id=? AND `+usageWhere, l.ID, time.Now().Unix()).Scan(&l.UsedBytes, &l.UsedFiles)
}
func (s *Store) ListLinks(ctx context.Context) ([]Link, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+linkColumns+` FROM links ORDER BY created_at DESC,id`)
	if err != nil {
		return nil, err
	}
	result := []Link{}
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, l)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range result {
		if err = s.Usage(ctx, &result[i]); err != nil {
			return nil, err
		}
	}
	return result, nil
}
func (s *Store) Revoke(ctx context.Context, id string) error {
	result, err := s.DB.ExecContext(ctx, `UPDATE links SET revoked=1 WHERE id=?`, id)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("link not found")
	}
	return nil
}
func validName(name string) bool {
	return len(name) > 0 && len(name) <= 180 && name != "." && name != ".." && !strings.ContainsAny(name, "/\\") && strings.IndexFunc(name, unicode.IsControl) < 0 && strings.TrimSpace(name) != ""
}
func (s *Store) Reserve(ctx context.Context, linkID, name string, size int64) (Upload, error) {
	if !validName(name) || size < 0 {
		return Upload{}, fault(400, "INVALID_FILE", "errors.invalidFile")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Upload{}, err
	}
	defer tx.Rollback()
	l, err := scanLink(tx.QueryRowContext(ctx, `SELECT `+linkColumns+` FROM links WHERE id=?`, linkID))
	if err != nil {
		return Upload{}, err
	}
	if err = live(l); err != nil {
		return Upload{}, err
	}
	if size > l.MaxFileBytes {
		return Upload{}, fault(413, "FILE_TOO_LARGE", "errors.fileTooLarge")
	}
	var used, count int64
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(size),0),COUNT(*) FROM uploads WHERE link_id=? AND `+usageWhere, l.ID, time.Now().Unix()).Scan(&used, &count)
	if err != nil {
		return Upload{}, err
	}
	if size > l.MaxTotalBytes-used || count >= l.MaxFiles {
		return Upload{}, fault(409, "QUOTA_EXCEEDED", "errors.quotaExceeded")
	}
	expiry := time.Now().Add(15 * time.Minute)
	if l.ExpiresAt.Before(expiry) {
		expiry = l.ExpiresAt
	}
	u := Upload{ID: randomID(), LinkID: l.ID, Name: name, Size: size, Status: "pending", ExpiresAt: time.Unix(expiry.Unix(), 0).UTC()}
	_, err = tx.ExecContext(ctx, `INSERT INTO uploads(id,link_id,name,size,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?)`, u.ID, u.LinkID, u.Name, u.Size, u.Status, u.ExpiresAt.Unix(), time.Now().Unix())
	if err != nil {
		return Upload{}, err
	}
	return u, tx.Commit()
}
func (s *Store) GetUpload(ctx context.Context, id, linkID string) (Upload, error) {
	var u Upload
	var expiry int64
	err := s.DB.QueryRowContext(ctx, `SELECT id,link_id,name,size,status,expires_at FROM uploads WHERE id=? AND link_id=?`, id, linkID).Scan(&u.ID, &u.LinkID, &u.Name, &u.Size, &u.Status, &expiry)
	u.ExpiresAt = time.Unix(expiry, 0).UTC()
	if errors.Is(err, sql.ErrNoRows) {
		return u, fault(404, "UPLOAD_NOT_FOUND", "errors.uploadNotFound")
	}
	return u, err
}
func (s *Store) Start(ctx context.Context, u Upload, l Link) error {
	result, err := s.DB.ExecContext(ctx, `UPDATE uploads SET status='receiving',expires_at=? WHERE id=? AND link_id=? AND status='pending' AND expires_at>? AND EXISTS(SELECT 1 FROM links WHERE id=? AND revoked=0 AND expires_at>?)`, l.ExpiresAt.Unix(), u.ID, l.ID, time.Now().Unix(), l.ID, time.Now().Unix())
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return fault(409, "UPLOAD_UNAVAILABLE", "errors.uploadUnavailable")
	}
	return nil
}
func (s *Store) Fail(ctx context.Context, id string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE uploads SET status='failed' WHERE id=? AND status IN ('pending','receiving')`, id)
	return err
}
func (s *Store) Cancel(ctx context.Context, u Upload) error {
	result, err := s.DB.ExecContext(ctx, `UPDATE uploads SET status='failed' WHERE id=? AND status IN ('pending','receiving','failed')`, u.ID)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fault(409, "UPLOAD_COMPLETE", "errors.uploadComplete")
	}
	return nil
}
