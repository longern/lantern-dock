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

Use the same public site origin and issuer in the `.env` beside `compose.nas.yaml`:

```dotenv
SITE_ORIGIN="https://nas.example.com"
OIDC_ISSUER_URL="https://auth.example.com"
ADMIN_SUBJECTS='[]'
```

Rebuild and restart the NAS container:

```sh
docker compose -f compose.nas.yaml up -d --build
```

If you maintain your own bridge, add `/api/account` to its existing allowed paths, alongside `/dav` and `/api/uploads`. The NAS account API uses GET; the other existing method permissions remain necessary for DAV and uploads. A direct HTTPS reverse proxy must also forward `/api/account` unchanged. The NAS can continue serving plain HTTP privately behind the WebTransport bridge; it does not need a public HTTPS listener. It needs outbound HTTPS access to the LanternDock site to retrieve public signing keys.

Open **我的账户**, sign in, and copy the displayed administrator configuration into the NAS `.env`, for example:

```dotenv
ADMIN_SUBJECTS='["your-oidc-sub"]'
```

Recreate the NAS service and choose **重新检测** on the account page. Multiple administrators use a JSON array of their exact subjects. The NAS pairs each subject with the configured issuer; names and email addresses do not determine administrator status. An empty array grants nobody administrator access. There is no public first-user enrollment endpoint.

Without NAS connectivity, the verified login still displays `sub` for copying. The page only reports whether administrators are configured after the NAS responds. Without `OIDC_ISSUER_URL`, NAS identity verification is disabled and public browsing/file drops continue to work.

## Sessions and request verification

1. The LanternDock Worker handles the OIDC callback, verifies the ID token, and checks UserInfo's `sub` against it. SSO access and ID tokens stay server-side and are discarded after login.
2. The browser receives an encrypted, host-only session cookie lasting 30 minutes, with `HttpOnly`, `Secure` and `SameSite=Lax`. Login uses state, nonce and PKCE. Cookie-changing POST routes require the exact site Origin.
3. When checking its NAS identity, the browser presents the cookie to the Worker and receives a 60-second signed grant in memory. The Worker uses its own Ed25519 signing key, deterministically derived from `SECRET_KEY` with a purpose and site-specific label. This is separate from the login service's signing key and the certificate-webhook credential.
4. The grant is bound to a non-extractable browser ECDSA key stored in IndexedDB. NAS requests carry a DPoP-style signature binding the token, method, canonical site URL, timestamp and unique request ID. The NAS rejects replayed proofs using SQLite. Neither SSO tokens nor NAS grants are saved in local/session storage.
5. The NAS verifies the grant offline using the Worker's public JWKS at `/api/auth/jwks.json`, then computes the role from its own `ADMIN_SUBJECTS`. It checks issuer, audience, lifetime and browser proof. Public keys are cached for up to five minutes, with an earlier refresh for an unknown key ID. The NAS does not contact SSO or the Worker for each authenticated request.

Only login needs the SSO service. Grant renewal uses the valid Worker session cookie and the same browser key, without another SSO request. An expired grant alone cannot renew itself. The account page obtains a fresh grant when it checks the NAS; this release does not add a background renewal loop to public file browsing.

The NAS trusts the Worker as an identity issuer. A compromised Worker signing key could forge administrator subjects even though the role list is local to the NAS. Putting a signing key on the NAS would not remove this trust if the NAS still accepted arbitrary identities asserted by the Worker. Independent NAS authentication would require a different trust model.

HttpOnly cookies and browser-bound grants reduce credential theft/reuse; they do not make active same-origin XSS harmless. Frontend responses apply CSP, disallow inline scripts, and render identity fields as text. Same-origin malicious code could still make requests while running. Logging out clears the cookie; an already issued NAS grant can remain valid for at most its remaining 60 seconds. There is no server-side session revocation list or SSO back-channel logout in this release.

Rotating `SECRET_KEY` invalidates Worker cookies and changes its signing key and certificate webhook URL. Update the bridge webhook too. Existing NAS key caches can temporarily retain the previous public key, while previously issued grants still have their short expiry.

## Troubleshooting

- `AUTH_NOT_CONFIGURED`: check the Worker's site origin, issuer and existing secret. The metadata document only requires the site origin.
- Login returns an error: check Discovery/CIMD support, the provider's ability to fetch the client metadata URL, the exact callback, and HTTPS access from the Worker to the provider.
- Login succeeds but the NAS check fails: deploy the updated NAS binary, configure its issuer/site origin, allow `/api/account` in the bridge, and check NAS outbound HTTPS/DNS access to the Worker's JWKS endpoint. The page keeps `sub` visible.
- The role is still ordinary user: copy the exact `sub` into the NAS `ADMIN_SUBJECTS` JSON array, recreate the container so its environment changes, and recheck. Setting this variable only on the Worker does not grant NAS permissions.

`GET /api/account/config` reports NAS identity support without authentication. `GET /api/account` requires `Authorization: DPoP <grant>` plus its `DPoP` proof. Authentication errors return `401`; disabled NAS identity verification returns `503`.
