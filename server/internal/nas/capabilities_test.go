package nas

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
)

func TestCapabilitiesAdvertiseWorkingRoutesWithoutGrantingAccess(t *testing.T) {
	for _, identity := range []bool{false, true} {
		t.Run(strconv.FormatBool(identity), func(t *testing.T) {
			f := newFixture(t)
			if identity {
				if err := f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: "https://portal.example"}); err != nil {
					t.Fatal(err)
				}
			}
			r := f.request(t, "GET", "/api/capabilities", "", nil, nil)
			status(t, r, http.StatusOK)
			var document struct {
				Version  int                          `json:"version"`
				Services map[string]serviceCapability `json:"services"`
			}
			if err := json.NewDecoder(r.Body).Decode(&document); err != nil {
				t.Fatal(err)
			}
			if document.Version != 1 || len(document.Services) != 5 {
				t.Fatalf("unexpected capabilities: %+v", document)
			}
			want := map[string]serviceCapability{
				"files":   {Protocol: "webdav", Version: 1, Href: "/dav/", Enabled: true, ReadOnly: true},
				"images":  {Protocol: "http://iiif.io/api/image", Version: 3, Href: imagesPath, Enabled: true},
				"inbox":   {Protocol: "lantern-dock-inbox", Version: 1, Href: "/api/uploads", Enabled: true},
				"admin":   {Protocol: "lantern-dock-admin", Version: 1, Href: adminPath, Enabled: identity},
				"account": {Protocol: "lantern-dock-identity", Version: 2, Href: "/api/account", Enabled: identity},
			}
			for name, service := range want {
				if document.Services[name] != service {
					t.Fatalf("%s = %+v, want %+v", name, document.Services[name], service)
				}
			}
			status(t, f.request(t, "PROPFIND", document.Services["files"].Href, "", nil, map[string]string{"Depth": "1"}), 207)
			status(t, f.request(t, "GET", document.Services["inbox"].Href, "", nil, nil), 401)
			accountStatus := 503
			if identity {
				accountStatus = 401
			}
			status(t, f.request(t, "GET", document.Services["account"].Href, "", nil, nil), accountStatus)
		})
	}
}

func TestCapabilitiesCacheMethodsAndOriginPolicy(t *testing.T) {
	f := newFixture(t)
	headers := map[string]string{"Origin": "https://portal.example"}
	r := f.request(t, "GET", "/api/capabilities", "", nil, headers)
	status(t, r, 200)
	body := read(t, r)
	etag := r.Header.Get("ETag")
	if etag == "" || r.Header.Get("Cache-Control") != "public, max-age=300" || r.Header.Get("Access-Control-Allow-Origin") != headers["Origin"] {
		t.Fatal("missing cache or origin headers", r.Header)
	}
	anonymous := f.request(t, "GET", "/api/capabilities", "", nil, nil)
	status(t, anonymous, 200)
	if anonymous.Header.Get("Vary") != "Origin" || anonymous.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("anonymous cached metadata must still vary by Origin")
	}
	head := f.request(t, "HEAD", "/api/capabilities", "", nil, headers)
	status(t, head, 200)
	if head.ContentLength != int64(len(body)) || read(t, head) != "" || head.Header.Get("ETag") != etag {
		t.Fatal("HEAD differs from GET")
	}
	status(t, f.request(t, "GET", "/api/capabilities", "", nil, map[string]string{"If-None-Match": etag}), 304)
	status(t, f.request(t, "OPTIONS", "/api/capabilities", "", nil, headers), 204)
	for _, method := range []string{"POST", "PUT", "DELETE", "PROPFIND"} {
		r = f.request(t, method, "/api/capabilities", "", nil, nil)
		status(t, r, 405)
		if r.Header.Get("Allow") != "GET, HEAD, OPTIONS" || r.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("method error must not be cached")
		}
	}
	status(t, f.request(t, "GET", "/api/capabilities", "", nil, map[string]string{"Origin": "https://untrusted.example"}), 403)
	for _, path := range []string{"/api/capabilities/private", "/api/unknown", "/data/lantern-dock.sqlite"} {
		status(t, f.request(t, "GET", path, "", nil, nil), 404)
	}
	if err := f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: "https://portal.example"}); err != nil {
		t.Fatal(err)
	}
	r = f.request(t, "GET", "/api/capabilities", "", nil, map[string]string{"If-None-Match": etag})
	status(t, r, 200)
	if r.Header.Get("ETag") == etag {
		t.Fatal("changed capabilities must invalidate the validator")
	}
}
