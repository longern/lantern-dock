package nas

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// These are URL paths, not filesystem paths or the bridge's session endpoint.
const (
	filesPath        = "/dav"
	inboxPath        = "/api/uploads"
	accountPath      = "/api/account"
	adminPath        = "/api/admin"
	capabilitiesPath = "/api/capabilities"
	imagesPath       = "/api/iiif/3"
)

type serviceCapability struct {
	Protocol string `json:"protocol"`
	Version  int    `json:"version"`
	Href     string `json:"href"`
	Enabled  bool   `json:"enabled"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

func (s *Server) serveCapabilities(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", "GET, HEAD, OPTIONS")
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		writeError(w, r, fault(405, "METHOD_NOT_ALLOWED", "errors.capabilitiesReadOnly"))
		return
	}
	// Only deployment capabilities are public. This is never a permission grant
	// and contains no users, credentials, collection links or filesystem paths.
	document := struct {
		Version  int                          `json:"version"`
		Services map[string]serviceCapability `json:"services"`
	}{1, map[string]serviceCapability{
		"files":   {Protocol: "webdav", Version: 1, Href: filesPath + "/", Enabled: true, ReadOnly: true},
		"inbox":   {Protocol: "lantern-dock-inbox", Version: 1, Href: inboxPath, Enabled: true},
		"admin":   {Protocol: "lantern-dock-admin", Version: 1, Href: adminPath, Enabled: s.identity != nil},
		"account": {Protocol: "lantern-dock-identity", Version: 2, Href: accountPath, Enabled: s.identity != nil},
		"images":  {Protocol: "http://iiif.io/api/image", Version: 3, Href: imagesPath, Enabled: true},
	}}
	body, _ := json.Marshal(document)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("ETag", fmt.Sprintf(`"%x"`, sha256.Sum256(body)))
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
}
