# Configuration

For an anonymous public NAS folder and temporary private collection links, see the [included NAS backend](nas-server.md). It provides `/dav/` and `/api/uploads` behind the same bridge; the Worker does not issue upload permissions or proxy file bodies.

[← Back to the project](../README.md)

LanternDock serves one configured WebDAV root. Configure it in `.env` for Vite development and through the Cloudflare dashboard or `wrangler.jsonc` for deployment. Restart the development server after changing local settings.

The setup wizard has two steps: **Connect a backend** combines transport selection, the connection address, and optional advanced settings; **Save and deploy** exports the site `.env` and, for pinned WebTransport, its matching bridge configuration. Only local development and Cloudflare Workers are deployment choices. Wrangler JSON is available under **Other deployment methods**. The page does not write server configuration or persist inputs.

Once the WebTransport address and site key are configured, `missing-certificates` opens a focused certificate page showing the saved address, publication steps, and a recheck action. It does not repeat environment exports or offer to replace the key. If the key is still missing, the wizard first opens **Save and deploy** to generate the paired key and webhook URL. After applying configuration, recheck the current site; a localhost export for a different Cloudflare site instead opens that deployed site.

Credentials are entered in the connection dialog and kept in page memory. The public `/api/config` document contains connection metadata and certificate pins.

Optional [OIDC/CIMD login](authentication.md) uses separate account endpoints and an HttpOnly cookie. Configure `SITE_ORIGIN` and `OIDC_ISSUER_URL` on both Worker and NAS; configure `ADMIN_SUBJECTS` on the NAS. These settings are independent of the backend connection wizard.

## Choose one connection URL

Only one address variable is needed for direct WebDAV:

```dotenv
WEBDAV_URL="https://files.example.com/dav/public/"
```

The browser connects to `https://files.example.com` and browses `/dav/public/`. For WebTransport, use `WEBTRANSPORT_URL` instead. Setting both nonempty URLs opens the setup wizard so the maintainer can choose one. Empty URL variables are ignored.

## Site key and local environment

```sh
npm run init
```

Initialization appends a cryptographically random 32-byte `SECRET_KEY` to `.env` without replacing existing connection settings. Repeated runs reuse the key. The file is excluded from Git and initialized with owner-only permissions. Production uses a Worker Secret named `SECRET_KEY`, outside the public `vars` block.

The certificate-update token is `HMAC-SHA256(SECRET_KEY, "lantern-dock:certificate-webhook:v1")`. OIDC sessions and NAS signing keys use separate, site-specific purpose labels; the master key stays server-side and is never returned by the configuration API. Certificate renewal and service restarts keep the URL stable. Changing `SECRET_KEY` changes the derived URL and signing key and invalidates login cookies, so update the bridge when rotating it. Existing certificate pins stay in KV.

A sole legacy `.dev.vars` file is moved to `.env` by initialization, preserving its contents. If both exist, initialization asks the maintainer to consolidate them first rather than silently choose a key. The runtime retains Wrangler's legacy precedence: `.dev.vars` wins when it exists; otherwise it loads `.env`. Explicit process variables override local values in the Vite adapter. Use only `.env` for new setups.

## Optional settings

Defaults can stay unset. For a new deployment without a valid site key, the wizard generates a cryptographically random 32-byte `SECRET_KEY` using Web Crypto in the current browser. Its contents are masked by default; **Copy configuration** and **Download configuration** include the full key in `.env`. The pending key and deployment address stay in page memory while editing or retrying unapplied settings. Once a deployed key is detected, the wizard preserves it and stops exporting the pending key. Refreshing the page discards unsaved values. The page does not save it in browser storage or send it to the server.

If the server already has a valid key, the wizard reports only that fact and leaves `SECRET_KEY` out of its export. Preserve the existing key. **Generate a key for a new deployment**, under **Other deployment methods**, explicitly creates a separate key; it does not change the running site. The wizard never reads the existing key. The Wrangler JSON export always excludes the key: store it as a Worker Secret instead of a plain `vars` value.

When using the wizard on localhost, switching to a Cloudflare export prepares a new deployment with its own random key, even if the local environment already has one. Switching back to local development preserves the local key and omits it from the export. A deployed site's existing key is preserved by default.

Downloads are named `lantern-dock.env` so browsers do not rename a hidden `.env` file. Merge settings into the project's `.env`, preserving an existing key. Advanced controls stay collapsed; connection settings include only the selected URL, non-default values, and any required resets.

| Variable            | Default                                      | Description                                                                                                |
| ------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `WEBDAV_URL`        | Unset                                        | Complete HTTP(S) WebDAV URL, including the mount path. Choose this or `WEBTRANSPORT_URL`.                  |
| `WEBTRANSPORT_URL`  | Unset                                        | Complete HTTPS bridge session URL. Choose this or `WEBDAV_URL`.                                            |
| `BACKEND_NAME`      | `我的文件`                                   | Resource name shown in the interface.                                                                      |
| `BACKEND_ROOT`      | Path from `WEBDAV_URL`; `/` for WebTransport | Optional root override. WebTransport's session URL does not identify the WebDAV directory.                 |
| `BACKEND_AUTH`      | `none`                                       | Optional login-form preset: `none`, `basic`, or `bearer`. The backend enforces authentication.             |
| `GATEWAY_AUTH`      | `true` for WebTransport                      | Show a separate bridge-token field. Set `false` to hide it for a public bridge. Ignored for direct WebDAV. |
| `CERTIFICATE_MODE`  | `pinned`                                     | Certificate hashes by default; use `webpki` for a publicly trusted gateway certificate.                    |
| `CERTIFICATES_JSON` | Unset                                        | Local certificate document when no `KV` binding is available.                                              |
| `DEMO_MODE`         | `false`                                      | Set `true` for a site-wide sample-only experience. Otherwise, an unconfigured site opens the wizard.       |
| `SECRET_KEY`        | Generated by the wizard or `npm run init`    | Site-wide private key; certificate webhook tokens are derived from it.                                     |

When updating an existing deployment, the wizard may also emit a value that resets an old override, or an empty string to clear the other URL. Those entries are necessary to apply the chosen connection without leaving conflicting variables behind. A direct WebDAV root override is folded into the generated URL; the wizard clears an existing `BACKEND_ROOT` override when needed.

The repository declares a Workers KV binding named `KV`. Wrangler 4.45+ preserves an existing deployed binding with that name, or automatically creates and binds a namespace on first deployment. No account-specific namespace ID is required in this shared configuration. Keep `SECRET_KEY` and the webhook URL in private deployment configuration.

For an existing deployment, rename the old `PINS` binding to `KV` while keeping the same namespace ID. The stored `certificate-pins` key is unchanged, so certificate data does not need to move. Renaming the namespace itself does not create a binding: the Worker variable name must be exactly `KV`. The setup response at `/api/config` includes `setup.hasKV` when setup is required, and the certificate page calls out a missing binding.

### Existing configurations

`BACKEND_ENDPOINT` and `BACKEND_TRANSPORT` remain supported. A nonempty `WEBDAV_URL` or `WEBTRANSPORT_URL` takes precedence over that legacy pair. Explicit `BACKEND_ROOT`, authentication, and certificate settings remain supported. There is no need to migrate a working deployment immediately.

Existing `CERT_WEBHOOK_SECRET` credentials remain accepted during migration, including when `SECRET_KEY` is also present. Deploy the site key, generate the new derived URL, and update the bridge; remove the old Worker Secret when the old URL should stop working. The old `.webhook-secret` file is not reused as a master key.

## HTTPS / WebDAV

Use the full WebDAV URL in `.env` locally or in the `vars` object of [`wrangler.jsonc`](../wrangler.jsonc):

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

The pinned-certificate setup wizard generates the **site key and certificate Webhook URL together**, in the same setup step. On a deployed HTTPS site, the URL uses the current origin; from local development, enter the HTTPS origin of the LanternDock Worker. No key needs to be pasted back into the page. The key stays in page memory, and the public configuration API never returns the private URL.

Save both configuration files before deploying: **Download configuration** saves the site settings, including `SECRET_KEY`, as `lantern-dock.env`; **Download bridge.env** saves `CERT_WEBHOOK_URL` for the bridge. Merge the bridge settings into its existing `.env`. You can also click **Copy Webhook URL** and paste the value into the bridge's `CERT_WEBHOOK_URL`. Deploy the same `SECRET_KEY` as a Worker Secret, add a KV binding named `KV`, and run the bridge with `--auto-cert`. The bridge can then publish certificate pins and renew them automatically. Return to the wizard and recheck after publication. This panel is unnecessary for direct WebDAV or publicly trusted WebTransport certificates.

For an already configured site, reuse the URL saved during initialization. If it was not saved, the CLI below recomputes the same URL from the existing local key; the wizard does not ask for the deployed key or rotate it.

Use the same site key for the Worker and local webhook generation. If the wizard generated your deployment key, save that exported `SECRET_KEY` in the local `.env` before running these commands. Otherwise initialize a key with `npm run init` and deploy it as a Worker Secret. An unrelated local key produces a different webhook URL.

The default `wrangler.jsonc` already declares KV for automatic provisioning. To use a particular existing namespace instead, set its ID explicitly:

```json
{
  "kv_namespaces": [{ "binding": "KV", "id": "YOUR_NAMESPACE_ID" }]
}
```

Generate a private webhook URL, replacing the example Worker origin:

```sh
npm run webhook -- https://lantern-dock.example.workers.dev
```

The command initializes `SECRET_KEY` in `.env` if needed, reuses it on later runs, and prints a purpose-derived webhook URL. It never puts the master key in that URL. Store the same key as a Worker Secret:

```sh
node scripts/init.mjs --print-secret | npx wrangler secret put SECRET_KEY
```

Use the direct `node` command when piping the key so npm's log banner is not included. The key is printed only when `--print-secret` is explicitly requested. The default `npm run init` output contains no key value.

Configure the printed URL as the bridge's `CERT_WEBHOOK_URL`. Treat the URL as a credential and avoid sharing it or recording it in public logs. New setups do not need a separate `CERT_WEBHOOK_SECRET`.

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

Use the actual certificate dates and digest; this is a format example. At most two certificate pins are accepted, each with a validity period of at most 14 days. Expired pins are excluded. The Worker responds with `204` only after the KV write succeeds. `405` means the request must use PUT; `503` with `MISSING_KV_BINDING` means the Worker has no KV namespace bound as `KV`; `503` with `INVALID_SITE_KEY` means the webhook credentials are missing or invalid. Storage failures also return `503`. With valid deployment settings, `401` with `INVALID_WEBHOOK_TOKEN` means the URL token does not match this deployment. The response includes a `WWW-Authenticate: Webhook` challenge for the URL credential. Query parameters are rejected with `400` and `INVALID_WEBHOOK_URL`; unknown routes return `404`. A changed `SECRET_KEY` requires the matching derived webhook URL.

KV updates are eventually consistent. Publish replacement pins ahead of certificate activation and keep an overlap window; a successful webhook does not mean every edge location has already observed the update. Use the connection dialog's **Connect** action to fetch current pins.

For local pinned-certificate development without KV, set `CERTIFICATES_JSON` in `.env` to the same document. The Vite development server does not emulate KV; use Wrangler for binding-based development.

## Deploy to Cloudflare Workers

The project uses Workers Static Assets, configured in [`wrangler.jsonc`](../wrangler.jsonc). `npm run deploy` builds the frontend into `dist/`, then Wrangler uploads that directory and the Worker together.

1. Authenticate and deploy the app. Leaving both connection URLs blank opens the setup wizard:

   ```sh
   npx wrangler login
   npm run deploy
   ```

2. Open the deployed site and complete the wizard. On **Cloudflare Workers**, copy the complete `.env` and paste it into the dashboard's **Variables and Secrets** import.
3. **Manually mark `SECRET_KEY` as Secret before deploying.** Keep connection variables such as `WEBDAV_URL` as Text. If the wizard preserves an existing key, leave that Worker Secret in place.
4. Deploy the variable changes, return to the wizard, and recheck. Allow the deployed frontend origin in the backend CORS policy or bridge origin policy.
5. For pinned WebTransport, also bind KV and configure the derived certificate webhook, then let the bridge publish its certificate before connecting.

The repository sets `keep_vars: true` and ships an empty `vars` object so a later Wrangler deploy preserves ordinary variables configured through the dashboard. KV has a separate explicit `kv_namespaces` declaration: `keep_vars` does not preserve resource bindings. Keep that declaration when using dashboard bindings or a later deploy can remove them. Values explicitly added to `wrangler.jsonc` override matching dashboard values. Secrets are stored separately.

For CLI deployment, use **Other deployment methods → Download Wrangler JSON** for public variables and set `SECRET_KEY` with `wrangler secret put`. The local `.env` file is not automatically uploaded to production; the dashboard import is an explicit step. Keep `DEMO_MODE` unset in production unless you intentionally want a sample-only site.

See Cloudflare's [automatic resource provisioning](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/) for namespace creation and reuse.

See Cloudflare's [Static Assets](https://developers.cloudflare.com/workers/static-assets/) and [KV setup](https://developers.cloudflare.com/kv/get-started/) documentation for platform configuration.

See [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/) for secret storage and local-file precedence.
