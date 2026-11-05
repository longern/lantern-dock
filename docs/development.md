# Development

[← Back to the project](../README.md)

Install dependencies with `npm ci`, then run `npm run init` to create the site key in `.env`. The frontend uses Preact and Vite; the Worker and WebDAV/HTTP framing modules are independent of the UI framework.

## Checks

```sh
npm run check
npm test
```

## Browser tests

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

`GET /api/config` returns normal backend metadata for a configured site. Missing or invalid settings return HTTP 200 with `setupRequired: true` and a `setup` object containing a reason and safe public defaults. Operational failures, such as a KV read outage, still return HTTP 503. No public API writes deployment settings or returns `SECRET_KEY`; setup metadata includes only `hasSecretKey`. New deployment keys are generated with Web Crypto in the browser and included only in explicit dotenv copy/download exports. The local API adapter loads `.env` (or legacy `.dev.vars`), and certificate webhook tokens are derived on the server. New configurations use exactly one of `WEBDAV_URL` and `WEBTRANSPORT_URL`; the legacy endpoint/transport variables remain supported. Shared defaults live in `shared/backend-defaults.js`.

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

Authentication credentials stay in page memory. Favorites and recent paths are local browser records. Enforce access control at the backend or bridge; changing frontend navigation cannot authorize file access.
