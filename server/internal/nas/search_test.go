package nas

import (
	"context"
	"encoding/xml"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func searchFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	f := &fixture{public: filepath.Join(root, "public"), data: filepath.Join(root, "data")}
	for name, body := range map[string]string{
		"root.jpg": "root", "2026/trip/a.jpg": "a", "2026/trip/b.mp4": "b", "2026/trip/readme.txt": "text",
		"2026/other/c.png": "c", "#recycle/deleted.jpg": "secret", ".hidden/private.jpg": "secret",
	} {
		publicTestFile(t, f.public, name, body)
	}
	if err := os.Symlink(filepath.Join(f.public, ".hidden"), filepath.Join(f.public, "alias")); err != nil {
		t.Fatal(err)
	}
	var err error
	f.s, err = New(f.public, f.data, []string{"https://portal.example"}, WithSecretKey(fixtureSecret))
	if err != nil {
		t.Fatal(err)
	}
	f.http = httptest.NewServer(f.s)
	t.Cleanup(func() { f.http.Close(); f.s.Close() })
	waitCatalog(t, f, "")
	return f
}
func waitCatalog(t *testing.T, f *fixture, previous string) catalogState {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		state, err := readCatalogState(context.Background(), f.s.Store.DB)
		if err == nil && state.Ready && f.s.catalogStatus(state) == "ready" && state.Revision != previous {
			return state
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("catalog did not become ready")
	return catalogState{}
}
func searchBody(scope, where, extra string, limit int) string {
	return fmt.Sprintf(`<d:searchrequest xmlns:d="DAV:" xmlns:l="%s"><d:basicsearch><d:select><d:allprop/></d:select><d:from><d:scope><d:href>%s</d:href><d:depth>infinity</d:depth></d:scope></d:from>%s<d:orderby><d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order></d:orderby><d:limit><d:nresults>%d</d:nresults></d:limit>%s</d:basicsearch></d:searchrequest>`, searchNamespace, scope, where, limit, extra)
}

const mediaWhere = `<d:where><d:or><d:like><d:prop><d:getcontenttype/></d:prop><d:literal>image/%</d:literal></d:like><d:like><d:prop><d:getcontenttype/></d:prop><d:literal>video/%</d:literal></d:like></d:or></d:where>`

func searchResult(t *testing.T, f *fixture, body string) (string, searchNode) {
	t.Helper()
	r := f.request(t, "SEARCH", "/dav/", "", strings.NewReader(body), nil)
	status(t, r, 207)
	if r.Header.Get("Content-Type") != "application/xml; charset=utf-8" || r.Header.Get("Cache-Control") != "no-store" {
		t.Fatal(r.Header)
	}
	xml := read(t, r)
	node, err := parseSearchXML([]byte(xml))
	if err != nil {
		t.Fatal(err, xml)
	}
	return xml, node
}
func nextSearchCursor(node searchNode) string {
	for _, n := range node.Children {
		if n.Name.Space == searchNamespace && n.Name.Local == "next-cursor" {
			return n.Text
		}
	}
	return ""
}

func TestSearchRecursiveStandardResultsAndOpaquePaging(t *testing.T) {
	f := searchFixture(t)
	body := searchBody("/dav/", mediaWhere, "", 2)
	first, node := searchResult(t, f, body)
	if strings.Count(first, "<d:propstat>") != 2 || !strings.Contains(first, "507 Insufficient Storage") {
		t.Fatal(first)
	}
	if strings.Contains(first, "secret") || strings.Contains(first, "private.jpg") || strings.Contains(first, "readme.txt") {
		t.Fatal(first)
	}
	cursor := nextSearchCursor(node)
	if cursor == "" {
		t.Fatal(first)
	}
	second, last := searchResult(t, f, searchBody("/dav/", mediaWhere, "<l:cursor>"+cursor+"</l:cursor>", 2))
	if strings.Count(second, "<d:propstat>") != 2 || nextSearchCursor(last) != "" {
		t.Fatal(second)
	}
	for _, name := range []string{"root.jpg", "a.jpg", "b.mp4", "c.png"} {
		if strings.Count(first+second, "<d:displayname>"+name+"</d:displayname>") != 1 {
			t.Fatal(name, first, second)
		}
	}
	_, scoped := searchResult(t, f, searchBody("/dav/2026/trip/", mediaWhere, "", 128))
	if nextSearchCursor(scoped) != "" || len(scoped.Children) != 3 {
		t.Fatal(scoped)
	} // two results plus index-state
	for _, bad := range []string{
		searchBody("/dav/2026/", mediaWhere, "<l:cursor>"+cursor+"</l:cursor>", 2),
		searchBody("/dav/", mediaWhere, "<l:cursor>tampered</l:cursor>", 2),
	} {
		status(t, f.request(t, "SEARCH", "/dav/", "", strings.NewReader(bad), nil), 409)
	}
}

func TestSearchDiscoverySchemaAndUnsupportedExtensions(t *testing.T) {
	f := searchFixture(t)
	r := f.request(t, "OPTIONS", "/dav/", "", nil, map[string]string{"Origin": "https://portal.example"})
	status(t, r, 204)
	if !strings.Contains(r.Header.Get("Allow"), "SEARCH") || r.Header.Get("DASL") != "<DAV:basicsearch>" || !strings.Contains(r.Header.Get("DAV"), searchNamespace) || !strings.Contains(r.Header.Get("Access-Control-Expose-Headers"), "DASL") {
		t.Fatal(r.Header)
	}
	r = f.request(t, "PROPFIND", "/dav/", "", strings.NewReader(`<d:propfind xmlns:d="DAV:"><d:prop><d:supported-query-grammar-set/><d:supported-method-set/></d:prop></d:propfind>`), map[string]string{"Depth": "0"})
	status(t, r, 207)
	if body := read(t, r); !strings.Contains(body, "basicsearch") || !strings.Contains(body, `name="SEARCH"`) {
		t.Fatal(body)
	}
	body := `<d:query-schema-discovery xmlns:d="DAV:"><d:basicsearch><d:from><d:scope><d:href>/dav/</d:href><d:depth>infinity</d:depth></d:scope></d:from></d:basicsearch></d:query-schema-discovery>`
	r = f.request(t, "SEARCH", "/dav/", "", strings.NewReader(body), nil)
	status(t, r, 207)
	if value := read(t, r); !strings.Contains(value, "basicsearchschema") || !strings.Contains(value, "getlastmodified") {
		t.Fatal(value)
	}
	// A client that sends no private extensions still receives ordinary DAV
	// properties and RFC 5323's standard partial-result indication.
	body = strings.ReplaceAll(searchBody("/dav/", mediaWhere, "", 1), ` xmlns:l="`+searchNamespace+`"`, "")
	value, _ := searchResult(t, f, body)
	if !strings.Contains(value, "<d:href>") || !strings.Contains(value, "507") {
		t.Fatal(value)
	}
}

func TestSearchRejectsUnsafeAndUnsupportedQueries(t *testing.T) {
	f := searchFixture(t)
	for _, scope := range []string{"/private/", "/dav/../private/", "/dav/.hidden/", "/dav/%23recycle/", "https://other.example/dav/", "/dav/alias/"} {
		status(t, f.request(t, "SEARCH", "/dav/", "", strings.NewReader(searchBody(scope, mediaWhere, "", 10)), nil), 403)
	}
	for _, body := range []string{
		`<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><d:searchrequest xmlns:d="DAV:"><d:basicsearch/></d:searchrequest>`,
		strings.Repeat("<x>", 25) + strings.Repeat("</x>", 25),
		`<d:searchrequest xmlns:d="DAV:"><d:basicsearch/><d:basicsearch/></d:searchrequest>`,
	} {
		status(t, f.request(t, "SEARCH", "/dav/", "", strings.NewReader(body), nil), 400)
	}
	status(t, f.request(t, "SEARCH", "/dav/", "", strings.NewReader(`<d:searchrequest xmlns:d="DAV:"><d:sql>select * from uploads</d:sql></d:searchrequest>`), nil), 403)
	status(t, f.request(t, "SEARCH", "/dav/", "", strings.NewReader(searchBody("/dav/", `<d:where><d:contains>private</d:contains></d:where>`, "", 10)), nil), 422)
	status(t, f.request(t, "SEARCH", "/dav/", "", strings.NewReader(strings.Repeat("x", 65537)), nil), 413)
}

func TestSearchIndexRefreshInvalidatesCursorAndNeverReturnsStalePermissions(t *testing.T) {
	f := searchFixture(t)
	_, node := searchResult(t, f, searchBody("/dav/", mediaWhere, "", 1))
	cursor := nextSearchCursor(node)
	state, _ := readCatalogState(context.Background(), f.s.Store.DB)
	publicTestFile(t, f.public, "2026/new/deep/new.jpg", "new")
	if err := os.Remove(filepath.Join(f.public, "root.jpg")); err != nil {
		t.Fatal(err)
	}
	value, _ := searchResult(t, f, searchBody("/dav/", mediaWhere, "", 128))
	if strings.Contains(value, "<d:displayname>root.jpg</d:displayname>") {
		t.Fatal("stale entry leaked", value)
	}
	f.s.requestCatalogScan()
	waitCatalog(t, f, state.Revision)
	value, _ = searchResult(t, f, searchBody("/dav/", mediaWhere, "", 128))
	if !strings.Contains(value, "new.jpg") || strings.Contains(value, "root.jpg") {
		t.Fatal(value)
	}
	status(t, f.request(t, "SEARCH", "/dav/", "", strings.NewReader(searchBody("/dav/", mediaWhere, "<l:cursor>"+cursor+"</l:cursor>", 1)), nil), 409)
}

func TestSearchNullAwareOrderingAndTypedPredicates(t *testing.T) {
	f := searchFixture(t)
	for _, desc := range []bool{false, true} {
		q := searchQuery{Scope: "", Depth: "infinity", Limit: 1, Order: []searchOrder{{Property: xml.Name{Space: "DAV:", Local: "getcontentlength"}, Descending: desc}}}
		seen := map[string]bool{}
		var ordered []catalogEntry
		for page := 0; page < 20; page++ {
			items, next, _, _, err := f.s.queryCatalog(context.Background(), q)
			if err != nil {
				t.Fatal(err)
			}
			for _, item := range items {
				if seen[item.Path] {
					t.Fatal("duplicate", item.Path)
				}
				seen[item.Path] = true
				ordered = append(ordered, item)
			}
			if next == "" {
				break
			}
			q.Cursor = next
		}
		if len(ordered) != 9 {
			t.Fatalf("expected five files and four collections: %+v", ordered)
		}
		if ordered[0].Directory == desc || ordered[len(ordered)-1].Directory != desc {
			t.Fatal("NULL ordering not preserved", desc, ordered)
		}
	}
	where := `<d:where><d:and><d:not><d:is-collection/></d:not><d:gte><d:prop><d:getcontentlength/></d:prop><d:typed-literal xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:integer" xmlns:xs="http://www.w3.org/2001/XMLSchema">4</d:typed-literal></d:gte></d:and></d:where>`
	value, _ := searchResult(t, f, searchBody("/dav/", where, "", 128))
	if !strings.Contains(value, "root.jpg") || !strings.Contains(value, "readme.txt") || strings.Contains(value, "a.jpg") {
		t.Fatal(value)
	}
	status(t, f.request(t, "SEARCH", "/dav/", "", strings.NewReader(searchBody("/dav/", `<d:where><d:eq caseless="yes"><d:prop><d:displayname/></d:prop><d:literal>A.JPG</d:literal></d:eq></d:where>`, "", 128)), nil), 422)
}

func TestCatalogPersistsAndUnchangedScansDoNotRewriteEntries(t *testing.T) {
	f := searchFixture(t)
	state, _ := readCatalogState(context.Background(), f.s.Store.DB)
	_, err := f.s.Store.DB.Exec(`CREATE TEMP TABLE catalog_audit(path TEXT);
CREATE TEMP TRIGGER catalog_audit_insert AFTER INSERT ON catalog BEGIN INSERT INTO catalog_audit VALUES(new.path); END;
CREATE TEMP TRIGGER catalog_audit_delete AFTER DELETE ON catalog BEGIN INSERT INTO catalog_audit VALUES(old.path); END;`)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.scanCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = f.s.Store.DB.QueryRow(`SELECT count(*) FROM catalog_audit`).Scan(&count); err != nil || count != 0 {
		t.Fatal("unchanged index was rewritten", count, err)
	}
	unchanged, _ := readCatalogState(context.Background(), f.s.Store.DB)
	if unchanged.Revision != state.Revision {
		t.Fatal("unchanged scan invalidated cursors")
	}
	publicTestFile(t, f.public, "2026/trip/new.jpg", "new")
	if err = f.s.scanCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = f.s.Store.DB.QueryRow(`SELECT count(*) FROM catalog_audit WHERE path='root.jpg'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("unrelated row was rewritten", count, err)
	}
	q := searchQuery{Scope: "", Depth: "infinity", Limit: 1}
	_, cursor, persisted, _, err := f.s.queryCatalog(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	f.http.Close()
	f.s.Close()
	f.s, err = New(f.public, f.data, []string{"https://portal.example"}, WithSecretKey(fixtureSecret))
	if err != nil {
		t.Fatal(err)
	}
	f.http = httptest.NewServer(f.s)
	restored, err := readCatalogState(context.Background(), f.s.Store.DB)
	if err != nil || !restored.Ready || restored.Revision != persisted.Revision {
		t.Fatal("persisted index not ready on startup", restored, err)
	}
	q.Cursor = cursor
	if _, _, _, _, err = f.s.queryCatalog(context.Background(), q); err != errSearchCursor {
		t.Fatal("cursor survived restart", err)
	}
}

func TestStandardClientReadsCappedResultsAndUnknownProperties(t *testing.T) {
	f := searchFixture(t)
	for i := 0; i < 130; i++ {
		publicTestFile(t, f.public, fmt.Sprintf("large/%03d.jpg", i), "fixture")
	}
	if err := f.s.scanCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := f.request(t, "SEARCH", "/dav/", "", strings.NewReader(searchBody("/dav/large/", mediaWhere, "", 100000)), nil)
	status(t, r, 207)
	// This client deliberately has no fields for the extension namespace.
	var standard struct {
		Responses []struct {
			Href   string `xml:"DAV: href"`
			Status string `xml:"DAV: status"`
		} `xml:"DAV: response"`
	}
	if err := xml.NewDecoder(r.Body).Decode(&standard); err != nil {
		t.Fatal(err)
	}
	if len(standard.Responses) != 129 || !strings.Contains(standard.Responses[128].Status, "507") {
		t.Fatal(standard)
	}
	query := strings.Replace(searchBody("/dav/large/", mediaWhere, "", 1), "<d:allprop/>", `<d:prop><d:displayname/><x:unknown xmlns:x="urn:test"/></d:prop>`, 1)
	value, _ := searchResult(t, f, query)
	if !strings.Contains(value, "HTTP/1.1 404 Not Found") || !strings.Contains(value, "<d:displayname>") {
		t.Fatal(value)
	}
}

func TestCatalogPortableMediaTypesAndHiddenReadBoundary(t *testing.T) {
	f := searchFixture(t)
	file, err := os.Stat(filepath.Join(f.public, "root.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"camera.HEIC": "image/heic", "clip.MOV": "video/quicktime", "camera.heif": "image/heif", "clip.mkv": "video/x-matroska"} {
		if got := catalogFile(name, file).MIME; got != want {
			t.Fatalf("%s: %s != %s", name, got, want)
		}
	}
	for _, method := range []string{"GET", "HEAD", "PROPFIND", "SEARCH", "OPTIONS"} {
		status(t, f.request(t, method, "/dav/.hidden/private.jpg", "", nil, nil), 404)
	}
}
