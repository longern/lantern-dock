package nas

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	linksReadScope            = "links:read"
	linksWriteScope           = "links:write"
	inboxReadScope            = "inbox:read"
	inboxWriteScope           = "inbox:write"
	personalUploadsPath       = adminPath + "/uploads"
	maxJSONInteger      int64 = 1<<53 - 1
)

func validID(id string) bool {
	return len(id) == 32 && strings.Trim(id, "0123456789abcdef") == ""
}

func (s *Server) serveAdmin(w http.ResponseWriter, r *http.Request) {
	var scope, allow, id string
	var thumbnail bool
	switch {
	case r.URL.Path == adminPath+"/links":
		scope, allow = linksReadScope, "GET, POST, OPTIONS"
		if r.Method == "POST" {
			scope = linksWriteScope
		}
	case strings.HasPrefix(r.URL.Path, adminPath+"/links/"):
		id = strings.TrimPrefix(r.URL.Path, adminPath+"/links/")
		if validID(id) {
			scope, allow = linksWriteScope, "DELETE, OPTIONS"
		}
	case r.URL.Path == adminPath+"/users":
		scope, allow = usersReadScope, "GET, OPTIONS"
	case strings.HasPrefix(r.URL.Path, adminPath+"/users/"):
		id = strings.TrimPrefix(r.URL.Path, adminPath+"/users/")
		if validSiteSubject(id) {
			scope, allow = usersWriteScope, "PUT, OPTIONS"
		}
	case r.URL.Path == adminPath+"/inbox":
		scope, allow = inboxReadScope, "GET, OPTIONS"
	case r.URL.Path == personalUploadsPath:
		scope, allow = inboxWriteScope, "GET, POST, OPTIONS"
	case strings.HasPrefix(r.URL.Path, personalUploadsPath+"/"):
		id = strings.TrimPrefix(r.URL.Path, personalUploadsPath+"/")
		if validID(id) {
			scope, allow = inboxWriteScope, "GET, PUT, DELETE, OPTIONS"
		}
	case strings.HasPrefix(r.URL.Path, adminPath+"/inbox/") && strings.HasSuffix(r.URL.Path, "/thumbnail"):
		id = strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, adminPath+"/inbox/"), "/thumbnail")
		if validID(id) {
			thumbnail = true
			scope, allow = inboxReadScope, "GET, OPTIONS"
		}
	case strings.HasPrefix(r.URL.Path, adminPath+"/inbox/") && strings.HasSuffix(r.URL.Path, "/download"):
		id = strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, adminPath+"/inbox/"), "/download")
		if validID(id) {
			scope, allow = inboxReadScope, "GET, HEAD, OPTIONS"
		}
	}
	if allow == "" {
		writeError(w, r, fault(404, "NOT_FOUND", "errors.notFound"))
		return
	}
	w.Header().Set("Allow", allow)
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !strings.Contains(", "+allow+", ", ", "+r.Method+", ") {
		writeError(w, r, fault(405, "METHOD_NOT_ALLOWED", "errors.methodNotAllowed"))
		return
	}
	user, err := s.identityUserScope(r, scope)
	if err == nil && user.Role != "admin" {
		err = fault(403, "ADMIN_REQUIRED", "errors.adminRequired")
	}
	if err != nil {
		writeIdentityScopeError(w, r, err, scope)
		return
	}
	owner := identityOwner(user)
	if scope == usersReadScope {
		s.listMembers(w, r, user)
		return
	}
	if scope == usersWriteScope {
		s.updateMemberPermission(w, r, user, id)
		return
	}
	if scope == inboxWriteScope {
		link, err := s.Store.personalInbox(r.Context(), owner)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if r.Method == "PUT" {
			link.ExpiresAt = time.Now().Add(24 * time.Hour)
		}
		s.serveUploadTask(w, r, link, id)
		return
	}
	if r.URL.Path == adminPath+"/links" {
		if r.Method == "POST" {
			s.createAdminLink(w, r)
		} else {
			s.listAdminLinks(w, r)
		}
		return
	}
	if scope == linksWriteScope {
		if err = s.Store.Revoke(r.Context(), id); err != nil {
			writeError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if id != "" {
		s.downloadInbox(w, r, id, owner, thumbnail)
	} else {
		s.listAdminInbox(w, r, owner)
	}
}

func (s *Server) createAdminLink(w http.ResponseWriter, r *http.Request) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, r, fault(415, "INVALID_CONTENT_TYPE", "errors.jsonRequired"))
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(15 * time.Second))
	var input struct {
		Title         string    `json:"title"`
		ExpiresAt     time.Time `json:"expiresAt"`
		MaxFileBytes  int64     `json:"maxFileBytes"`
		MaxTotalBytes int64     `json:"maxTotalBytes"`
		MaxFiles      int64     `json:"maxFiles"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.MaxFileBytes > maxJSONInteger || input.MaxTotalBytes > maxJSONInteger || input.MaxFiles > maxJSONInteger {
		writeError(w, r, fault(400, "INVALID_LINK", "errors.invalidLink"))
		return
	}
	link, token, err := s.Store.CreateLink(r.Context(), Link{Title: input.Title, ExpiresAt: input.ExpiresAt, MaxFileBytes: input.MaxFileBytes, MaxTotalBytes: input.MaxTotalBytes, MaxFiles: input.MaxFiles})
	if err != nil {
		writeError(w, r, err)
		return
	}
	// Tokens are never persisted or included in any list/get response. The
	// browser constructs the fragment-only collection URL from this one reply.
	writeJSON(w, http.StatusCreated, map[string]any{"link": link, "token": token})
}

func adminPage(r *http.Request, filter bool) (limit, offset int, linkID string, err error) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return 0, 0, "", fault(400, "INVALID_QUERY", "errors.invalidListQuery")
	}
	for key, values := range query {
		if len(values) != 1 || (key != "limit" && key != "offset" && !(filter && (key == "linkId" || key == "source"))) {
			return 0, 0, "", fault(400, "INVALID_QUERY", "errors.invalidListQuery")
		}
	}
	limit, offset = 100, 0
	if value, present := query["limit"]; present {
		limit, err = strconv.Atoi(value[0])
	}
	if err != nil || limit < 1 || limit > 200 {
		return 0, 0, "", fault(400, "INVALID_QUERY", "errors.invalidListQuery")
	}
	if value, present := query["offset"]; present {
		offset, err = strconv.Atoi(value[0])
	}
	if err != nil || offset < 0 || int64(offset) > maxJSONInteger-200 {
		return 0, 0, "", fault(400, "INVALID_QUERY", "errors.invalidListQuery")
	}
	if value, present := query["linkId"]; present {
		linkID = value[0]
		if !validID(linkID) {
			return 0, 0, "", fault(400, "INVALID_QUERY", "errors.invalidListQuery")
		}
	}
	return limit, offset, linkID, nil
}

func (s *Server) listAdminLinks(w http.ResponseWriter, r *http.Request) {
	limit, offset, _, err := adminPage(r, false)
	if err != nil {
		writeError(w, r, err)
		return
	}
	// A single SQLite statement observes link state and reserved usage together.
	now := time.Now().Unix()
	rows, err := s.Store.DB.QueryContext(r.Context(), `SELECT l.id,l.title,l.expires_at,l.max_file_bytes,l.max_total_bytes,l.max_files,l.revoked,
 (SELECT COALESCE(SUM(size),0) FROM uploads WHERE link_id=l.id AND `+usageWhere+`),
 (SELECT COUNT(*) FROM uploads WHERE link_id=l.id AND `+usageWhere+`),
 (SELECT COUNT(*) FROM uploads WHERE link_id=l.id AND status='complete')
 FROM links l WHERE l.id NOT IN (SELECT link_id FROM personal_inboxes UNION ALL SELECT link_id FROM member_grants)
 ORDER BY l.created_at DESC,l.id LIMIT ? OFFSET ?`, now, now, limit+1, offset)
	if err != nil {
		writeError(w, r, err)
		return
	}
	defer rows.Close()
	links := []Link{}
	for rows.Next() {
		var link Link
		var expires int64
		if err = rows.Scan(&link.ID, &link.Title, &expires, &link.MaxFileBytes, &link.MaxTotalBytes, &link.MaxFiles, &link.Revoked, &link.UsedBytes, &link.UsedFiles, &link.ReceivedFiles); err != nil {
			writeError(w, r, err)
			return
		}
		link.ExpiresAt = time.Unix(expires, 0).UTC()
		links = append(links, link)
	}
	if err = rows.Err(); err != nil {
		writeError(w, r, err)
		return
	}
	var next *int
	if len(links) > limit {
		value := offset + limit
		next = &value
		links = links[:limit]
	}
	writeJSON(w, 200, map[string]any{"links": links, "nextOffset": next})
}

type inboxFile struct {
	ID        string    `json:"id"`
	LinkID    string    `json:"linkId"`
	LinkTitle string    `json:"linkTitle"`
	Name      string    `json:"name"`
	Size      int64     `json:"size"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	Direct    bool      `json:"direct,omitempty"`
	Personal  bool      `json:"personal,omitempty"`
}

func (s *Server) listAdminInbox(w http.ResponseWriter, r *http.Request, owner string) {
	limit, offset, linkID, err := adminPage(r, true)
	if err != nil {
		writeError(w, r, err)
		return
	}
	source := r.URL.Query().Get("source")
	if source != "" && source != "guest" && source != "mine" {
		writeError(w, r, fault(400, "INVALID_QUERY", "errors.invalidListQuery"))
		return
	}
	rows, err := s.Store.DB.QueryContext(r.Context(), `SELECT u.id,u.link_id,l.title,u.name,u.size,u.status,u.created_at,p.owner IS NOT NULL,g.owner IS NOT NULL
 FROM uploads u JOIN links l ON l.id=u.link_id LEFT JOIN personal_inboxes p ON p.link_id=l.id
 LEFT JOIN member_grants g ON g.link_id=l.id
 WHERE u.status='complete' AND (COALESCE(p.owner,g.owner) IS NULL OR COALESCE(p.owner,g.owner)=?) AND (?='' OR u.link_id=?)
 AND (?='' OR (?='guest' AND COALESCE(p.owner,g.owner) IS NULL) OR (?='mine' AND COALESCE(p.owner,g.owner) IS NOT NULL))
 ORDER BY u.created_at DESC,u.id LIMIT ? OFFSET ?`, owner, linkID, linkID, source, source, source, limit+1, offset)
	if err != nil {
		writeError(w, r, err)
		return
	}
	defer rows.Close()
	files := []inboxFile{}
	for rows.Next() {
		var file inboxFile
		var created int64
		if err = rows.Scan(&file.ID, &file.LinkID, &file.LinkTitle, &file.Name, &file.Size, &file.Status, &created, &file.Personal, &file.Direct); err != nil {
			writeError(w, r, err)
			return
		}
		file.CreatedAt = time.Unix(created, 0).UTC()
		files = append(files, file)
	}
	if err = rows.Err(); err != nil {
		writeError(w, r, err)
		return
	}
	var next *int
	if len(files) > limit {
		value := offset + limit
		next = &value
		files = files[:limit]
	}
	writeJSON(w, 200, map[string]any{"uploads": files, "nextOffset": next})
}

func (s *Server) downloadInbox(w http.ResponseWriter, r *http.Request, id, owner string, thumbnail bool) {
	var upload Upload
	err := s.Store.DB.QueryRowContext(r.Context(), `SELECT u.id,u.link_id,u.name,u.size
 FROM uploads u LEFT JOIN personal_inboxes p ON p.link_id=u.link_id
 LEFT JOIN member_grants g ON g.link_id=u.link_id
 WHERE u.id=? AND u.status='complete' AND (COALESCE(p.owner,g.owner) IS NULL OR COALESCE(p.owner,g.owner)=?)`, id, owner).Scan(&upload.ID, &upload.LinkID, &upload.Name, &upload.Size)
	if errors.Is(err, sql.ErrNoRows) {
		err = fault(404, "UPLOAD_NOT_FOUND", "errors.uploadNotFound")
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !validID(upload.ID) || !validID(upload.LinkID) || !validName(upload.Name) {
		writeError(w, r, fault(404, "UPLOAD_NOT_FOUND", "errors.uploadNotFound"))
		return
	}
	// Reject every symlink, including links within the private root, so replacing
	// an inbox entry can never expose the database, staging files or other drops.
	file, err := s.private.Open(".")
	if err == nil {
		parts := []string{"inbox", upload.LinkID, upload.ID + "-" + upload.Name}
		for index, part := range parts {
			flags := 0
			if index < len(parts)-1 {
				flags = unix.O_DIRECTORY
			}
			var next *os.File
			next, err = openPublicChild(file, part, flags)
			file.Close()
			if err != nil {
				break
			}
			file = next
		}
	}
	if err != nil {
		writeError(w, r, fault(404, "UPLOAD_NOT_FOUND", "errors.uploadNotFound"))
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != upload.Size {
		writeError(w, r, fault(404, "UPLOAD_NOT_FOUND", "errors.uploadNotFound"))
		return
	}
	if thumbnail {
		s.inboxThumbnail(w, r, file, info, upload)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": upload.Name}))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	// ServeContent removes cache headers on some errors, including invalid ranges.
	// Reapply no-store at write time for every private response.
	http.ServeContent(davCacheWriter{w, "no-store"}, r, upload.Name, time.Time{}, file)
}

func (s *Server) inboxThumbnail(w http.ResponseWriter, r *http.Request, file *os.File, info os.FileInfo, upload Upload) {
	if info.Size() > maxImageBytes || videoSource(upload.Name) {
		writeError(w, r, fault(415, "IMAGE_UNSUPPORTED", "errors.imageUnsupported"))
		return
	}
	select {
	case s.images.requests <- struct{}{}:
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, r, fault(503, "IMAGE_BUSY", "errors.imageBusy"))
		return
	}
	defer func() { <-s.images.requests }()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	key := "private-inbox/" + upload.ID
	version := imageVersion(key, info)
	current := func() bool {
		latest, err := file.Stat()
		return err == nil && imageVersion(key, latest) == version
	}
	m, err := s.imageMetadata(ctx, file, upload.Name, version, current)
	if err != nil {
		writeError(w, r, err)
		return
	}
	size := m.sizes()[0]
	data, err := s.imageRendition(ctx, file, version, m, size, current)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !current() {
		writeError(w, r, fault(409, "IMAGE_CHANGED", "errors.imageChanged"))
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	_, _ = w.Write(data)
}
