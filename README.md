# LanternDock

**A direct-access frontend for sharing self-hosted files, apps, and tasks.**

LanternDock is a visitor-facing entry point to resources you host yourself. Publish selected resources, let visitors connect directly to your backend, and keep ownership of your data and services.

The first version is a WebDAV file browser. Scoped guest uploads, identity integration, and delegated tasks are planned extensions, not available features.

## How it works

Cloudflare Workers serves the application and a small connection document at `/api/config`. The browser uses that document to connect directly to your backend over HTTPS or WebTransport. File contents do not pass through the Worker.

- **HTTPS:** the browser uses Fetch to access a CORS-enabled WebDAV endpoint.
- **WebTransport:** the browser connects to [webtransport-bridge](https://github.com/longern/webtransport-bridge), carrying one HTTP/1.1 request and response per bidirectional stream. The bridge forwards requests to your existing WebDAV service.

The WebTransport mapping is project-specific; the inner messages use HTTP/1.1 syntax. WebDAV remains the file interface in both modes.

## Available today

- Directory browsing, current-directory search, sorting, and grid/list views.
- Image and text previews; file downloads with progress and cancellation.
- Streaming downloads through the browser's file picker when supported; bounded in-memory downloads otherwise.
- Local favorites and recent items.
- Backend Basic or Bearer authentication, with credentials kept in page memory.
- Separate bridge authentication through `Proxy-Authorization`, preserving backend `Authorization`.
- WebTransport certificate pins distributed by the Worker, with a private update webhook backed by Workers KV.
- An explicit demo mode with sample files.

The current interface is in Chinese. This version is read-only: it has no upload, delete, rename, media transcoding, or task execution UI. Real backend images receive a generic icon in directory listings; image previews open on demand.

## Run locally

Requires Node.js 22.12 or newer. The interface uses Preact and Vite; the Worker and transport modules remain independent of the UI framework.

```sh
npm ci
npm run dev
```

Open <http://localhost:8787>. Vite serves the interface and the Worker configuration API locally. It uses demo fixtures until a backend is configured. File contents still travel directly between the browser and the backend.

To use your backend:

```sh
cp .dev.vars.example .dev.vars
npm run dev
```

Edit `.dev.vars` before starting the server. The local server loads this file at startup. Credentials belong in the connection dialog, not in the public configuration.

## Configure an HTTPS backend

For local development, place these values in `.dev.vars`. For deployment, edit `vars` in `wrangler.jsonc`.

```dotenv
BACKEND_NAME="Public resources"
BACKEND_TRANSPORT="http"
BACKEND_ENDPOINT="https://files.example.com"
BACKEND_ROOT="/dav/public/"
BACKEND_AUTH="none"
GATEWAY_AUTH="false"
```

`BACKEND_ENDPOINT` must be an origin without a path. `BACKEND_ROOT` is the WebDAV directory to display, including its mount prefix. Use `BACKEND_AUTH="basic"` or `"bearer"` to accept visitor-supplied credentials.

The backend must support WebDAV `PROPFIND` with `Depth: 1`, plus `GET` and `HEAD`. A plain HTTP directory listing is not sufficient. Configure CORS on the backend for your frontend origin:

- Methods: `GET`, `HEAD`, `PROPFIND`, and preflight `OPTIONS`.
- Request headers: `Authorization`, `Content-Type`, and `Depth` as needed.
- Exposed response headers: `Content-Length`, `Content-Type`, `Content-Disposition`, `ETag`, `Accept-Ranges`, and `Content-Range` as needed.

The frontend does not use ambient backend cookies. Basic and Bearer credentials are sent explicitly. Production backends should use HTTPS; an HTTPS frontend cannot ordinarily fetch an insecure HTTP backend.

`BACKEND_ROOT` is a navigation setting, not an access-control boundary. Enforce read permissions and directory restrictions on the backend or bridge itself. The connection document is public and includes the backend address and certificate pins, never stored backend credentials.

## Configure WebTransport

```dotenv
BACKEND_NAME="Public resources"
BACKEND_TRANSPORT="webtransport"
BACKEND_ENDPOINT="https://bridge.example.com:4433/webtransport"
BACKEND_ROOT="/public/"
BACKEND_AUTH="none"
GATEWAY_AUTH="true"
CERTIFICATE_MODE="pinned"
```

The endpoint is the complete WebTransport session URL. Configure the bridge to permit the frontend origin and `GET`, `HEAD`, and **`PROPFIND`**. Restrict its allowed paths and backend permissions to the intended resources. WebTransport requires a compatible browser, a secure frontend context, and network reachability to the bridge's UDP port.

With `GATEWAY_AUTH="true"`, visitors enter a bridge token separately from their backend credentials. The bridge must consume `Proxy-Authorization`; the backend's `Authorization` stays intact. This header is encoded inside the WebTransport stream, not sent through browser Fetch.

For a publicly trusted gateway certificate, set `CERTIFICATE_MODE="webpki"` to use browser certificate validation without pins. Otherwise configure the pinned-certificate flow below. There is no automatic fallback from WebTransport to HTTPS.

### Certificate updates

Create a Workers KV namespace and add its returned ID to `wrangler.jsonc`:

```sh
npx wrangler kv namespace create PINS
```

```json
"kv_namespaces": [
  { "binding": "PINS", "id": "YOUR_NAMESPACE_ID" }
]
```

Generate a private webhook URL, replacing the example Worker origin:

```sh
npm run webhook -- https://lantern-dock.example.workers.dev
```

The script saves a random secret in `.webhook-secret` and prints the corresponding URL. Store the file's contents as the Worker secret:

```sh
npx wrangler secret put CERT_WEBHOOK_SECRET
```

Paste the secret when prompted. Configure the printed URL as the bridge's certificate webhook. Treat the complete URL as a credential and avoid sharing it or recording it in public logs.

The webhook accepts `PUT` with `Content-Type: application/json`:

```json
{
  "version": 1,
  "certificates": [
    {
      "algorithm": "sha-256",
      "value": "BASE64_ENCODED_32_BYTE_SHA256_DIGEST",
      "notBefore": "2026-11-04T00:00:00Z",
      "notAfter": "2026-11-18T00:00:00Z"
    }
  ]
}
```

Use the actual certificate dates and digest; this is a format example. At most two certificate pins are accepted, each with a validity period of at most 14 days. Expired pins are excluded. The Worker responds with `204` only after the KV write succeeds, or `503` if storage fails.

KV updates are eventually consistent. Publish replacement pins ahead of certificate activation and keep an overlap window; a successful webhook does not mean every edge location has already observed the update. Use the connection dialog's reconnect action to fetch current pins.

For local pinned-certificate development without KV, set `CERTIFICATES_JSON` in `.dev.vars` to the same document. The Vite development server does not emulate KV; use Wrangler for binding-based development.

## Deploy to Cloudflare Workers

The project uses Workers Static Assets. `npm run deploy` builds the frontend into `dist/`, then Wrangler uploads that directory and the Worker together.

1. Configure the real backend in `wrangler.jsonc`. Do not deploy the placeholder endpoint.
2. Authenticate Wrangler and deploy:

   ```sh
   npx wrangler login
   npm run deploy
   ```

3. Allow the deployed frontend origin in the backend CORS policy or bridge origin policy.
4. For pinned WebTransport, configure KV and the webhook, then let the bridge publish its certificate before connecting.

`.dev.vars` is for local development; it is not the production configuration. Keep `DEMO_MODE` unset in production unless you intentionally want a sample-only site.

See Cloudflare's [Static Assets](https://developers.cloudflare.com/workers/static-assets/) and [KV setup](https://developers.cloudflare.com/kv/get-started/) documentation for platform configuration.

## Limits

- Without the file-system picker API, downloads are buffered and capped at 256 MiB. With the API, downloads stream to the selected file.
- Image previews are capped at 25 MiB and text previews at 1 MiB. Directory responses are capped at 8 MiB.
- Video, audio, PDF, and archive contents do not have an embedded preview yet.
- Favorites and recent paths are stored in this browser's local storage. Authentication credentials are held only in the current page's memory.
- An HTTP backend needs its own CORS configuration. A WebTransport backend needs its own origin policy, authentication, and resource limits.
- This is an initial implementation. Automated protocol tests and the demo do not replace integration testing with your backend and target browsers.

## Direction

LanternDock's intended unit of sharing is a **capability**: access to a directory, permission to upload into a folder, or permission to run a particular task.

Planned work:

- Connect existing backend identities through documented identity adapters.
- Let authorized owners issue expiring, revocable guest grants with explicit scopes and quotas.
- Provide upload-only entry points without exposing other files.
- Expose predefined tasks, such as media conversion, with backend-enforced authorization and resource budgets.

These extensions need enforcement at the resource backend. Frontend controls and Worker-issued metadata alone cannot authorize uploads or execution. Files remain the first module; there is no general-purpose remote shell or compute API today.

## Development

```sh
npm run check
npm test
```

The browser suite covers desktop, tablet, and 390/320 px mobile layouts in Chromium, including previews across breakpoints, navigation, local records, downloads, and configuration errors:

```sh
npx playwright install chromium
npm run test:browser
```

To use an installed Chrome instead: `PLAYWRIGHT_CHANNEL=chrome npm run test:browser`.

The integration suite builds and starts the real sibling `webtransport-bridge` project, a local WebDAV fixture, and an HTTPS server serving the **production build**. It requires Go 1.26+, a Chromium browser, and local UDP access:

```sh
npm run build
npm run test:bridge
# Optional overrides:
GO_BIN=/path/to/go BRIDGE_SOURCE=/path/to/webtransport-bridge npm run test:bridge
```

It checks gateway 407 versus backend 401, separate credentials, PROPFIND, encoded paths, image/text previews, byte-exact downloads, HEAD, Range, chunked responses, cancellation, and rejection of incorrect certificate hashes. The fixture publishes a generated certificate through the real Worker webhook into an in-memory KV substitute. Certificate auto-rotation is covered by the bridge's Go tests; this suite uses the bridge's manual-certificate mode. Only the local frontend's self-signed HTTPS certificate is bypassed by the browser test context; WebTransport certificate pins are still checked. Chromium mobile viewports do not substitute for testing on physical iOS/Android devices.

Source layout:

| Path | Purpose |
| --- | --- |
| `index.html`, `src/main.jsx` | HTML entry and Preact mount |
| `src/App.jsx` | Composition and application interactions |
| `src/components/` | Navigation, file browser, preview, connection dialog, download status, notifications |
| `src/hooks/` | Connection/listing lifecycle, browser records, downloads, media queries |
| `src/styles/` | Styles grouped by component and responsive layout |
| `src/lib/transport.js` | Direct HTTP and WebTransport connections |
| `src/lib/http-wire.js` | Incremental HTTP/1.1 message handling |
| `src/lib/dav.js` | WebDAV directory and file access |
| `src/lib/demo.js` | Explicit sample fixtures |
| `worker/index.js` | Public configuration and private certificate webhook |
| `vite.config.js` | Frontend build and local Worker API adapter |
| `test/` | Unit, browser, and real-bridge integration tests |

Desktop uses a persistent preview panel; tablet and mobile use a modal preview, with a full-screen layout on phones. The same components and state serve all layouts. Notifications use a slightly translucent black surface with white text in the lower center; the Popover API keeps them visible above modal dialogs. Shares, tasks, uploads, and backend thumbnails remain planned features.
