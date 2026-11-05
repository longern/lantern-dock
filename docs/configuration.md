# Configuration

[← Back to the project](../README.md)

LanternDock serves one configured WebDAV root. Configure it in `.dev.vars` for Vite development and in `wrangler.jsonc` for Cloudflare deployment. Restart the development server after changing local settings.

Missing or invalid backend settings, and missing certificate pins, open a setup wizard. It generates `.dev.vars` or a `vars` block for `wrangler.jsonc`, supports copy/download, and rechecks `/api/config` after the maintainer applies the settings. The public page does not write server configuration or persist wizard inputs. Apply local settings and restart Vite, or update the Worker variables and redeploy.

Credentials are entered in the connection dialog and kept in page memory. The public `/api/config` document contains connection metadata and certificate pins.

## Choose one connection URL

Only one address variable is needed for direct WebDAV:

```dotenv
WEBDAV_URL="https://files.example.com/dav/public/"
```

The browser connects to `https://files.example.com` and browses `/dav/public/`. For WebTransport, use `WEBTRANSPORT_URL` instead. Setting both nonempty URLs opens the setup wizard so the maintainer can choose one. Empty URL variables are ignored.

## Optional settings

Defaults can stay unset. The wizard keeps advanced controls collapsed and exports only the selected URL and values that differ from the defaults.

| Variable              | Default                                      | Description                                                                                                |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `WEBDAV_URL`          | Unset                                        | Complete HTTP(S) WebDAV URL, including the mount path. Choose this or `WEBTRANSPORT_URL`.                  |
| `WEBTRANSPORT_URL`    | Unset                                        | Complete HTTPS bridge session URL. Choose this or `WEBDAV_URL`.                                            |
| `BACKEND_NAME`        | `我的文件`                                   | Resource name shown in the interface.                                                                      |
| `BACKEND_ROOT`        | Path from `WEBDAV_URL`; `/` for WebTransport | Optional root override. WebTransport's session URL does not identify the WebDAV directory.                 |
| `BACKEND_AUTH`        | `none`                                       | Optional login-form preset: `none`, `basic`, or `bearer`. The backend enforces authentication.             |
| `GATEWAY_AUTH`        | `true` for WebTransport                      | Show a separate bridge-token field. Set `false` to hide it for a public bridge. Ignored for direct WebDAV. |
| `CERTIFICATE_MODE`    | `pinned`                                     | Certificate hashes by default; use `webpki` for a publicly trusted gateway certificate.                    |
| `CERTIFICATES_JSON`   | Unset                                        | Local certificate document when no `PINS` binding is available.                                            |
| `DEMO_MODE`           | `false`                                      | Set `true` for a site-wide sample-only experience. Otherwise, an unconfigured site opens the wizard.       |
| `CERT_WEBHOOK_SECRET` | Unset                                        | Private Worker secret for certificate updates.                                                             |

When updating an existing deployment, the wizard may also emit a value that resets an old override, or an empty string to clear the other URL. Those entries are necessary to apply the chosen connection without leaving conflicting variables behind. A direct WebDAV root override is folded into the generated URL; the wizard clears an existing `BACKEND_ROOT` override when needed.

Pinned WebTransport deployments also need a `PINS` Workers KV binding. Keep the webhook secret and URL in private deployment configuration.

### Existing configurations

`BACKEND_ENDPOINT` and `BACKEND_TRANSPORT` remain supported. A nonempty `WEBDAV_URL` or `WEBTRANSPORT_URL` takes precedence over that legacy pair. Explicit `BACKEND_ROOT`, authentication, and certificate settings remain supported. There is no need to migrate a working deployment immediately.

## HTTPS / WebDAV

Use the full WebDAV URL in `.dev.vars` locally or in the `vars` object of [`wrangler.jsonc`](../wrangler.jsonc):

```dotenv
WEBDAV_URL="https://files.example.com/dav/public/"
```

For a protected backend, optionally add `BACKEND_AUTH="basic"` or `"bearer"`. Visitors supply their credentials in the connection dialog.

The backend must support WebDAV `PROPFIND` with `Depth: 1`, plus `GET` and `HEAD`. A plain HTTP directory listing is not sufficient. Configure CORS on the backend for your frontend origin:

- Methods: `GET`, `HEAD`, `PROPFIND`, and preflight `OPTIONS`.
- Request headers: `Authorization`, `Content-Type`, and `Depth` as needed.
- Exposed response headers: `Content-Length`, `Content-Type`, `Content-Disposition`, `ETag`, `Accept-Ranges`, and `Content-Range` as needed.

The frontend does not use ambient backend cookies. Basic and Bearer credentials are sent explicitly. Production backends should use HTTPS; an HTTPS frontend cannot ordinarily fetch an insecure HTTP backend.

`BACKEND_ROOT` is a navigation setting, not an access-control boundary. Enforce read permissions and directory restrictions on the backend or bridge itself. The connection document is public and includes the backend address and certificate pins, never stored backend credentials.

## WebTransport

```dotenv
WEBTRANSPORT_URL="https://bridge.example.com:4433/webtransport"
BACKEND_ROOT="/public/"
```

The endpoint is the complete WebTransport session URL. Configure the bridge to permit the frontend origin and `GET`, `HEAD`, and **`PROPFIND`**. Restrict its allowed paths and backend permissions to the intended resources. WebTransport requires a compatible browser, a secure frontend context, and network reachability to the bridge's UDP port.

The bridge-token field is shown by default. Visitors enter a bridge token separately from their backend credentials. Set `GATEWAY_AUTH="false"` to hide that field for a public bridge. The bridge must consume `Proxy-Authorization`; the backend's `Authorization` stays intact. This header is encoded inside the WebTransport stream, not sent through browser Fetch.

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

1. Configure the real backend in `wrangler.jsonc`. Leaving both connection URLs blank opens the setup wizard.
2. Authenticate Wrangler and deploy:

   ```sh
   npx wrangler login
   npm run deploy
   ```

3. Allow the deployed frontend origin in the backend CORS policy or bridge origin policy.
4. For pinned WebTransport, configure KV and the webhook, then let the bridge publish its certificate before connecting.

`.dev.vars` is for local development; it is not the production configuration. Keep `DEMO_MODE` unset in production unless you intentionally want a sample-only site.

See Cloudflare's [Static Assets](https://developers.cloudflare.com/workers/static-assets/) and [KV setup](https://developers.cloudflare.com/kv/get-started/) documentation for platform configuration.
