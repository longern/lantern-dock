# Development

[← Back to the project](../README.md)

Install dependencies with `npm ci`. The frontend uses Preact and Vite; the Worker and WebDAV/HTTP framing modules are independent of the UI framework.

## Checks

```sh
npm run check
npm test
```

## Browser tests

The browser suite covers desktop, tablet, and 390/320 px mobile layouts in Chromium, including previews across breakpoints, navigation, local records, downloads, and configuration errors:

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

It checks gateway 407 versus backend 401, separate credentials, PROPFIND, encoded paths, image/text previews, byte-exact downloads, HEAD, Range, chunked responses, cancellation, and rejection of incorrect certificate hashes. The fixture publishes a generated certificate through the real Worker webhook into an in-memory KV substitute. Certificate auto-rotation is covered by the bridge's Go tests; this suite uses the bridge's manual-certificate mode. Only the local frontend's self-signed HTTPS certificate is bypassed by the browser test context; WebTransport certificate pins are still checked. Chromium mobile viewports do not substitute for testing on physical iOS/Android devices.

## Commands

| Command                | Purpose                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`          | Run Vite and the local Worker configuration API on port 8787.                 |
| `npm run check`        | Check JavaScript syntax and build the JSX frontend.                           |
| `npm test`             | Run protocol, transport, WebDAV, and Worker unit tests.                       |
| `npm run build`        | Build production assets into `dist/`.                                         |
| `npm run preview`      | Serve the production frontend locally with the configuration API.             |
| `npm run test:browser` | Run the Chromium desktop, tablet, and mobile viewport suite.                  |
| `npm run test:bridge`  | Run the production frontend against a real local bridge and a WebDAV fixture. |
| `npm run dev:worker`   | Build assets and start Wrangler for Worker/KV development.                    |
| `npm run deploy`       | Build and deploy the Worker with its static assets.                           |

## Project structure

```text
index.html                 HTML entry
src/
  App.jsx                  Application composition
  components/              Navigation, file browser, previews, dialogs, notifications
  hooks/                   Connections, listings, local records, downloads
  lib/                     WebDAV, transports, HTTP framing, demo fixtures
  styles/                  Component styles and responsive layouts
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
