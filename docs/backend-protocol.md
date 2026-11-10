# NAS service paths and capabilities

The included NAS service exposes one HTTP origin behind a WebTransport bridge or an HTTPS reverse proxy. Container mount paths (`/public` and `/data`) are independent of these public URL paths.

| Service              | Default path        | Protocol                                                                   |
| -------------------- | ------------------- | -------------------------------------------------------------------------- |
| Public files         | `/dav/`             | Anonymous, read-only WebDAV                                                |
| Images               | `/api/iiif/3`       | IIIF Image API 3, Level 0; public generated JPGs                           |
| Motion media         | `/api/media`        | LanternDock media v1; metadata discovery and ranged video resources        |
| Temporary file drops | `/api/uploads`      | LanternDock inbox v1; Bearer collection-link permission                    |
| Account              | `/api/account`      | LanternDock identity v2; DPoP-bound site credential                        |
| Management           | `/api/admin`        | LanternDock admin v1; scoped DPoP credential plus local administrator role |
| Capabilities         | `/api/capabilities` | Public LanternDock capability document v1                                  |

Only the backend connection URL needs to be configured. An unset or empty `BACKEND_ROOT` defaults to `/dav/` for WebTransport and for an HTTP(S) URL with no mount path. An explicit path in `WEBDAV_URL` takes precedence over that default; an explicit `BACKEND_ROOT` overrides either transport. To browse a third-party DAV server mounted at `/`, set `BACKEND_ROOT="/"` (or enter `/` in the setup wizard's advanced root field).

`BACKEND_ROOT` controls only file navigation. It never changes the inbox, account, management or capabilities paths and does not grant filesystem access. Existing explicit roots remain unchanged after upgrading. An existing WebTransport backend mounted at `/` must set `BACKEND_ROOT="/"` when upgrading from the previous `/` default.

Public WebDAV excludes dot-prefixed names, `#recycle`, and `@Recycle` at every level (the recycle names are case-insensitive). Listings and search omit them, and direct access to an excluded entry or anything beneath it returns `404`. Symbolic links are also omitted and never followed, so aliases cannot bypass the exclusion. The NAS's on-disk files and recycle bins are not modified.

## Capability document

`GET /api/capabilities` returns deployment capabilities without authentication:

```json
{
  "version": 1,
  "services": {
    "files": {
      "protocol": "webdav",
      "version": 1,
      "href": "/dav/",
      "enabled": true,
      "readOnly": true
    },
    "inbox": {
      "protocol": "lantern-dock-inbox",
      "version": 1,
      "href": "/api/uploads",
      "enabled": true
    },
    "images": {
      "protocol": "http://iiif.io/api/image",
      "version": 3,
      "href": "/api/iiif/3",
      "enabled": true
    },
    "media": {
      "protocol": "lantern-dock-media",
      "version": 1,
      "href": "/api/media",
      "enabled": true
    },
    "account": {
      "protocol": "lantern-dock-identity",
      "version": 2,
      "href": "/api/account",
      "enabled": false
    },
    "admin": {
      "protocol": "lantern-dock-admin",
      "version": 1,
      "href": "/api/admin",
      "enabled": false
    }
  }
}
```

`account.enabled` and `admin.enabled` reflect whether the NAS has site identity verification configured. `enabled` describes deployment support, not the current visitor's permissions. The document contains no user identity, administrator list, upload links, credentials or filesystem paths. Inbox, account and management requests still enforce their own authorization. Authenticated `/api/account` additionally returns per-user `capabilities.adminLinks` and `capabilities.adminInbox`; those determine which management entries to display, while each management endpoint independently rechecks both the required scope and local role. The WebDAV service's `version` identifies our integration contract; DAV capability classes are advertised separately by `OPTIONS /dav/`.

`HEAD` returns the same headers without a body, `OPTIONS` returns `204`, and other methods return `405`. Responses have `Cache-Control: public, max-age=300` and a content-derived ETag; conditional GET supports `304`. Origin restrictions apply to this route too. Clients may cache deployment metadata; credentials and authorization decisions must not be cached as capabilities.

`media.enabled` requires ExifTool on the NAS (included in the container). See [Live Photos](live-photos.md) for discovery paging and source validation.

The capability document is a LanternDock contract, not a universal WebDAV discovery standard. Directory navigation and uploads use the shared fixed paths directly. When an image becomes visible, the frontend discovers the optional IIIF service once per connection; directory browsing does not wait for this request. Third-party WebDAV services are not required to provide it. See [images and caching](images.md) for the standard IIIF routes and the custom identifier/transport mapping.

## Bridge and reverse proxy

For a bridge dedicated to this NAS service, use `--paths=/dav,/api` and `--methods=*` (quote `'--methods=*'` in a shell). This requires a bridge version supporting wildcard methods. The bridge forwards supported HTTP methods without a per-feature allowlist; inner `CONNECT` requests and protocol upgrades remain unsupported. Prefix checks respect path boundaries; `/dav-other` is not included. New NAS APIs under `/api` do not need a separate bridge allowlist entry. The NAS enforces each route's methods and authorization and returns `404` for unknown routes; opening the namespace does not expose the private data directory. Third-party read-only backends can retain an explicit method allowlist.

An HTTPS reverse proxy forwards both `/dav` and `/api` unchanged to the same NAS HTTP backend. The Worker's own `/api/config` and authentication routes belong to the portal origin, not the NAS service. For routing files and NAS APIs through WebTransport, the bridge endpoint remains the complete `/webtransport` session URL; do not append `/dav/` to that URL.

## Management paths

The browser uses `/api/admin/links` to list/create collection links, `/api/admin/links/:id` to revoke one, `/api/admin/inbox` to list completed private uploads, and `/api/admin/inbox/:id/download` for authorized downloads. Link reads require `links:read`, link changes require `links:write`, and inbox reads/downloads require `inbox:read`; all require the NAS's local administrator role. Guest upload-link Bearer tokens never authorize these endpoints. See [NAS management](nas-server.md) for pagination, quotas and payloads.

Private downloads support GET/HEAD and standard Range/If-Range behavior with attachment disposition. Cross-origin NAS responses allow `Range` and `If-Range` request headers and expose `Content-Disposition` and `Accept-Ranges`. Download bytes do not pass through the Worker, and private inbox files are not exposed through public WebDAV or IIIF routes.

## Recursive albums: WebDAV SEARCH

The NAS implements [RFC 5323](https://www.rfc-editor.org/rfc/rfc5323.html) `SEARCH` on the existing `/dav/` namespace. No additional backend URL or environment variable is needed. `PROPFIND` remains limited to HTTP `Depth: 0` and `Depth: 1`; recursive search uses the **XML** `DAV:scope/DAV:depth` value `infinity`.

Discovery uses standard DAV mechanisms:

```http
OPTIONS /dav/

Allow: GET, HEAD, OPTIONS, PROPFIND, SEARCH
DASL: <DAV:basicsearch>
DAV: 1, <urn:lantern-dock:search>
```

`DAV:supported-method-set` and `DAV:supported-query-grammar-set` are also available through `PROPFIND`. `SEARCH` with `DAV:query-schema-discovery` returns the supported properties and operators. CORS exposes `DAV`, `DASL` and `Allow` and permits `SEARCH`.

The indexed public properties are `DAV:displayname`, `DAV:resourcetype`, `DAV:getcontentlength`, `DAV:getlastmodified`, `DAV:getcontenttype`, and `DAV:getetag`. Ordinary Boolean/comparison operators, `is-collection`, `is-defined`, language predicates, and optional `like` are supported. `contains`/full-text content search is not supported. Matching and ordering default to case-sensitive; explicit `caseless="yes"` returns `422`. Unknown selected properties are returned in a `404` propstat; undefined values in predicates follow SQL's three-valued logic. One local scope is supported per query, with depth `0`, `1` or `infinity`. External origins, version-history scopes and filesystem traversal are rejected.

Example of a standard query, usable without any LanternDock extension:

```xml
<d:searchrequest xmlns:d="DAV:">
  <d:basicsearch>
    <d:select>
      <d:prop>
        <d:displayname/>
        <d:resourcetype/>
        <d:getcontentlength/>
        <d:getlastmodified/>
        <d:getcontenttype/>
        <d:getetag/>
      </d:prop>
    </d:select>
    <d:from>
      <d:scope>
        <d:href>/dav/Photos/</d:href>
        <d:depth>infinity</d:depth>
      </d:scope>
    </d:from>
    <d:where>
      <d:or>
        <d:like><d:prop><d:getcontenttype/></d:prop><d:literal>image/%</d:literal></d:like>
        <d:like><d:prop><d:getcontenttype/></d:prop><d:literal>video/%</d:literal></d:like>
      </d:or>
    </d:where>
    <d:orderby>
      <d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order>
    </d:orderby>
    <d:limit><d:nresults>128</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>
```

Results use `207 Multi-Status` with ordinary `DAV:response`, `DAV:href` and `DAV:propstat` elements. Hrefs are the existing `/dav/...` file resources, not thumbnail identifiers or a second file namespace. Responses have `Cache-Control: no-store`. The server caps pages at 128 resources. When results are truncated or the initial index is incomplete, the multistatus also contains a response for the search arbiter with `HTTP/1.1 507 Insufficient Storage`, as required by RFC 5323 section 2.3.1. A standard client can use the returned resources and recognize incompleteness without understanding private XML elements.

### Minimal extensions

The `DAV` discovery header's coded URL `urn:lantern-dock:search` announces the following extension namespace. These elements **never** use the `DAV:` namespace.

| Element         | Placement                      | Meaning                                                                      |
| --------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| `l:cursor`      | Child of `d:basicsearch`       | Opaque continuation token from the previous page.                            |
| `l:refresh`     | Empty child of `d:basicsearch` | Request a coalesced background index refresh; omit on continuation requests. |
| `l:next-cursor` | Child of `d:multistatus`       | Present only when another page is available.                                 |
| `l:index-state` | Child of `d:multistatus`       | Contains `l:status`, `l:revision`, and optionally `l:updated`.               |

```xml
<d:multistatus xmlns:d="DAV:" xmlns:l="urn:lantern-dock:search">
  <!-- Ordinary DAV:response elements precede these extensions. -->
  <l:next-cursor>opaque-token</l:next-cursor>
  <l:index-state>
    <l:status>scanning</l:status>
    <l:revision>opaque-index-revision</l:revision>
    <l:updated>2026-11-10T00:00:00Z</l:updated>
  </l:index-state>
</d:multistatus>
```

Status is `scanning`, `ready` or `error`. `updated` is the last successful scan time in RFC 3339 UTC, not a guarantee that every filesystem change has already been observed. Revisions and cursors are opaque. Repeat the same query with only `l:cursor` changed; tokens are authenticated and bound to its scope, predicate, selected properties, ordering, page size and index revision. They do not grant access. A changed index, modified query, tampered token or server restart returns `409` with `<l:valid-cursor/>` inside `DAV:error`. Restart without a cursor. The UI preserves visible results and asks for a refresh rather than silently mixing revisions or jumping to another page.

The browser sends extension request elements only after discovery. A third-party SEARCH service without the extension can still provide its first page; the UI does not invent a continuation token and reports standard truncation. Without SEARCH support (including a bridge that rejects the method), the album falls back to the current folder's ordinary DAV listing. Ordinary file navigation always stays shallow.

### Index lifecycle

SQLite metadata under `/data` persists across restarts. A background scan starts at boot and repeats once per minute; explicit refreshes are coalesced and spaced at least five seconds apart. A query for a newly created or changed folder can also request a background scan without traversing the directory in the HTTP handler. Scans inspect names, sizes, timestamps, MIME types and file versions, with no original image decoding, video decoding or eager thumbnail generation. Only metadata changes are staged; normal scans publish them atomically and retain the revision when nothing changed. The first scan publishes batches so early results can be viewed before it completes. Photos retain the UI's existing modification-time ordering.

Indexing and reads share the same confined public filesystem: dot-prefixed entries, recycle bins, symlinks, private data and the inbox are excluded. An unreadable subtree is not mistaken for deletion. Every result is reopened and version-checked before its metadata is returned, so stale index rows cannot bypass changed permissions or expose removed files. Thumbnails remain viewport-driven IIIF requests, and the browser reads index pages on demand rather than recursively traversing folders itself. SEARCH responses never drive recent-history deletion; a partial search cannot establish that a file is absent.
