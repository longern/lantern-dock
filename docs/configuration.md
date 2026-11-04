# Configuration

[← Back to the project](../README.md)

LanternDock serves one configured WebDAV root. Configure it in `.dev.vars` for Vite development and in `wrangler.jsonc` for Cloudflare deployment. Restart the development server after changing local settings.

Credentials are entered in the connection dialog and kept in page memory. The public `/api/config` document contains connection metadata and certificate pins.

## Environment variables

| Variable              | Default                    | Description                                                                                    |
| --------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| `BACKEND_NAME`        | `Public files`             | Resource name shown in the interface.                                                          |
| `BACKEND_TRANSPORT`   | `http`                     | `http` for Fetch over HTTP(S), or `webtransport` for the bridge.                               |
| `BACKEND_ENDPOINT`    | Required outside demo mode | HTTP(S) origin, or a complete HTTPS WebTransport session URL.                                  |
| `BACKEND_ROOT`        | `/`                        | WebDAV root, including any mount prefix.                                                       |
| `BACKEND_AUTH`        | `none`                     | `none`, `basic`, or `bearer`; visitors supply credentials.                                     |
| `GATEWAY_AUTH`        | `false`                    | Set to `true` to collect a separate bridge token in WebTransport mode.                         |
| `CERTIFICATE_MODE`    | Pinned                     | Use `pinned` for certificate hashes or `webpki` for a publicly trusted certificate.            |
| `CERTIFICATES_JSON`   | Unset                      | Local certificate document when no `PINS` binding is available.                                |
| `DEMO_MODE`           | Unset in the Worker        | Set to `true` to serve sample files. Vite defaults to demo mode when no backend is configured. |
| `CERT_WEBHOOK_SECRET` | Unset                      | Private Worker secret for certificate updates.                                                 |

Pinned WebTransport deployments also need a `PINS` Workers KV binding. The webhook secret and URL belong only in private deployment configuration.

## HTTPS / WebDAV

For local development, place these values in `.dev.vars`. For deployment, edit `vars` in [`wrangler.jsonc`](../wrangler.jsonc).

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

## WebTransport

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
{
  "kv_namespaces": [{ "binding": "PINS", "id": "YOUR_NAMESPACE_ID" }]
}
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

KV updates are eventually consistent. Publish replacement pins ahead of certificate activation and keep an overlap window; a successful webhook does not mean every edge location has already observed the update. Use the connection dialog's **Connect** action to fetch current pins.

For local pinned-certificate development without KV, set `CERTIFICATES_JSON` in `.dev.vars` to the same document. The Vite development server does not emulate KV; use Wrangler for binding-based development.

## Deploy to Cloudflare Workers

The project uses Workers Static Assets, configured in [`wrangler.jsonc`](../wrangler.jsonc). `npm run deploy` builds the frontend into `dist/`, then Wrangler uploads that directory and the Worker together.

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
