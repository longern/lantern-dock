package nas

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var errSearchQuery = errors.New("unsupported search query")
var errSearchCursor = errors.New("expired or invalid search cursor")

type searchField struct{ SQL, Kind string }

func searchColumn(name xml.Name) searchField {
	if name.Space != "DAV:" {
		return searchField{"NULL", "null"}
	}
	switch name.Local {
	case "displayname":
		return searchField{"name", "string"}
	case "getcontenttype":
		return searchField{"mime", "string"}
	case "getcontentlength":
		return searchField{"CASE WHEN directory=0 THEN size END", "integer"}
	case "getlastmodified":
		return searchField{"modified_ns", "date"}
	case "getetag":
		return searchField{`printf('"%x%x"',modified_ns,size)`, "string"}
	case "resourcetype":
		return searchField{"directory", "type"}
	}
	return searchField{"NULL", "null"}
}
func unsupportedCaseless(node searchNode) bool {
	for _, attr := range node.Attrs {
		if attr.Name.Space == "" && attr.Name.Local == "caseless" && attr.Value != "no" {
			return true
		}
	}
	return false
}
func searchProperty(node searchNode) (searchField, error) {
	if !node.is("prop") || len(node.Children) != 1 {
		return searchField{}, errSearchQuery
	}
	return searchColumn(node.Children[0].Name), nil
}
func searchLiteral(node searchNode, field searchField) (any, error) {
	if (!node.is("literal") && !node.is("typed-literal")) || len(node.Children) != 0 {
		return nil, errSearchQuery
	}
	if node.is("typed-literal") {
		qualified := ""
		for _, attr := range node.Attrs {
			if attr.Name.Space == "http://www.w3.org/2001/XMLSchema-instance" && attr.Name.Local == "type" {
				qualified = attr.Value
			}
		}
		prefix, name, ok := strings.Cut(qualified, ":")
		if !ok {
			prefix, name = "", qualified
		}
		if node.Namespaces[prefix] != "http://www.w3.org/2001/XMLSchema" {
			return nil, errSearchQuery
		}
		kind := ""
		switch name {
		case "integer", "nonNegativeInteger":
			kind = "integer"
		case "dateTime":
			kind = "date"
		case "string":
			kind = "string"
		default:
			return nil, errSearchQuery
		}
		if field.Kind != "null" && field.Kind != kind {
			return nil, errSearchQuery
		}
		field.Kind = kind
		if name == "nonNegativeInteger" {
			value, err := strconv.ParseInt(strings.TrimSpace(node.Text), 10, 64)
			if err != nil || value < 0 {
				return nil, errSearchQuery
			}
		}
	}
	switch field.Kind {
	case "integer":
		value, err := strconv.ParseInt(strings.TrimSpace(node.Text), 10, 64)
		return value, err
	case "date":
		value, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(node.Text))
		if err != nil {
			value, err = http.ParseTime(strings.TrimSpace(node.Text))
		}
		if err != nil || value.Year() < 1678 || value.Year() > 2261 {
			return nil, errSearchQuery
		}
		return value.UnixNano(), nil
	case "type":
		return nil, errSearchQuery
	default:
		return node.Text, nil
	}
}
func searchGlob(pattern string) (string, error) {
	var out strings.Builder
	escaped := false
	for _, c := range pattern {
		if !escaped {
			switch c {
			case '\\':
				escaped = true
				continue
			case '%':
				out.WriteByte('*')
				continue
			case '_':
				out.WriteByte('?')
				continue
			}
		}
		switch c {
		case '*':
			out.WriteString("[*]")
		case '?':
			out.WriteString("[?]")
		case '[':
			out.WriteString("[[]")
		case ']':
			out.WriteString("[]]")
		default:
			out.WriteRune(c)
		}
		escaped = false
	}
	if escaped {
		return "", errSearchQuery
	}
	return out.String(), nil
}
func compileSearchPredicate(node searchNode) (string, []any, error) {
	if node.Name.Space != "DAV:" || unsupportedCaseless(node) {
		return "", nil, errSearchQuery
	}
	operator := node.Name.Local
	if operator == "and" || operator == "or" || operator == "not" {
		if len(node.Children) == 0 || (operator == "not" && len(node.Children) != 1) {
			return "", nil, errSearchQuery
		}
		var sql []string
		var args []any
		for _, child := range node.Children {
			text, values, err := compileSearchPredicate(child)
			if err != nil {
				return "", nil, err
			}
			sql = append(sql, "("+text+")")
			args = append(args, values...)
		}
		if operator == "not" {
			return "NOT " + sql[0], args, nil
		}
		return strings.Join(sql, " "+strings.ToUpper(operator)+" "), args, nil
	}
	if operator == "is-collection" && len(node.Children) == 0 {
		return "directory=1", nil, nil
	}
	if operator == "is-defined" || operator == "language-defined" || operator == "language-matches" {
		count := 1
		if operator == "language-matches" {
			count = 2
		}
		if len(node.Children) != count {
			return "", nil, errSearchQuery
		}
		field, err := searchProperty(node.Children[0])
		if err != nil {
			return "", nil, err
		}
		if operator == "is-defined" {
			return field.SQL + " IS NOT NULL", nil, nil
		}
		if operator == "language-matches" && !node.Children[1].is("literal") {
			return "", nil, errSearchQuery
		}
		return "CASE WHEN " + field.SQL + " IS NOT NULL THEN 0 END", nil, nil
	}
	if len(node.Children) != 2 {
		return "", nil, errSearchQuery
	}
	field, err := searchProperty(node.Children[0])
	if err != nil {
		return "", nil, err
	}
	value, err := searchLiteral(node.Children[1], field)
	if err != nil {
		return "", nil, errSearchQuery
	}
	if operator == "like" {
		if field.Kind != "string" && field.Kind != "null" {
			return "", nil, errSearchQuery
		}
		pattern, err := searchGlob(fmt.Sprint(value))
		if err != nil {
			return "", nil, err
		}
		return field.SQL + " GLOB ?", []any{pattern}, nil
	}
	ops := map[string]string{"eq": "=", "lt": "<", "lte": "<=", "gt": ">", "gte": ">="}
	comparison, ok := ops[operator]
	if !ok {
		return "", nil, errSearchQuery
	}
	return field.SQL + comparison + "?", []any{value}, nil
}

type catalogSort struct {
	searchField
	Descending bool
}

func searchCursorValue(raw json.RawMessage, field searchField) (any, error) {
	if string(raw) == "null" {
		return nil, nil
	}
	if field.Kind == "integer" || field.Kind == "date" {
		var value int64
		err := json.Unmarshal(raw, &value)
		return value, err
	}
	if field.Kind == "null" {
		return nil, errSearchCursor
	}
	var value string
	err := json.Unmarshal(raw, &value)
	return value, err
}
func (s *Server) queryCatalog(ctx context.Context, q searchQuery) ([]catalogEntry, string, catalogState, bool, error) {
	var state catalogState
	where := "1"
	args := []any{}
	switch q.Depth {
	case "0":
		where = "path=?"
		args = append(args, q.Scope)
	case "1":
		where = "(path=? OR parent=?)"
		args = append(args, q.Scope, q.Scope)
	case "infinity":
		if q.Scope != "" {
			// '/' sorts immediately before '0', so this bounded range covers
			// the subtree and can use the path index even for very large catalogs.
			where = "(path=? OR (path>=? AND path<?))"
			args = append(args, q.Scope, q.Scope+"/", q.Scope+"0")
		}
	default:
		return nil, "", state, false, errSearchQuery
	}
	if q.Where != nil {
		predicate, values, err := compileSearchPredicate(*q.Where)
		if err != nil {
			return nil, "", state, false, errSearchQuery
		}
		where += " AND (" + predicate + ")"
		args = append(args, values...)
	}
	sorts := []catalogSort{}
	for _, order := range q.Order {
		field := searchColumn(order.Property)
		if field.Kind == "type" {
			return nil, "", state, false, errSearchQuery
		}
		sorts = append(sorts, catalogSort{field, order.Descending})
	}
	sorts = append(sorts, catalogSort{searchField{"path", "string"}, false})
	fingerprint := q
	fingerprint.Cursor = ""
	fingerprint.Refresh = false
	encoded, _ := json.Marshal(fingerprint)
	digest := fmt.Sprintf("%x", sha256.Sum256(encoded))
	var cursor searchCursor
	if q.Cursor != "" {
		var err error
		cursor, err = s.decodeSearchCursor(q.Cursor)
		if err != nil || cursor.Query != digest || len(cursor.Values) != len(sorts) {
			return nil, "", state, false, errSearchCursor
		}
		var alternatives []string
		for i, sort := range sorts {
			parts := []string{}
			for j := 0; j < i; j++ {
				value, err := searchCursorValue(cursor.Values[j], sorts[j].searchField)
				if err != nil {
					return nil, "", state, false, errSearchCursor
				}
				parts = append(parts, sorts[j].SQL+" IS ?")
				args = append(args, value)
			}
			value, err := searchCursorValue(cursor.Values[i], sort.searchField)
			if err != nil {
				return nil, "", state, false, errSearchCursor
			}
			comparison := sort.SQL + ">?"
			if sort.Descending {
				comparison = "(" + sort.SQL + "<? OR " + sort.SQL + " IS NULL)"
			}
			if value == nil {
				if sort.Descending {
					comparison = "0"
				} else {
					comparison = sort.SQL + " IS NOT NULL"
				}
			} else {
				args = append(args, value)
			}
			parts = append(parts, comparison)
			alternatives = append(alternatives, "("+strings.Join(parts, " AND ")+")")
		}
		where += " AND (" + strings.Join(alternatives, " OR ") + ")"
	}
	tx, err := s.Store.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, "", state, false, err
	}
	defer tx.Rollback()
	state, err = readCatalogState(ctx, tx)
	if err != nil {
		return nil, "", state, false, err
	}
	if q.Cursor != "" && cursor.Revision != state.Revision {
		return nil, "", state, false, errSearchCursor
	}
	// A new folder or changed directory timestamp is a cheap signal that this
	// scope needs another walk. This does not traverse it in the HTTP handler.
	var scopeVersion string
	err = tx.QueryRowContext(ctx, `SELECT version FROM catalog WHERE path=?`, q.Scope).Scan(&scopeVersion)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, "", state, false, err
	}
	scopeChanged := errors.Is(err, sql.ErrNoRows)
	if file, openErr := (publicFS{s.public}).open(q.Scope); openErr == nil {
		info, statErr := file.Stat()
		file.Close()
		if statErr == nil && imageVersion(q.Scope, info) != scopeVersion {
			scopeChanged = true
		}
	}
	if scopeChanged {
		s.ensureCatalogScan()
	}
	columns := []string{"path,parent,name,mime,modified,version,size,modified_ns,directory"}
	var order []string
	for _, sort := range sorts {
		columns = append(columns, sort.SQL)
		direction := " ASC"
		if sort.Descending {
			direction = " DESC"
		}
		order = append(order, sort.SQL+direction)
	}
	args = append(args, q.Limit+1)
	rows, err := tx.QueryContext(ctx, "SELECT "+strings.Join(columns, ",")+" FROM catalog WHERE "+where+" ORDER BY "+strings.Join(order, ",")+" LIMIT ?", args...)
	if err != nil {
		return nil, "", state, false, err
	}
	var found []catalogEntry
	var positions [][]json.RawMessage
	for rows.Next() {
		var item catalogEntry
		values := make([]any, len(sorts))
		dest := []any{&item.Path, &item.Parent, &item.Name, &item.MIME, &item.Modified, &item.Version, &item.Size, &item.ModifiedNS, &item.Directory}
		for i := range values {
			dest = append(dest, &values[i])
		}
		if err = rows.Scan(dest...); err != nil {
			break
		}
		position := make([]json.RawMessage, len(values))
		for i, value := range values {
			position[i], _ = json.Marshal(value)
		}
		found = append(found, item)
		positions = append(positions, position)
	}
	rowErr := rows.Err()
	rows.Close()
	if err != nil {
		return nil, "", state, false, err
	}
	if rowErr != nil {
		return nil, "", state, false, rowErr
	}
	if err = tx.Commit(); err != nil {
		return nil, "", state, false, err
	}
	next := ""
	partial := len(found) > q.Limit || !state.Ready || scopeChanged || s.catalogStatus(state) == "error"
	if len(found) > q.Limit {
		found = found[:q.Limit]
		if q.Limit > 0 {
			next = s.encodeSearchCursor(searchCursor{Revision: state.Revision, Query: digest, Values: positions[q.Limit-1]})
		}
	}
	visible := make([]catalogEntry, 0, len(found))
	for _, item := range found {
		if err = ctx.Err(); err != nil {
			return nil, "", state, false, err
		}
		file, openErr := (publicFS{s.public}).open(item.Path)
		if openErr != nil {
			partial = true
			s.ensureCatalogScan()
			continue
		}
		info, statErr := file.Stat()
		file.Close()
		if statErr != nil || imageVersion(item.Path, info) != item.Version {
			partial = true
			s.ensureCatalogScan()
			continue
		}
		visible = append(visible, item)
	}
	return visible, next, state, partial, nil
}
