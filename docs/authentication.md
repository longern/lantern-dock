# OIDC login and NAS identities

[← Back to the project](../README.md)

LanternDock can use workers-sso through OIDC Discovery and Client ID Metadata Documents (CIMD). Public files and temporary collection links remain accessible without signing in. The account page at `/#/account` shows the signed-in identity, a copyable `sub`, and the role verified by the NAS.

This version recognizes administrators and ordinary users. Collection creation and revocation still use the NAS CLI; signing in does not expose new file-management or administrative write APIs.

## Configure the Worker

Add these public variables to the LanternDock Worker, keeping its existing `SECRET_KEY` secret:

```dotenv
SITE_ORIGIN="https://nas.example.com"
OIDC_ISSUER_URL="https://auth.example.com"
```

Use the exact HTTPS site origin, with no path or trailing slash, and the exact issuer advertised by the login service's Discovery document. Do not regenerate `SECRET_KEY` when enabling login.

With a CIMD-capable provider, no client registration or client secret is needed. The client ID is the public metadata URL `https://nas.example.com/api/auth/oidc/client.json`, with the fixed callback `https://nas.example.com/auth/callback`. The login service must be able to fetch that document. The provider must support Authorization Code flow and PKCE S256. workers-sso does not need source changes, additional private keys, or knowledge of NAS roles.

For an already registered OIDC client, optional `OIDC_CLIENT_ID` overrides CIMD. A confidential client can additionally use `OIDC_CLIENT_SECRET` as a Worker Secret if the provider supports `client_secret_post`; otherwise leave it unset. Configure the same callback in that registration. Browser login requires the configured HTTPS origin; the default HTTP Vite server is for UI and connection development.

## Configure the NAS

The NAS trusts the LanternDock site, not its external login provider. Configure only the public site origin in the `.env` beside `compose.nas.yaml`:

```dotenv
SITE_ORIGIN="https://nas.example.com"
ADMIN_SUBJECTS='[]'
```

Pull the updated image and recreate the NAS container with its new environment:

```sh
docker compose -f compose.nas.yaml pull nas
docker compose -f compose.nas.yaml up -d nas
```

If you maintain your own bridge, add `/api/account` to its existing allowed paths, alongside `/dav` and `/api/uploads`. The NAS account API uses GET; the other existing method permissions remain necessary for DAV and uploads. A direct HTTPS reverse proxy must also forward `/api/account` unchanged. When the direct HTTPS NAS endpoint uses a different origin from the frontend, set `NAS_RESOURCE_ORIGIN="https://files.example.com"` on the NAS to bind proofs to that actual endpoint. This optional setting defaults to `SITE_ORIGIN` for WebTransport.

The NAS can continue serving plain HTTP privately behind the WebTransport bridge; it does not need a public HTTPS listener. It needs outbound HTTPS access to the LanternDock site for authorization-server metadata and public signing keys. The Worker must route `/.well-known/oauth-authorization-server` to code, as included in `wrangler.jsonc`; a static SPA fallback must not intercept it.

Open **我的账户**, sign in, and copy the displayed administrator configuration into the NAS `.env`, for example:

```dotenv
ADMIN_SUBJECTS='["ld_your-site-sub"]'
```

Recreate the NAS service and choose **重新检测** on the account page. Multiple administrators use a JSON array of their exact **site subjects**. The NAS pairs each subject with the configured LanternDock origin; names and email addresses do not determine administrator status. An empty array grants nobody administrator access. There is no public first-user enrollment endpoint. Do not configure an SSO issuer, client ID or client secret on the NAS.

Without NAS connectivity, the verified login still displays its site `sub` for copying. The page only reports whether administrators are configured after the NAS responds. Setting `SITE_ORIGIN` enables NAS identity verification. With no site origin or administrators configured, standalone public browsing/file drops continue to work without identity verification.

## Sessions and request verification

1. The LanternDock Worker handles the OIDC callback, verifies the ID token, and checks UserInfo's `sub` against it. The external `(issuer, sub)` pair is mapped to a stable, opaque site user ID. SSO access and ID tokens stay server-side and are discarded after login. Upstream issuer and raw subject are not forwarded to the NAS or stored in its configuration.
2. The browser receives an encrypted, host-only session cookie lasting 30 minutes, with `HttpOnly`, `Secure` and `SameSite=Lax`. Login uses state, nonce and PKCE. Cookie-changing POST routes require the exact site Origin.
3. When checking its NAS identity, the browser uses the discovered token endpoint, presenting its cookie and a DPoP proof. It handles the server's `DPoP-Nonce` challenge automatically and receives a 60-second JWT access token in memory. Responses use `access_token`, `token_type`, `expires_in` and `scope`. The Worker uses its own Ed25519 signing key, deterministically derived from `SECRET_KEY` with a purpose, site and key version. This is separate from the login service's signing key and the certificate-webhook credential.
4. The token is bound to a non-extractable browser ECDSA key stored in IndexedDB. NAS requests carry a DPoP signature binding the token, method, canonical resource URL, timestamp and unique request ID. The NAS rejects replayed proofs using SQLite. Neither SSO tokens nor NAS grants are saved in local/session storage.
5. The NAS retrieves `/.well-known/oauth-authorization-server`, validates the configured portal issuer, and obtains public keys through its `jwks_uri`. It verifies access-token type, signature, issuer, audience, required claims, lifetime, `account:read` scope and browser proof, then computes the role from `ADMIN_SUBJECTS`. Discovery and the local public-key cache refresh on demand after five minutes, with an earlier JWKS refresh for an unknown key ID. The NAS does not contact SSO or the Worker for each authenticated request.

Only login needs the SSO service. The resulting site session and NAS grant renewal use the Worker's own identity and browser key; they keep working for the remaining site-session lifetime even if the upstream login service is unavailable or its configuration is removed. New login requires Worker `OIDC_ISSUER_URL`; NAS discovery/JWKS and existing site sessions do not. An expired grant alone cannot renew itself. The account page obtains a fresh grant when it checks the NAS; this release does not add a background renewal loop to public file browsing.

The mapping uses a versioned SHA-256 digest of the upstream issuer and subject, without the site's signing secret. Repeated logins, restarts and signing-secret/key-version rotation keep the site ID stable. Different upstream identities produce different site IDs, even if their raw subjects match. Linking two external identities to one site account is not implemented; it must not happen implicitly based on a matching email or subject.

## Upgrade from upstream subjects

Identity protocol version 2 replaces the earlier upstream subjects with site subjects. Update both Worker and NAS, refresh the account page and sign in again. Copy the new `ld_…` site subject into NAS `ADMIN_SUBJECTS` if you previously configured an upstream subject. Older session cookies and version-1 identity tokens are rejected; no compatibility alias silently grants privileges to an external subject. Existing private data, collection links and public WebDAV are unchanged. Signing-key versions remain independent of this protocol version.

The NAS trusts the Worker as an identity issuer. A compromised Worker signing key could forge administrator subjects even though the role list is local to the NAS. Putting a signing key on the NAS would not remove this trust if the NAS still accepted arbitrary identities asserted by the Worker. Independent NAS authentication would require a different trust model.

HttpOnly cookies and browser-bound grants reduce credential theft/reuse; they do not make active same-origin XSS harmless. Frontend responses apply CSP, disallow inline scripts, and render identity fields as text. Same-origin malicious code could still make requests while running. Logging out clears the cookie; an already issued NAS grant can remain valid for at most its remaining 60 seconds. There is no server-side session revocation list or SSO back-channel logout in this release.

See the [identity protocol](identity-protocol.md) for metadata, the session extension grant, required JWT claims, DPoP behavior and error responses. This is a focused NAS identity profile, not a general-purpose OAuth authorization server. The Worker uses time-bound nonces without a global single-use proof database; the NAS persists resource-proof replay checks.

## Rotate NAS signing keys

Normal deployments need no additional variable: the default signing version is `v1`, preserving the original signing key. Optional Worker variable `AUTH_SIGNING_KEY_VERSIONS` is an ordered JSON array. The first version signs tokens; all listed versions publish verification keys. It contains version labels, not secrets. Labels must be unique, use letters/digits/underscore/hyphen, and be at most 32 characters; at most eight versions are accepted.

To rotate while preserving existing sessions and the certificate webhook:

1. Set `AUTH_SIGNING_KEY_VERSIONS='["v1","v2"]'` and deploy. This prepublishes the next public key while still signing with `v1`. Wait at least six minutes for existing public-key caches.
2. Set `AUTH_SIGNING_KEY_VERSIONS='["v2","v1"]'` and deploy. New tokens use `v2`; both keys verify during the overlap. Wait at least six minutes after rollout so old tokens have expired and caches can refresh.
3. Set `AUTH_SIGNING_KEY_VERSIONS='["v2"]'` and deploy. The old key is no longer published; NAS caches retire it on refresh. Use a new label such as `v3` for the next rotation. Reusing a retired label recreates its old key.

No NAS private key, SSO change, new master secret or manual public-key copy is needed. `kid` is derived from the public key, so array reordering does not change key identifiers. Invalid version lists fail closed rather than silently choosing another signing key.

This procedure is for routine signing-key rotation. A compromised `SECRET_KEY` can derive every version: rotate that master secret instead. Doing so invalidates Worker cookies and changes the signing keys and certificate webhook URL; update the bridge webhook too. Offline NAS caches can temporarily retain previously trusted public keys, so key removal is not an instantaneous revocation mechanism.

## Troubleshooting

- `AUTH_NOT_CONFIGURED`: check the Worker's site origin and existing secret. `OIDC_NOT_CONFIGURED` applies to new login and requires the issuer **on the Worker only**. The CIMD client metadata document only requires the site origin.
- Login returns an error: check Discovery/CIMD support, the provider's ability to fetch the client metadata URL, the exact callback, and HTTPS access from the Worker to the provider.
- Login succeeds but the NAS check fails: update both Worker and NAS, configure NAS `SITE_ORIGIN`, allow `/api/account` in the bridge, and check NAS outbound HTTPS/DNS access to the Worker's Discovery/JWKS endpoints. For direct HTTPS, check `NAS_RESOURCE_ORIGIN` against the backend URL. The page keeps the site `sub` visible.
- The role is still ordinary user: copy the exact `sub` into the NAS `ADMIN_SUBJECTS` JSON array, recreate the container so its environment changes, and recheck. Setting this variable only on the Worker does not grant NAS permissions.

`GET /api/account/config` reports NAS identity support without authentication. `GET /api/account` requires `Authorization: DPoP <grant>` plus its `DPoP` proof. Authentication errors return `401`; disabled NAS identity verification returns `503`.
