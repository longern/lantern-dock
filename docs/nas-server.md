# NAS server and temporary file drops

LanternDock includes an optional Go backend in `server/`. It serves a public folder as **anonymous, read-only WebDAV** and accepts private uploads through **expiring, revocable file-drop links**. Visitors do not need accounts. You can continue using another WebDAV backend for browsing; file-drop links require this NAS service.

The NAS issues the links, enforces quotas and stores upload state in SQLite. The Worker serves the UI, public connection metadata and certificate hashes. File bytes go directly to the NAS over HTTPS or through `webtransport-bridge`; they never pass through the Worker.

```mermaid
flowchart LR
    Browser -->|Pages and connection metadata| Worker
    Browser -->|WebTransport| Bridge
    Bridge --> NAS[LanternDock NAS server]
    NAS -->|Read only| Public[Public directory]
    NAS -->|Private uploads| Inbox[Data volume / inbox]
    NAS --> SQLite[Links, reservations and upload state]
```

## Deploy on a NAS with Docker Compose

The NAS backend image is **`ghcr.io/longern/lantern-dock:latest`**, with `linux/amd64` and `linux/arm64` variants. The included [`compose.nas.yaml`](../compose.nas.yaml) pulls it alongside the bridge image; your NAS does not need Go or a local build. Clone the repository or copy the Compose file onto your NAS. Set these values in a local `.env` beside it, preserving other existing settings:

```dotenv
PUBLIC_DIR="/replace/with/the/actual/public/folder"
SITE_ORIGIN="https://nas.example.com"
CERT_WEBHOOK_URL="https://nas.example.com/api/certificates/your-private-derived-token"
```

Use the certificate webhook URL paired with your Worker's `SECRET_KEY`. The NAS upload service does not need the Worker's master key. File-drop tokens are generated independently on the NAS, and only their SHA-256 hashes are stored in SQLite.

```sh
docker compose -f compose.nas.yaml pull
docker compose -f compose.nas.yaml up -d
```

`latest` tracks tested commits on `main`. Each published build also has a full commit tag, `sha-<40-character-commit>`, and `v1.2.3` Git tags publish the image tag `1.2.3`. To pin a version or digest, optionally set `NAS_IMAGE="ghcr.io/longern/lantern-dock:sha-<commit>"` or `NAS_IMAGE="ghcr.io/longern/lantern-dock@sha256:<digest>"` in `.env`. Leave it unset for the default. Version-tag builds do not overwrite `latest`.

To update, run `pull` and `up -d` again after reviewing the changes. Keep the same Compose project name/directory and persistent volumes when migrating an existing local build. The `nas-data` and `bridge-certs` volumes remain in use; do not remove them during an update.

For source development, clone the repository and explicitly add the build override:

```sh
docker compose -f compose.nas.yaml -f compose.nas.build.yaml up -d --build
```

This override builds `server/` as `lantern-dock-server:local`; ordinary deployments use the GHCR image.

The NAS image supports optional `PUID` and `PGID`, matching the NAS account used for folder access. Both default to `1000`. These are **NAS container** settings, not Worker variables. Change them in the NAS `.env` or the container's environment-variable page if your account has different numeric IDs:

```dotenv
PUID="1000"
PGID="1000"
```

`1000` is the image default, not a universal UGREEN/Synology/QNAP account ID. Grant the selected account read/search permission on the public folder and read/write permission on the private data folder. Existing group-based access can use Docker's `group_add:`; the entrypoint retains explicitly supplied nonzero supplementary groups.

The Alpine image uses a Docker entrypoint for initialization and the packaged `setpriv` utility to launch the application as the selected non-root user. The entrypoint briefly starts as root, prepares the private data directory, database/sidecars, lock file and inbox, then replaces itself with the unprivileged application. It enables no-new-privileges and clears inherited/ambient capabilities during the handoff. The Go server and standalone CLI contain no process-identity switching or container-build flags. The `/lantern-dock` command inside the image is an alias for the entrypoint, so existing `docker exec … /lantern-dock link …` commands follow the same user selection and do not create root-owned database files.

Private initialization preserves existing data and collection links, changes ownership only when needed, and skips unrelated files. It rejects linked state files, nested mounts and overlapping public/private paths. It never modifies the public folder's owner or permissions. Use a dedicated private data directory. The root filesystem may remain read-only, with the private data mount writable. No privileged mode or custom capability list is required with Docker's default capabilities; the supplied Compose file uses those defaults.

Docker's native `user: "UID:GID"` (or `--user`) takes precedence when selecting a non-root user. In that mode the entrypoint skips root-only initialization and preserves the caller's identity/groups, even if image-default `PUID/PGID` values differ. Prepare the private directory's permissions beforehand. Standalone Go binaries always use their caller's identity; `PUID/PGID` are interpreted only by the container entrypoint.

When upgrading from the earlier `65532:65532` default, an unset `PUID/PGID` now selects `1000:1000`; the next container start migrates the existing private state. Explicit IDs remain supported. Pull the updated image and recreate the container with its existing data mounts. For Compose, use the updated file and remove the old NAS `cap_drop`/`cap_add` overrides. The public mount stays read-only. On UGREEN UGOS, use the Docker environment-variable page or edit the Compose project; the selected account still needs access under UGOS folder ACLs. See the official [Compose guide](https://support.ugnas.com/knowledgecenter/detail/article/zh-CN/411) and [folder permission guide](https://support.ugnas.com/detail/article/zh-CN/918).

The bridge listens on **4433/udp** (`BRIDGE_PORT` optionally changes the host port). Keep the existing UDP tunnel forwarding to this port. Its backend becomes `http://nas:8080`, allowed paths are `/dav,/api/uploads,/api/account`, and methods are `GET,HEAD,PROPFIND,POST,PUT,DELETE,OPTIONS`. The bridge uses public mode; the NAS service checks every upload's own permission and verifies identity proofs on the account API.

If you keep an existing bridge container instead, attach it and the NAS service to the same Docker network and update those arguments. Preserve the bridge's existing certificate volume, certificate flags and frontend origin. Do not start a second bridge on an occupied host UDP port. Changing to a new bridge certificate volume requires that instance to publish its new hashes before clients connect.

Set these Worker variables while keeping the existing `WEBTRANSPORT_URL`:

```dotenv
BACKEND_ROOT="/dav/"
BACKEND_AUTH="none"
GATEWAY_AUTH="false"
```

The NAS HTTP port is only available on the Compose network. The public WebDAV root is `/dav/`; the whole public folder appears there. Private data and public files must be separate, non-overlapping directories, including when symlinks are resolved. The service refuses to start with overlapping roots. A single NAS server instance owns each data directory; CLI commands can safely operate while it runs.

## Create a file-drop link

Run on the NAS:

```sh
docker compose -f compose.nas.yaml exec nas /lantern-dock link create \
  --data-dir=/data \
  --site=https://nas.example.com \
  --title="Send me your photos" \
  --expires=168h \
  --max-file=1GiB \
  --max-total=10GiB \
  --max-files=100
```

The command prints JSON containing the link ID, limits and shareable `url`. The URL opens a dedicated upload page, for example `https://nas.example.com/#/upload/<random-token>`. The token stays in the URL fragment and is sent to the NAS in an `Authorization: Bearer` header. It is never included in the Worker's configuration or a backend request URL. Treat the link as the upload permission; anyone you give it to can use the same limits.

The actual URL is shown only at creation. `link list` never returns tokens, so save the URL or issue a replacement if you lose it.

Defaults: 24 hours, 1 GiB per file, 10 GiB total and 100 files. Sizes accept bytes or integer `KiB`, `MiB`, `GiB`, `TiB` (decimal `KB`, `MB`, `GB`, `TB` also work). Lifetimes use Go durations such as `24h` or `168h`, up to `8760h`. If you increase the per-file limit beyond 1 GiB, also increase the bridge's `--max-body` and any intervening proxy's body limit.

View quota usage and revoke a link:

```sh
docker compose -f compose.nas.yaml exec nas /lantern-dock link list --data-dir=/data

docker compose -f compose.nas.yaml exec nas /lantern-dock link revoke \
  --data-dir=/data LINK_ID
```

Revocation prevents new requests and finalization immediately. Active uploads are cancelled by the NAS within five seconds. Expiry also cancels active uploads; choose a lifetime that covers the transfer, not just its starting time. Expiry and revocation leave completed files on disk for you to collect.

## Where files go

The private `/data` volume contains:

```text
/data/
  lantern-dock.sqlite        # links, limits and upload state
  lantern-dock.sqlite-wal    # SQLite's live write-ahead log, when present
  server.lock               # single-instance lock
  inbox/
    .staging/               # incomplete files
    <link-id>/
      <upload-id>-<original-name>
```

Uploaded files are **not automatically published**. Collect them from the private data volume and move or copy selected files into your public folder when ready. Separate upload IDs prevent name collisions and overwriting. Do not manually delete quota records from a running database. Moving or deleting a completed file does not restore its link's lifetime quota; create another link for a new collection.

The NAS reserves the declared size and one file slot before transfer, using an SQLite transaction. Reservations count against the shared link quota, including parallel uploads. An unstarted reservation expires after 15 minutes or at link expiry, whichever comes first. Interrupted/cancelled transfers release reservations and remove partial files. The server fsyncs and renames a completed file before committing success, and rechecks the link before finalization. Startup recovers interrupted transfers and removes their partial/orphaned files. There are at most 32 active file bodies per server, with a one-minute read-idle deadline.

Stop the NAS service before making a simple filesystem copy of the data volume, or use SQLite's online backup facilities. Copying only the main `.sqlite` file while it is live can omit committed WAL data. Preserve the whole private volume when updating containers.

## Run without Docker

Requires Go 1.26+ on Linux or macOS:

```sh
cd server
go build -o lantern-dock ./cmd/lantern-dock
./lantern-dock serve --listen=127.0.0.1:8080 \
  --public-dir=/path/to/public --data-dir=/path/to/private-state
```

The binary uses the same `link create`, `link list` and `link revoke` commands. Management is local CLI only in this version: there is no public administrative write API or visitor registration. Optional [OIDC/CIMD login](authentication.md) adds an account page, copyable subjects and NAS-enforced administrator recognition through `ADMIN_SUBJECTS`; it does not change public DAV or collection-link access.

For direct HTTPS connections, place the HTTP server behind your HTTPS reverse proxy and allow your exact frontend origin:

```sh
./lantern-dock serve --public-dir=/path/to/public --data-dir=/path/to/private-state \
  --origins=https://nas.example.com
```

Set `WEBDAV_URL="https://files.example.com/dav/"` on the Worker and clear `WEBTRANSPORT_URL`. The reverse proxy must forward both `/dav/` and `/api/uploads` without changing paths and allow the required body size and transfer duration. Upload progress uses XHR for direct HTTPS and streamed binary writes for WebTransport.

## HTTP interface

All upload endpoints require the file-drop bearer token. A token cannot read file contents or enumerate other uploads. It can inspect a known task belonging to the same drop and cancel an incomplete task. Public WebDAV remains anonymous and read-only.

| Request                    | Result                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /healthz`             | Service liveness.                                                                         |
| `PROPFIND /dav/`           | Public directory metadata; `Depth: 0` or `1` is required.                                 |
| `GET`, `HEAD /dav/<path>`  | Public files, including Range and conditional reads.                                      |
| `GET /api/uploads`         | This link's title, expiry, limits and aggregate usage; no file listing.                   |
| `POST /api/uploads`        | Reserve a task with JSON `{ "name": "photo.jpg", "size": 12345 }`.                        |
| `PUT /api/uploads/<id>`    | Send exactly the reserved number of binary bytes; returns `201` after durable completion. |
| `GET /api/uploads/<id>`    | Check this task's state, including recovery after a lost response.                        |
| `DELETE /api/uploads/<id>` | Cancel an incomplete task and release quota.                                              |

Errors are JSON with `error` and `code`: `401` for an invalid/missing link token, `410` for an expired/revoked link, `413` for a file above its size limit, `409` for insufficient quota or a conflicting task state, and `503` for storage/service failures. Public WebDAV writes return `405`.

This first version transfers each file in one request. Cancelling or losing an incomplete transfer requires uploading that file again; there is no resumable-upload protocol yet. The UI displays results for the current visit rather than exposing an inbox listing.
