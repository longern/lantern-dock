# NAS service paths and capabilities

The included NAS service exposes one HTTP origin behind a WebTransport bridge or an HTTPS reverse proxy. Container mount paths (`/public` and `/data`) are independent of these public URL paths.

| Service              | Default path        | Protocol                                                |
| -------------------- | ------------------- | ------------------------------------------------------- |
| Public files         | `/dav/`             | Anonymous, read-only WebDAV                             |
| Images               | `/api/iiif/3`       | IIIF Image API 3, Level 0; public generated JPGs        |
| Motion media          | `/api/media`        | LanternDock media v1; metadata discovery and ranged video resources |
| Temporary file drops | `/api/uploads`      | LanternDock inbox v1; Bearer collection-link permission |
| Account              | `/api/account`      | LanternDock identity v2; DPoP-bound site credential     |
| Management           | `/api/admin`        | LanternDock admin v1; scoped DPoP credential plus local administrator role |
| Capabilities         | `/api/capabilities` | Public LanternDock capability document v1               |

Only the backend connection URL needs to be configured. An unset or empty `BACKEND_ROOT` defaults to `/dav/` for WebTransport and for an HTTP(S) URL with no mount path. An explicit path in `WEBDAV_URL` takes precedence over that default; an explicit `BACKEND_ROOT` overrides either transport. To browse a third-party DAV server mounted at `/`, set `BACKEND_ROOT="/"` (or enter `/` in the setup wizard's advanced root field).

`BACKEND_ROOT` controls only file navigation. It never changes the inbox, account, management or capabilities paths and does not grant filesystem access. Existing explicit roots remain unchanged after upgrading. An existing WebTransport backend mounted at `/` must set `BACKEND_ROOT="/"` when upgrading from the previous `/` default.

Public WebDAV reserves `#recycle` and `@Recycle` as excluded entry names at every level (case-insensitive). Listings omit them and direct access to the entry or anything beneath it returns `404`. Symbolic links are also omitted and never followed, so aliases cannot bypass the exclusion. The NAS's on-disk recycle bins are not modified.

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

For a bridge dedicated to this NAS service, use `--paths=/dav,/api` and methods `GET,HEAD,PROPFIND,POST,PUT,DELETE,OPTIONS`. Prefix checks respect path boundaries; `/dav-other` is not included. New NAS APIs under `/api` do not need a separate bridge allowlist entry. The NAS returns `404` for unknown routes and checks authorization on protected ones; opening the namespace does not expose the private data directory.

An HTTPS reverse proxy forwards both `/dav` and `/api` unchanged to the same NAS HTTP backend. The Worker's own `/api/config` and authentication routes belong to the portal origin, not the NAS service. For routing files and NAS APIs through WebTransport, the bridge endpoint remains the complete `/webtransport` session URL; do not append `/dav/` to that URL.

## Management paths

The browser uses `/api/admin/links` to list/create collection links, `/api/admin/links/:id` to revoke one, `/api/admin/inbox` to list completed private uploads, and `/api/admin/inbox/:id/download` for authorized downloads. Link reads require `links:read`, link changes require `links:write`, and inbox reads/downloads require `inbox:read`; all require the NAS's local administrator role. Guest upload-link Bearer tokens never authorize these endpoints. See [NAS management](nas-server.md) for pagination, quotas and payloads.

Private downloads support GET/HEAD and standard Range/If-Range behavior with attachment disposition. Cross-origin NAS responses allow `Range` and `If-Range` request headers and expose `Content-Disposition` and `Accept-Ranges`. Download bytes do not pass through the Worker, and private inbox files are not exposed through public WebDAV or IIIF routes.
