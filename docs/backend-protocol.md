# NAS service paths and capabilities

The included NAS service exposes one HTTP origin behind a WebTransport bridge or an HTTPS reverse proxy. Container mount paths (`/public` and `/data`) are independent of these public URL paths.

| Service              | Default path        | Protocol                                                |
| -------------------- | ------------------- | ------------------------------------------------------- |
| Public files         | `/dav/`             | Anonymous, read-only WebDAV                             |
| Temporary file drops | `/api/uploads`      | LanternDock inbox v1; Bearer collection-link permission |
| Account              | `/api/account`      | LanternDock identity v2; DPoP-bound site credential     |
| Capabilities         | `/api/capabilities` | Public LanternDock capability document v1               |

Only the backend connection URL needs to be configured. An unset or empty `BACKEND_ROOT` defaults to `/dav/` for WebTransport and for an HTTP(S) URL with no mount path. An explicit path in `WEBDAV_URL` takes precedence over that default; an explicit `BACKEND_ROOT` overrides either transport. To browse a third-party DAV server mounted at `/`, set `BACKEND_ROOT="/"` (or enter `/` in the setup wizard's advanced root field).

`BACKEND_ROOT` controls only file navigation. It never changes the inbox, account or capabilities paths and does not grant filesystem access. Existing explicit roots remain unchanged after upgrading. An existing WebTransport backend mounted at `/` must set `BACKEND_ROOT="/"` when upgrading from the previous `/` default.

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
    "account": {
      "protocol": "lantern-dock-identity",
      "version": 2,
      "href": "/api/account",
      "enabled": false
    }
  }
}
```

`account.enabled` reflects whether the NAS has site identity verification configured. `enabled` describes deployment support, not the current visitor's permissions. The document contains no user identity, administrator list, upload links, credentials or filesystem paths. Inbox and account requests still enforce their own authorization. The WebDAV service's `version` identifies our integration contract; DAV capability classes are advertised separately by `OPTIONS /dav/`.

`HEAD` returns the same headers without a body, `OPTIONS` returns `204`, and other methods return `405`. Responses have `Cache-Control: public, max-age=300` and a content-derived ETag; conditional GET supports `304`. Origin restrictions apply to this route too. Clients may cache deployment metadata; credentials and authorization decisions must not be cached as capabilities.

The capability document is a LanternDock contract, not a universal WebDAV discovery standard. The current frontend uses the shared fixed paths directly, so directory navigation and uploads do not wait for an extra discovery request. The endpoint supports diagnostics and future capability negotiation. Third-party WebDAV services are not required to provide it.

## Bridge and reverse proxy

For a bridge dedicated to this NAS service, use `--paths=/dav,/api` and methods `GET,HEAD,PROPFIND,POST,PUT,DELETE,OPTIONS`. Prefix checks respect path boundaries; `/dav-other` is not included. New NAS APIs under `/api` do not need a separate bridge allowlist entry. The NAS returns `404` for unknown routes and checks authorization on protected ones; opening the namespace does not expose the private data directory.

An HTTPS reverse proxy forwards both `/dav` and `/api` unchanged to the same NAS HTTP backend. The Worker's own `/api/config` and authentication routes belong to the portal origin, not the NAS service. For routing files and NAS APIs through WebTransport, the bridge endpoint remains the complete `/webtransport` session URL; do not append `/dav/` to that URL.
