<div align="center">

# LanternDock

**A front door for your self-hosted files.**

Browse, preview, and download from your own WebDAV server — directly over HTTPS or WebTransport.

[![Status: experimental](https://img.shields.io/badge/status-experimental-e8aa42?style=flat-square)](#project-status)
[![Node.js ≥22.12](https://img.shields.io/badge/Node.js-%E2%89%A522.12-43853d?style=flat-square)](#quick-start)
[![Preact](https://img.shields.io/badge/UI-Preact-673ab8?style=flat-square)](https://preactjs.com/)
[![Cloudflare Workers](https://img.shields.io/badge/deploy-Cloudflare_Workers-f38020?style=flat-square)](#deploy)

[Quick start](#quick-start) · [Configuration](docs/configuration.md) · [Development](docs/development.md) · [Report a bug](https://github.com/longern/lantern-dock/issues)

</div>

![LanternDock desktop file browser with a selected image and a preview panel](docs/assets/desktop.png)

<details>
<summary>Mobile preview</summary>
<br>
<img src="docs/assets/mobile.png" width="320" alt="LanternDock mobile image preview with file details and a download action">
</details>

_Screenshots show the built-in demo. The current interface is in Chinese._

## Why LanternDock?

Give visitors a simple interface to files you already host. LanternDock provides the browser UI and connection setup; your existing WebDAV service handles storage and permissions. Host the frontend on Cloudflare Workers and let visitors fetch files directly from the source.

## Features

- **Browse your files.** Directory navigation, search within the current directory, sorting, and list or grid views.
- **Preview before downloading.** Open images and text in a desktop side panel or a full-screen mobile preview.
- **Download with control.** Progress, cancellation, and streaming to disk when the browser supports a file picker.
- **Pick up where you left off.** Favorites and recent files stored in the visitor's browser.
- **Connect your way.** HTTPS / WebDAV, or WebDAV through [webtransport-bridge](https://github.com/longern/webtransport-bridge).
- **Keep credentials separate.** Backend Basic or Bearer authentication, plus an optional bridge token. Credentials stay in page memory.
- **Set up with guidance.** A first-run wizard generates local or Cloudflare configuration, with an explicit demo option.
- **Host a public NAS folder.** The optional Go server provides anonymous, read-only WebDAV while keeping private state separate.
- **Receive files without accounts.** Expiring, revocable upload links enforce file-size, capacity and file-count limits on the NAS.
- **Use your existing SSO.** OIDC/CIMD login displays a copyable user subject; the NAS recognizes administrators from its environment configuration.

## Quick start

Requires **Node.js 22.12+** and npm.

```sh
git clone https://github.com/longern/lantern-dock.git
cd lantern-dock
npm ci
npm run init
npm run dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). With no backend configured, a setup wizard guides you through the connection options, generates configuration, and lets you recheck after applying it. Choose **先体验演示** to explore sample files without configuring a server. This temporary demo choice is not saved; `DEMO_MODE="true"` enables a site-wide demo.

### Connect a WebDAV server

Edit the `.env` created by `npm run init`, keeping its generated `SECRET_KEY`. Add your connection URL before restarting the server:

```dotenv
WEBDAV_URL="https://files.example.com/dav/public/"
```

Run `npm run dev` again. LanternDock derives the server origin and root directory from the URL. The default name, authentication choice, and other settings can stay unset. For a protected backend, optionally set `BACKEND_AUTH="basic"` or `"bearer"` to preselect the login method; visitors enter credentials in the connection dialog.

The backend needs WebDAV `PROPFIND` with `Depth: 1`, plus `GET` and `HEAD`. Direct HTTPS connections also need CORS configured for the frontend origin.

For a bridge, use `WEBTRANSPORT_URL` instead of `WEBDAV_URL`. They are mutually exclusive; no separate transport variable is needed. See the [configuration guide](docs/configuration.md) for WebTransport, optional settings, CORS, and certificate updates.

### Use the included NAS backend

The optional [`server/`](server/) backend combines public read-only WebDAV with private file drops. The NAS issues upload permissions and enforces quotas in SQLite; uploaded files stay in its private inbox until you choose to publish them. Visitors need only their collection link, with no account registration.

Use [`compose.nas.yaml`](compose.nas.yaml) for the NAS backend plus WebTransport bridge. See the [NAS deployment guide](docs/nas-server.md) for folder mounts, frontend configuration, and CLI commands to create and revoke collection links.

### Sign in with workers-sso

Set `SITE_ORIGIN` and `OIDC_ISSUER_URL` on the Worker and NAS. Open **我的账户**, sign in, and copy your `sub` into the NAS `ADMIN_SUBJECTS` JSON array. The Worker signs short-lived, browser-bound credentials; the NAS verifies them locally and determines the role. See [authentication setup](docs/authentication.md) for deployment, cookies, key ownership and security boundaries. workers-sso requires no changes.

## How it works

```mermaid
flowchart LR
    Worker["Cloudflare Worker"] -->|"App, configuration, certificate pins"| Browser
    Browser -->|"HTTPS / WebDAV"| Files["Your WebDAV server"]
    Browser -->|"WebTransport"| Bridge["webtransport-bridge"]
    Bridge -->|"HTTP / WebDAV"| Files
```

The Worker serves the frontend and `/api/config`. File contents travel directly between the browser and the configured backend or bridge.

Both connection modes use WebDAV for file access. The bridge carries one HTTP/1.1 exchange per WebTransport bidirectional stream using a project-specific mapping. WebTransport requires a compatible browser, a secure frontend context, and a reachable UDP endpoint; there is no automatic HTTPS fallback.

## Deploy

1. Authenticate and deploy:

   ```sh
   npx wrangler login
   npm run deploy
   ```

2. Open the deployed site and complete the setup wizard. Copy its `.env` into the Cloudflare dashboard's variables import, **manually mark `SECRET_KEY` as Secret**, then deploy the variable changes and recheck.
3. Allow the deployed frontend origin in the backend's CORS policy or the bridge's origin policy.

The deploy command builds the Preact frontend into `dist/` and uploads it with the Worker. The wizard generates a key for a new deployment and preserves existing keys. Dashboard variables survive later Wrangler deployments; you can also configure public variables in [`wrangler.jsonc`](wrangler.jsonc). Local `.env` settings are not automatically uploaded. The deployment configuration automatically provisions or reuses the `KV` binding. Pinned WebTransport also needs a private certificate webhook; follow the [deployment and certificate setup](docs/configuration.md#certificate-updates).

## Project status

LanternDock is in early development. Public browsing is **read-only WebDAV**. The optional NAS backend adds **private uploads through scoped collection links** and **OIDC identity/administrator recognition**. Collection management currently uses the NAS CLI. General file editing, public share management, resumable uploads, and task execution remain future work.

| Area           | Current behavior                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Previews       | Images up to 25 MiB; text up to 1 MiB. Video, audio, PDF, and archive previews are not available yet.                                                                                           |
| Downloads      | Stream to disk when supported; otherwise buffer in memory with a 256 MiB limit.                                                                                                                 |
| Directories    | Directory responses are limited to 8 MiB. Search and type filters apply to the current directory.                                                                                               |
| Image listings | Real backend files use generic icons; images load when opened for preview.                                                                                                                      |
| Local records  | Favorites and recent paths use local storage. Backend credentials and NAS grants stay in memory; login uses an HttpOnly cookie and a non-extractable browser key in IndexedDB.                  |
| File drops     | NAS-issued links with expiry, revocation, per-file and total byte limits, and file-count quotas. Files upload sequentially with progress and cancellation; incomplete files must be sent again. |
| Validation     | Chromium desktop and mobile viewports, plus local real-bridge integration tests. Physical devices and individual backends need further testing.                                                 |

`BACKEND_ROOT` controls navigation. Enforce permissions and path restrictions on the backend or bridge.

## Roadmap

- [x] Add OIDC/CIMD login and NAS-enforced administrator identities.
- [x] Add expiring, revocable guest upload grants with explicit scopes and quotas.
- [x] Support scoped guest uploads and upload-only entry points.
- [ ] Support resumable uploads and a web interface for managing collections.
- [ ] Expose predefined, authorized tasks such as media conversion.
- [ ] Improve backend thumbnails and preview coverage.

These features require backend enforcement as well as interface work. Track proposals and discuss priorities in [Issues](https://github.com/longern/lantern-dock/issues).

## Contributing

Bug reports, documentation improvements, and pull requests are welcome. For a bug report, include your browser version, connection mode, reproduction steps, and relevant errors. Remove credentials and private webhook URLs from logs before sharing them.

For larger changes, open an issue first to discuss the approach. To check code changes locally:

```sh
npm run check
npm test
```

See the [development guide](docs/development.md) for the project layout, browser tests, and integration tests against a real bridge.
