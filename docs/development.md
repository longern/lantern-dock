# Development

[← Back to the project](../README.md)

Install dependencies with `npm ci`, then run `npm run init` to create the site key in `.env`. The frontend uses Preact and Vite; the Worker and WebDAV/HTTP framing modules are independent of the UI framework.

## Checks

```sh
npm run check
npm test
```

## Browser tests

See [interface conventions](ui.md) for the interaction audit, shared modal lifecycle, visual tokens and motion behavior.

The browser suite covers desktop, tablet, and 390/320 px mobile layouts in Chromium, including previews across breakpoints, navigation, local records, downloads, first-run setup, configuration export, rechecks, and configuration errors. The suite uses a separate demo server on port 8788 so it does not depend on the running development server:

```sh
npx playwright install chromium
npm run test:browser
```

To use an installed Chrome instead: `PLAYWRIGHT_CHANNEL=chrome npm run test:browser`.

## Bridge integration tests

The integration suite builds and starts the real sibling `webtransport-bridge` project, a local WebDAV fixture, and an HTTPS server serving the **production build**. It requires Go 1.26+, a Chromium browser, and local UDP access:

Clone the bridge beside this repository before running the integration suite:

```sh
git clone https://github.com/longern/webtransport-bridge.git ../webtransport-bridge
npm run build
npm run test:bridge
# Optional overrides:
GO_BIN=/path/to/go BRIDGE_SOURCE=/path/to/webtransport-bridge npm run test:bridge
```

It checks gateway 407 versus backend 401, separate credentials, PROPFIND, encoded paths, image/text previews, byte-exact downloads, HEAD, Range, chunked responses, cancellation, and rejection of incorrect certificate hashes. The fixture publishes a generated certificate through the real Worker webhook into an in-memory KV substitute. Setup integration also copies the browser-derived webhook URL, publishes pins through it, and reconnects using the real bridge; the same initial page exports the site key and bridge configuration together. Existing deployments reuse their saved webhook URL, with CLI recovery available for the owner. Certificate auto-rotation is covered by the bridge's Go tests; this suite uses the bridge's manual-certificate mode. Only the local frontend's self-signed HTTPS certificate is bypassed by the browser test context; WebTransport certificate pins are still checked. Chromium mobile viewports do not substitute for testing on physical iOS/Android devices.

## Commands

| Command                | Purpose                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `npm run init`         | Initialize or reuse `SECRET_KEY` in `.env` without printing it.               |
| `npm run dev`          | Run Vite and the local Worker configuration API on port 8787.                 |
| `npm run check`        | Check JavaScript syntax and build the JSX frontend.                           |
| `npm test`             | Run protocol, transport, WebDAV, and Worker unit tests.                       |
| `npm run build`        | Build production assets into `dist/`.                                         |
| `npm run preview`      | Serve the production frontend locally with the configuration API.             |
| `npm run test:browser` | Run the Chromium desktop, tablet, and mobile viewport suite.                  |
| `npm run test:bridge`  | Run the production frontend against a real local bridge and a WebDAV fixture. |
| `npm run dev:worker`   | Build assets and start Wrangler for Worker/KV development.                    |
| `npm run deploy`       | Build and deploy the Worker with its static assets.                           |

## Configuration API states

`GET /api/config` returns normal backend metadata for a configured site. Missing or invalid settings return HTTP 200 with `setupRequired: true` and a `setup` object containing a reason and safe public defaults. Operational failures, such as a KV read outage, still return HTTP 503. No public API writes deployment settings or returns `SECRET_KEY`; setup metadata includes the safe boolean flags `hasSecretKey` and `hasKV`. New deployment keys are generated with Web Crypto in the browser and included only in explicit dotenv copy/download exports. The local API adapter loads `.env` (or legacy `.dev.vars`), and certificate webhook tokens are derived on the server. New configurations use exactly one of `WEBDAV_URL` and `WEBTRANSPORT_URL`; the legacy endpoint/transport variables remain supported. Shared defaults live in `shared/backend-defaults.js`; fixed NAS URL paths live in `shared/backend-paths.js`. The default file root is `/dav/` when the connection URL has no DAV mount path. The NAS exposes public versioned metadata at `/api/capabilities`; see the [service contract](backend-protocol.md). `useSetupWizard` owns connection, export, and certificate states; the three view components show only the controls needed for that state. Deployment format is independent of the environment, and localhost exports open a new deployment instead of rechecking localhost.

## Project structure

```text
index.html                 HTML entry
src/
  App.jsx                  Application composition
  components/              Navigation, file browser, previews, dialogs, notifications
  hooks/                   Connections, listings, local records, downloads
  lib/                     WebDAV, transports, HTTP framing, demo fixtures
  styles/                  Component styles and responsive layouts
scripts/init.mjs           Persistent .env site-key initialization
worker/secrets.js          Purpose-separated server-side token derivation
shared/backend-defaults.js Shared defaults and URL selection
worker/index.js            Connection API and certificate webhook
vite.config.js             Build configuration and local Worker API adapter
test/
  *.test.mjs               Unit tests
  browser/                 Responsive UI tests
  integration/             Real-bridge tests and local fixtures
wrangler.jsonc             Cloudflare Worker and static asset configuration
```

## Making changes

Keep file access and protocol handling in `src/lib/`; components should consume those modules through the hooks. Desktop and mobile share the same components and state. Check the preview, connection dialog, and download cancellation on both layouts when changing their interactions.

Use `npm run check` and `npm test` for code changes, and run the browser or bridge suite when the change touches those paths. Documentation-only changes need link and content checks.

Manually entered backend credentials and short NAS grants stay in page memory. OIDC login uses an encrypted HttpOnly cookie and a non-extractable proof key in IndexedDB. Favorites and recent paths are local browser records. Enforce access control at the backend or bridge; changing frontend navigation cannot authorize file access.

## OIDC integration tests

`test/auth.test.mjs` exercises PKCE, state/nonce validation, ID token/UserInfo matching, encrypted cookies, browser-key binding, standard token responses/errors, DPoP nonce retry, logout, master-secret rotation and overlapping signing versions. Go identity tests cover trusted discovery, JWKS refresh/retirement, access-token claims and scopes, proof replay rejection and local administrator decisions without per-request network lookups. The [identity protocol](identity-protocol.md) and [bridge contract](bridge-protocol.md) describe the interoperable formats and project-specific mappings.

`test/integration/identity.spec.mjs` runs the production frontend with the actual sibling workers-sso Worker in Miniflare, a disposable D1 database, the real bridge and the actual NAS binary. It seeds only a fixture SSO session and uses a minimal consent view around the real provider endpoints; no production identity is used. Build the sibling provider first:

```sh
git clone https://github.com/longern/workers-sso.git ../workers-sso
cd ../workers-sso
npm ci
npm run build
cd ../lantern-dock
npm run build
GO_BIN=/path/to/go PLAYWRIGHT_CHANNEL=chrome npm run test:bridge
```

Use `SSO_SOURCE` to override that source path. The test uses the sibling's Miniflare installation, forwards its public fixture hostname to local HTTPS, and grants local-network access to that test origin so Chromium can reach the loopback UDP bridge. The NAS trusts only the temporary fixture certificate for that connection, using a local CONNECT proxy. No system trust or production provider source is changed. Both desktop and mobile cases cover login, subject/config copying, reload, administrator changes, signing-key rollover, DPoP nonce retry, direct HTTPS resource-origin binding and logout. They also verify that NAS authorization uses site subjects rather than upstream subjects, and that an existing site session can obtain fresh NAS credentials without an upstream provider. These integration tests are local; CI currently runs unit checks and the NAS Docker smoke test.

The Worker fixture leaves `SITE_ORIGIN` unset to exercise automatic HTTPS request-origin detection; the NAS explicitly configures its trusted portal origin. Unit tests also check domain isolation, optional canonical-origin enforcement and rejection of forwarded-header overrides.

`test/integration/worker-runtime.spec.mjs` additionally bundles the LanternDock Worker itself and runs its Discovery request in workerd, using deployment compatibility flags. It checks successful login initiation and rejects a redirected Discovery response without following it. This covers runtime differences hidden by the other tests' Node-based portal adapter, including Workers' unsupported `redirect: "error"` mode; OIDC subrequests use `manual` and reject non-success statuses instead.

## NAS backend

The optional `server/` Go module implements public read-only WebDAV, private file drops and local management commands. It uses `os.Root` for filesystem confinement, `golang.org/x/net/webdav` for DAV and pure-Go SQLite for persistent grants and transactional quota reservations. See the [NAS guide](nas-server.md) for its API and deployment.

```sh
cd server
go vet ./...
go test -race ./...
go build ./cmd/lantern-dock
```

Requires Go 1.26+ on Linux or macOS. The CI workflow also cross-compiles Linux amd64/arm64 binaries and builds/smoke-tests the Docker container.

After the frontend and NAS checks succeed, pushes to `main` publish `ghcr.io/longern/lantern-dock:latest` and a full `sha-<commit>` tag. A Git version tag such as `v1.2.3` publishes `1.2.3` without moving `latest`. The **Checks** workflow can also be run manually on `main` or a version tag. Pull requests never publish images. Publishing uses the repository's `GITHUB_TOKEN` with job-scoped `packages: write`; no additional registry secret is required. OCI source/revision labels link the image to this repository.

The image contains `linux/amd64` and `linux/arm64` manifests. After publication, native runners for each architecture pull the exact published digest and run `scripts/smoke-nas-image.sh`: it checks root-owned NAS bind mounts, default and configured `PUID/PGID`, persisted database/inbox migration, CLI link creation/listing, native Docker `user:` precedence over environment defaults, supplementary groups, read-only public DAV, rejected configurations and nested mounts. It verifies the actual service UID/GID, zero runtime capabilities and no-new-privileges using the process status. The root filesystem remains read-only. This verifies the distributed image, in addition to the NAS job's local container test. The production image uses Alpine and its packaged `setpriv` for the Docker entrypoint; the Go executable has no container-specific build or identity-switching logic. BusyBox is used by the test harness for filesystem fixtures and process inspection.

GHCR initially creates new packages as private. On first publication, the repository owner must ensure the `lantern-dock` container package is **Public** in its package settings; public repository access does not automatically make a granular-permission package public. Public images can then be pulled without login. See [GitHub's package visibility documentation](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

For local Docker builds, use `docker compose -f compose.nas.yaml -f compose.nas.build.yaml up -d --build`. The default Compose file uses the published image and supports a `NAS_IMAGE` override for a version tag or digest.

The existing real-bridge suite now includes `test/integration/nas.spec.mjs`. It builds and launches the actual NAS service, invokes its CLI to issue/revoke links, checks public DAV reads and denied writes, and verifies file contents in the private inbox after browser uploads. It also tests quota errors, expired/revoked links, cancellation and direct HTTPS uploads (the browser's HTTPS backend route is forwarded to the real local NAS API by the fixture).

```sh
npm run build
GO_BIN=/path/to/go PLAYWRIGHT_CHANNEL=chrome npm run test:bridge
```

No production endpoint, NAS directory or real site secret is used by these tests. The fixture uses temporary directories, its own key and certificate pins, and terminates both Go processes when it finishes.
