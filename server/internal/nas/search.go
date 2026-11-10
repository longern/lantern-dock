package nas

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const searchNamespace = "urn:lantern-dock:search"
const searchPageSize = 128

type searchNode struct {
	Name       xml.Name
	Attrs      []xml.Attr
	Text       string
	Children   []searchNode
	Namespaces map[string]string `json:"-"`
}

func (n searchNode) is(name string) bool { return n.Name.Space == "DAV:" && n.Name.Local == name }
func (n searchNode) one(name string) (searchNode, error) {
	var found searchNode
	for _, child := range n.Children {
		if child.is(name) {
			if found.Name.Local != "" {
				return found, errors.New("duplicate element")
			}
			found = child
		}
	}
	if found.Name.Local == "" {
		return found, errors.New("missing element")
	}
	return found, nil
}
func parseSearchXML(data []byte) (searchNode, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var root searchNode
	stack := []*searchNode{}
	nodes := 0
	closed := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return root, err
		}
		switch value := token.(type) {
		case xml.Directive:
			return root, errors.New("XML directives are not supported")
		case xml.ProcInst:
			if value.Target != "xml" || len(stack) > 0 || closed {
				return root, errors.New("invalid processing instruction")
			}
		case xml.StartElement:
			nodes++
			if nodes > 512 || len(stack) >= 24 || closed {
				return root, errors.New("query too complex")
			}
			next := searchNode{Name: value.Name, Attrs: value.Attr}
			if len(stack) > 0 {
				next.Namespaces = stack[len(stack)-1].Namespaces
			}
			for _, attr := range value.Attr {
				if attr.Name.Space == "xmlns" || (attr.Name.Space == "" && attr.Name.Local == "xmlns") {
					if next.Namespaces == nil || len(next.Namespaces) == 0 {
						next.Namespaces = map[string]string{}
					} else {
						copy := make(map[string]string, len(next.Namespaces)+1)
						for k, v := range next.Namespaces {
							copy[k] = v
						}
						next.Namespaces = copy
					}
					prefix := attr.Name.Local
					if attr.Name.Space == "" {
						prefix = ""
					}
					next.Namespaces[prefix] = attr.Value
				}
			}
			if len(stack) == 0 {
				root = next
				stack = append(stack, &root)
			} else {
				parent := stack[len(stack)-1]
				parent.Children = append(parent.Children, next)
				stack = append(stack, &parent.Children[len(parent.Children)-1])
			}
		case xml.CharData:
			if len(stack) > 0 {
				stack[len(stack)-1].Text += string(value)
			} else if strings.TrimSpace(string(value)) != "" {
				return root, errors.New("unexpected text")
			}
		case xml.EndElement:
			stack = stack[:len(stack)-1]
			if len(stack) == 0 {
				closed = true
			}
		}
	}
	if !closed {
		return root, errors.New("missing document")
	}
	return root, nil
}

type searchOrder struct {
	Property   xml.Name
	Descending bool
}
type searchQuery struct {
	Scope, Depth string
	Properties   []xml.Name
	Where        *searchNode
	Order        []searchOrder
	Limit        int
	Cursor       string
	Refresh      bool
}

func parseSearchScope(node searchNode, r *http.Request) (string, string, error) {
	from, err := node.one("from")
	if err != nil {
		return "", "", err
	}
	if len(from.Children) != 1 || !from.Children[0].is("scope") {
		return "", "", errors.New("multiple scope")
	}
	scope := from.Children[0]
	href, err := scope.one("href")
	if err != nil {
		return "", "", err
	}
	depth, err := scope.one("depth")
	if err != nil {
		return "", "", err
	}
	d := strings.TrimSpace(depth.Text)
	if d != "0" && d != "1" && d != "infinity" {
		return "", "", errors.New("invalid depth")
	}
	u, err := url.Parse(strings.TrimSpace(href.Text))
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.IsAbs() && (u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https"))) || (!u.IsAbs() && u.Host != "") {
		return "", "", errors.New("invalid scope")
	}
	if u.Path != filesPath && !strings.HasPrefix(u.Path, filesPath+"/") {
		return "", "", errors.New("outside scope")
	}
	name := strings.Trim(strings.TrimPrefix(u.Path, filesPath), "/")
	if !publicPathAllowed(name) || strings.Contains(strings.ToLower(u.RawPath), "%2f") {
		return "", "", errors.New("invalid scope")
	}
	for _, child := range scope.Children {
		if !child.is("href") && !child.is("depth") {
			return "", "", errors.New("unsupported scope")
		}
	}
	return name, d, nil
}
func parseSearchQuery(node searchNode, r *http.Request) (searchQuery, error) {
	q := searchQuery{Limit: searchPageSize}
	var err error
	q.Scope, q.Depth, err = parseSearchScope(node, r)
	if err != nil {
		return q, err
	}
	selectNode, err := node.one("select")
	if err != nil || len(selectNode.Children) != 1 {
		return q, errors.New("invalid select")
	}
	selected := selectNode.Children[0]
	if selected.is("allprop") {
		for _, p := range searchProperties {
			q.Properties = append(q.Properties, xml.Name{Space: "DAV:", Local: p})
		}
	} else if selected.is("prop") && len(selected.Children) > 0 && len(selected.Children) <= 32 {
		for _, p := range selected.Children {
			q.Properties = append(q.Properties, p.Name)
		}
	} else {
		return q, errors.New("invalid properties")
	}
	seen := map[xml.Name]bool{}
	for _, child := range node.Children {
		if seen[child.Name] {
			return q, errors.New("duplicate clause")
		}
		seen[child.Name] = true
		if child.Name.Space == searchNamespace {
			switch child.Name.Local {
			case "cursor":
				q.Cursor = strings.TrimSpace(child.Text)
				if len(q.Cursor) > 8192 || len(child.Children) > 0 {
					return q, errors.New("invalid cursor")
				}
			case "refresh":
				if len(child.Children) > 0 || strings.TrimSpace(child.Text) != "" {
					return q, errors.New("invalid refresh")
				}
				q.Refresh = true
			default:
				return q, errors.New("unsupported search extension")
			}
			continue
		}
		if child.Name.Space != "DAV:" {
			continue
		}
		switch child.Name.Local {
		case "select", "from":
		case "where":
			if len(child.Children) != 1 {
				return q, errors.New("invalid condition")
			}
			value := child.Children[0]
			q.Where = &value
		case "limit":
			n, err := child.one("nresults")
			if err != nil || len(child.Children) != 1 {
				return q, errors.New("invalid limit")
			}
			limit, err := strconv.Atoi(strings.TrimSpace(n.Text))
			if err != nil || limit < 0 {
				return q, errors.New("invalid limit")
			}
			q.Limit = min(limit, searchPageSize)
		case "orderby":
			if len(child.Children) == 0 || len(child.Children) > 3 {
				return q, errors.New("invalid order")
			}
			for _, order := range child.Children {
				if unsupportedCaseless(order) {
					return q, errSearchQuery
				}
				if !order.is("order") || len(order.Children) < 1 || len(order.Children) > 2 {
					return q, errors.New("unsupported order")
				}
				prop, err := order.one("prop")
				if err != nil || len(prop.Children) != 1 {
					return q, errors.New("invalid order property")
				}
				desc := false
				for _, direction := range order.Children {
					if direction.is("descending") {
						desc = true
					} else if !direction.is("ascending") && !direction.is("prop") {
						return q, errors.New("invalid order direction")
					}
				}
				q.Order = append(q.Order, searchOrder{Property: prop.Children[0].Name, Descending: desc})
			}
		default:
			return q, errors.New("unsupported clause")
		}
	}
	return q, nil
}

func searchEscape(value string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(value))
	return b.String()
}
func searchError(w http.ResponseWriter, status int, condition string) {
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(status)
	if condition != "" {
		_, _ = fmt.Fprintf(w, `<d:error xmlns:d="DAV:" xmlns:l="%s"><%s/></d:error>`, searchNamespace, condition)
	} else {
		_, _ = fmt.Fprintf(w, `<d:error xmlns:d="DAV:"><d:responsedescription>%s</d:responsedescription></d:error>`, http.StatusText(status))
	}
}

type searchCursor struct {
	Revision, Query string
	Values          []json.RawMessage
}

func (s *Server) encodeSearchCursor(cursor searchCursor) string {
	data, _ := json.Marshal(cursor)
	mac := hmac.New(sha256.New, s.catalogKey)
	mac.Write(data)
	return base64.RawURLEncoding.EncodeToString(data) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (s *Server) decodeSearchCursor(token string) (searchCursor, error) {
	var cursor searchCursor
	body, signature, ok := strings.Cut(token, ".")
	if !ok {
		return cursor, errors.New("invalid cursor")
	}
	data, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return cursor, err
	}
	code, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return cursor, err
	}
	mac := hmac.New(sha256.New, s.catalogKey)
	mac.Write(data)
	if !hmac.Equal(code, mac.Sum(nil)) {
		return cursor, errors.New("invalid cursor")
	}
	err = json.Unmarshal(data, &cursor)
	return cursor, err
}

func (s *Server) serveSearch(w http.ResponseWriter, r *http.Request) {
	select {
	case s.searchRequests <- struct{}{}:
		defer func() { <-s.searchRequests }()
	default:
		w.Header().Set("Retry-After", "1")
		searchError(w, 503, "")
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(15 * time.Second))
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		searchError(w, 413, "")
		return
	}
	root, err := parseSearchXML(data)
	if err != nil || len(root.Children) != 1 {
		searchError(w, 400, "")
		return
	}
	if !root.is("searchrequest") && !root.is("query-schema-discovery") {
		searchError(w, 400, "")
		return
	}
	grammar := root.Children[0]
	if !grammar.is("basicsearch") {
		searchError(w, 403, "d:search-grammar-supported")
		return
	}
	if root.is("query-schema-discovery") {
		s.serveSearchSchema(w, r, grammar)
		return
	}
	query, err := parseSearchQuery(grammar, r)
	if err != nil {
		condition := ""
		status := 400
		if errors.Is(err, errSearchQuery) {
			status = 422
		}
		if strings.Contains(err.Error(), "scope") || strings.Contains(err.Error(), "depth") {
			status = 403
			condition = "d:search-scope-valid"
		}
		if err.Error() == "multiple scope" {
			condition = "d:search-multiple-scope-supported"
		}
		searchError(w, status, condition)
		return
	}
	file, err := (publicFS{s.public}).open(query.Scope)
	if err != nil {
		searchError(w, 403, "d:search-scope-valid")
		return
	}
	file.Close()
	if query.Refresh && query.Cursor == "" {
		s.requestCatalogScan()
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	items, next, state, partial, err := s.queryCatalog(ctx, query)
	if err != nil {
		switch {
		case errors.Is(err, errSearchCursor):
			searchError(w, 409, "l:valid-cursor")
		case errors.Is(err, errSearchQuery):
			searchError(w, 422, "")
		default:
			searchError(w, 503, "")
		}
		return
	}
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(207)
	_, _ = fmt.Fprintf(w, `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:l="%s">`, searchNamespace)
	for _, item := range items {
		writeSearchEntry(w, item, query.Properties)
	}
	if partial {
		_, _ = fmt.Fprintf(w, `<d:response><d:href>%s</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status><d:responsedescription>Partial search results</d:responsedescription></d:response>`, searchEscape(r.URL.EscapedPath()))
	}
	if next != "" {
		_, _ = fmt.Fprintf(w, `<l:next-cursor>%s</l:next-cursor>`, searchEscape(next))
	}
	_, _ = fmt.Fprintf(w, `<l:index-state><l:status>%s</l:status><l:revision>%s</l:revision>`, s.catalogStatus(state), state.Revision)
	if state.Updated != 0 {
		_, _ = fmt.Fprintf(w, `<l:updated>%s</l:updated>`, time.Unix(state.Updated, 0).UTC().Format(time.RFC3339))
	}
	_, _ = io.WriteString(w, `</l:index-state></d:multistatus>`)
}

var searchProperties = []string{"displayname", "resourcetype", "getcontentlength", "getlastmodified", "getcontenttype", "getetag"}

func writeSearchEntry(w io.Writer, item catalogEntry, selected []xml.Name) {
	href := publicHref(item.Path)
	if item.Directory && !strings.HasSuffix(href, "/") {
		href += "/"
	}
	_, _ = fmt.Fprintf(w, `<d:response><d:href>%s</d:href>`, searchEscape(href))
	var missing []xml.Name
	_, _ = io.WriteString(w, `<d:propstat><d:prop>`)
	for _, prop := range selected {
		if prop.Space != "DAV:" || !strings.Contains("|"+strings.Join(searchProperties, "|")+"|", "|"+prop.Local+"|") || (prop.Local == "getcontentlength" && item.Directory) {
			missing = append(missing, prop)
			continue
		}
		_, _ = fmt.Fprintf(w, `<d:%s>`, prop.Local)
		value := ""
		switch prop.Local {
		case "displayname":
			value = item.Name
		case "getcontenttype":
			value = item.MIME
		case "getcontentlength":
			value = strconv.FormatInt(item.Size, 10)
		case "getlastmodified":
			value = time.Unix(0, item.ModifiedNS).UTC().Format(http.TimeFormat)
		case "getetag":
			value = fmt.Sprintf(`"%x%x"`, item.ModifiedNS, item.Size)
		case "resourcetype":
			if item.Directory {
				_, _ = io.WriteString(w, `<d:collection/>`)
			}
		}
		_, _ = io.WriteString(w, searchEscape(value))
		_, _ = fmt.Fprintf(w, `</d:%s>`, prop.Local)
	}
	_, _ = io.WriteString(w, `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`)
	if len(missing) > 0 {
		_, _ = io.WriteString(w, `<d:propstat><d:prop>`)
		encoder := xml.NewEncoder(w)
		for _, name := range missing {
			_ = encoder.EncodeElement("", xml.StartElement{Name: name})
		}
		_ = encoder.Flush()
		_, _ = io.WriteString(w, `</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`)
	}
	_, _ = io.WriteString(w, `</d:response>`)
}

func (s *Server) serveSearchSchema(w http.ResponseWriter, r *http.Request, node searchNode) {
	scope, _, err := parseSearchScope(node, r)
	if err != nil {
		searchError(w, 403, "d:search-scope-valid")
		return
	}
	f, err := (publicFS{s.public}).open(scope)
	if err != nil {
		searchError(w, 403, "d:search-scope-valid")
		return
	}
	f.Close()
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(207)
	_, _ = fmt.Fprintf(w, `<d:multistatus xmlns:d="DAV:"><d:response><d:href>%s</d:href><d:status>HTTP/1.1 200 OK</d:status><d:query-schema><d:basicsearchschema><d:properties>`, searchEscape(r.URL.EscapedPath()))
	for _, name := range searchProperties {
		_, _ = fmt.Fprintf(w, `<d:propdesc><d:prop><d:%s/></d:prop>`, name)
		kind := "string"
		if name == "getcontentlength" {
			kind = "nonNegativeInteger"
		}
		if name == "getlastmodified" {
			kind = "dateTime"
		}
		if name != "resourcetype" {
			_, _ = fmt.Fprintf(w, `<d:datatype><xs:%s xmlns:xs="http://www.w3.org/2001/XMLSchema"/></d:datatype>`, kind)
		}
		_, _ = io.WriteString(w, `<d:selectable/>`)
		if name != "resourcetype" {
			_, _ = io.WriteString(w, `<d:searchable/><d:sortable/>`)
		}
		_, _ = io.WriteString(w, `</d:propdesc>`)
	}
	_, _ = io.WriteString(w, `</d:properties><d:operators><d:opdesc><d:like/><d:prop/><d:literal/></d:opdesc><d:opdesc><d:language-defined/><d:prop/></d:opdesc><d:opdesc><d:language-matches/><d:prop/><d:literal/></d:opdesc></d:operators></d:basicsearchschema></d:query-schema></d:response></d:multistatus>`)
}
