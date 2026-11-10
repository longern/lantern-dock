package nas

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	usersReadScope   = "users:read"
	usersWriteScope  = "users:write"
	memberUploadPath = accountPath + "/uploads"
)

type memberPermission struct {
	Enabled      bool  `json:"enabled"`
	MaxFiles     int64 `json:"maxFiles"`
	MaxFileBytes int64 `json:"maxFileBytes"`
}

type managedMember struct {
	Sub               string           `json:"sub"`
	Name              string           `json:"name"`
	Admin             bool             `json:"admin"`
	Permission        memberPermission `json:"permission"`
	AssignedElsewhere bool             `json:"assignedElsewhere"`
}

func identityOwner(user IdentityUser) string { return user.Issuer + "\x00" + user.Sub }

func (s *Store) rememberMember(ctx context.Context, user IdentityUser) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO nas_members(issuer,sub,name) VALUES(?,?,?)
 ON CONFLICT(issuer,sub) DO UPDATE SET name=excluded.name WHERE name!=excluded.name`, user.Issuer, user.Sub, user.Name)
	return err
}

func (s *Server) listMembers(w http.ResponseWriter, r *http.Request, actor IdentityUser) {
	query := r.URL.Query()
	term, filter, sub := strings.TrimSpace(query.Get("q")), query.Get("enabled"), query.Get("sub")
	if len(term) > 256 || (filter != "" && filter != "1") || (sub != "" && !validSiteSubject(sub)) {
		writeError(w, r, fault(400, "INVALID_QUERY", "errors.invalidListQuery"))
		return
	}
	query.Del("q")
	query.Del("enabled")
	query.Del("sub")
	urlCopy := *r.URL
	urlCopy.RawQuery = query.Encode()
	copy := *r
	copy.URL = &urlCopy
	limit, offset, _, err := adminPage(&copy, false)
	if err != nil {
		writeError(w, r, err)
		return
	}
	owner := identityOwner(actor)
	rows, err := s.Store.DB.QueryContext(r.Context(), `SELECT m.sub,m.name,
 COALESCE(ours.revoked=0,0),COALESCE(ours.max_files,100),COALESCE(ours.max_file_bytes,104857600),
 EXISTS(SELECT 1 FROM member_grants a JOIN links l ON l.id=a.link_id
  WHERE a.issuer=m.issuer AND a.member=m.sub AND a.owner!=? AND l.revoked=0)
 FROM nas_members m LEFT JOIN member_grants g ON g.issuer=m.issuer AND g.member=m.sub AND g.owner=?
 LEFT JOIN links ours ON ours.id=g.link_id
 WHERE m.issuer=? AND (?='' OR m.sub=?) AND (?='' OR instr(lower(m.name),lower(?))>0 OR instr(m.sub,?)>0)
 AND (?='' OR ours.revoked=0)
 ORDER BY m.name COLLATE NOCASE,m.sub LIMIT ? OFFSET ?`, owner, owner, actor.Issuer, sub, sub, term, term, term, filter, limit+1, offset)
	if err != nil {
		writeError(w, r, err)
		return
	}
	defer rows.Close()
	items := []managedMember{}
	for rows.Next() {
		var m managedMember
		if err := rows.Scan(&m.Sub, &m.Name, &m.Permission.Enabled, &m.Permission.MaxFiles, &m.Permission.MaxFileBytes, &m.AssignedElsewhere); err != nil {
			writeError(w, r, err)
			return
		}
		m.Admin = s.identity.admins[m.Sub]
		items = append(items, m)
	}
	if err := rows.Err(); err != nil {
		writeError(w, r, err)
		return
	}
	var next *int
	if len(items) > limit {
		value := offset + limit
		next = &value
		items = items[:limit]
	}
	writeJSON(w, 200, map[string]any{"users": items, "nextOffset": next})
}

func (s *Server) updateMemberPermission(w http.ResponseWriter, r *http.Request, actor IdentityUser, sub string) {
	if s.identity.admins[sub] {
		writeError(w, r, fault(409, "MEMBER_IS_ADMIN", "errors.memberIsAdmin"))
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(15 * time.Second))
	var input struct {
		Enabled      *bool `json:"enabled"`
		MaxFiles     int64 `json:"maxFiles"`
		MaxFileBytes int64 `json:"maxFileBytes"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.Enabled == nil || input.MaxFiles < 1 || input.MaxFiles > 10000 || input.MaxFileBytes < 1 || input.MaxFileBytes > 1<<30 {
		writeError(w, r, fault(400, "INVALID_LIMITS", "errors.invalidLink"))
		return
	}
	ids, err := s.Store.setMemberPermission(r.Context(), actor, sub, memberPermission{*input.Enabled, input.MaxFiles, input.MaxFileBytes})
	if err != nil {
		writeError(w, r, err)
		return
	}
	s.mu.Lock()
	for _, id := range ids {
		if cancel := s.active[id]; cancel != nil {
			cancel()
		}
	}
	s.mu.Unlock()
	w.WriteHeader(204)
}

func (s *Store) setMemberPermission(ctx context.Context, actor IdentityUser, sub string, p memberPermission) ([]string, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	owner := identityOwner(actor)
	var name string
	if err = tx.QueryRowContext(ctx, `SELECT name FROM nas_members WHERE issuer=? AND sub=?`, actor.Issuer, sub).Scan(&name); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = fault(404, "MEMBER_NOT_FOUND", "errors.notFound")
		}
		return nil, err
	}
	if p.Enabled {
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM member_grants g JOIN links l ON l.id=g.link_id
 WHERE g.issuer=? AND g.member=? AND g.owner!=? AND l.revoked=0)`, actor.Issuer, sub, owner).Scan(&exists); err != nil {
			return nil, err
		}
		if exists {
			return nil, fault(409, "MEMBER_ALREADY_ASSIGNED", "errors.memberAlreadyAssigned")
		}
	}
	if name == "" {
		name = sub
	}
	var id string
	err = tx.QueryRowContext(ctx, `SELECT link_id FROM member_grants WHERE issuer=? AND member=? AND owner=?`, actor.Issuer, sub, owner).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		id = randomID()
		_, err = tx.ExecContext(ctx, `INSERT INTO links
 (id,token_hash,title,expires_at,max_file_bytes,max_total_bytes,max_files,revoked,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
			id, []byte("member:"+id), name, privateInboxExpiry.Unix(), p.MaxFileBytes, maxJSONInteger, p.MaxFiles, !p.Enabled, time.Now().Unix())
		if err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO member_grants(issuer,member,owner,grantor,link_id) VALUES(?,?,?,?,?)`, actor.Issuer, sub, owner, actor.Sub, id)
		if err != nil {
			return nil, err
		}
		return nil, tx.Commit()
	}
	if err != nil {
		return nil, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE links SET title=?,revoked=?,max_file_bytes=?,max_files=?
 WHERE id=? AND (revoked!=? OR max_file_bytes!=? OR max_files!=?)`, name, !p.Enabled, p.MaxFileBytes, p.MaxFiles, id, !p.Enabled, p.MaxFileBytes, p.MaxFiles)
	if err != nil {
		return nil, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return nil, tx.Commit()
	}
	// Invalidate unfinished reservations atomically with a changed permission,
	// including streams still starting and immediately re-enabled grants.
	rows, err := tx.QueryContext(ctx, `UPDATE uploads SET status='failed'
 WHERE link_id=? AND status IN ('pending','receiving') RETURNING id`, id)
	if err != nil {
		return nil, err
	}
	var cancelled []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		cancelled = append(cancelled, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	return cancelled, tx.Commit()
}

func (s *Server) memberLink(ctx context.Context, user IdentityUser) (Link, error) {
	link, err := scanLink(s.Store.DB.QueryRowContext(ctx, `SELECT `+linkColumns+` FROM links WHERE id IN (
 SELECT g.link_id FROM member_grants g WHERE g.issuer=? AND g.member=?)
 AND revoked=0`, user.Issuer, user.Sub))
	if err != nil {
		return link, err
	}
	var grantor string
	if err = s.Store.DB.QueryRowContext(ctx, `SELECT grantor FROM member_grants WHERE link_id=?`, link.ID).Scan(&grantor); err != nil {
		return link, err
	}
	if !s.identity.admins[grantor] {
		return Link{}, sql.ErrNoRows
	}
	return link, nil
}

func (s *Server) serveMemberUploads(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, memberUploadPath)
	allow := "GET, POST, OPTIONS"
	if id != "" {
		if !strings.HasPrefix(id, "/") || !validID(id[1:]) {
			writeError(w, r, fault(404, "UPLOAD_NOT_FOUND", "errors.uploadNotFound"))
			return
		}
		id = id[1:]
		allow = "GET, PUT, DELETE, OPTIONS"
	}
	w.Header().Set("Allow", allow)
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if !strings.Contains(", "+allow+", ", ", "+r.Method+", ") {
		writeError(w, r, fault(405, "METHOD_NOT_ALLOWED", "errors.methodNotAllowed"))
		return
	}
	user, err := s.identityUserScope(r, inboxWriteScope)
	if err != nil {
		writeIdentityScopeError(w, r, err, inboxWriteScope)
		return
	}
	link, err := s.memberLink(r.Context(), user)
	if errors.Is(err, sql.ErrNoRows) {
		err = fault(403, "DEPOSIT_REQUIRED", "errors.depositRequired")
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	if r.Method == "PUT" {
		link.ExpiresAt = time.Now().Add(24 * time.Hour)
	}
	s.serveUploadTask(w, r, link, id)
}
