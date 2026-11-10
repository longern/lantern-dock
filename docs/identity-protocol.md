# NAS identity protocol, version 2

This document defines the contract between the LanternDock Worker, browser and NAS. It uses OAuth authorization-server metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html)), JWT access tokens ([RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html)), JWKS ([RFC 7517](https://www.rfc-editor.org/rfc/rfc7517.html)) and DPoP ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html)).

LanternDock is an OIDC client of workers-sso and a separate issuer of NAS access tokens. Its token endpoint supports a **project-specific session extension grant**, following RFC 6749 section 4.5. It does not offer general client registration, its own OIDC authorization endpoint, refresh tokens or third-party application authorization. The existing site cookie authenticates the user; `client_id` identifies the built-in public browser client and is not a secret.

## Discovery and trust

For a portal at `https://nas.example.com`, retrieve:

```http
GET /.well-known/oauth-authorization-server HTTP/1.1
Host: nas.example.com
Accept: application/json
```

```json
{
  "issuer": "https://nas.example.com",
  "jwks_uri": "https://nas.example.com/api/auth/jwks.json",
  "token_endpoint": "https://nas.example.com/api/auth/token",
  "grant_types_supported": ["urn:lantern-dock:params:oauth:grant-type:session"],
  "response_types_supported": [],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": [
    "account:read",
    "links:read",
    "links:write",
    "inbox:read"
  ],
  "dpop_signing_alg_values_supported": ["ES256"],
  "lantern_dock": {
    "protocol_version": 2,
    "resource": "https://nas.example.com/nas"
  }
}
```

`lantern_dock` is a project extension. The empty response-type list is intentional: this issuer only supports the session extension grant. OIDC login Discovery belongs to the upstream SSO issuer and is a separate document used only by the Worker during login. The NAS needs only `SITE_ORIGIN`, not any OIDC/SSO configuration.

The NAS starts from its configured `SITE_ORIGIN`, validates an exact metadata issuer match, and fetches the advertised `jwks_uri`. In this profile the JWKS URL must be HTTPS on the same origin, without credentials, query or fragment. Redirects are rejected. The NAS never follows a token-supplied `jku`, `x5u` or issuer URL to decide whom to trust.

The Worker derives its issuer from the HTTPS request URL by default. Optional Worker `SITE_ORIGIN` pins a canonical origin and rejects other request origins. Forwarded headers do not choose the issuer. Sessions and signing keys are scoped to the resulting site origin; the NAS always uses its explicitly configured trusted origin.

Discovery is lazy, on the first authenticated request. Metadata and its remote key cache are renewed after five minutes on demand; unknown signing-key IDs can refresh JWKS sooner. There is no background polling and no per-file Worker call. Retrieval uses bounded bodies and a ten-second HTTP timeout. Discovery failures return `503`; an invalid token or proof returns `401`. A valid existing cache can continue working until its refresh boundary; expired discovery does not silently fall back to another issuer or anonymous access.

## Session grant and nonce retry

The browser calls the discovered token endpoint with its HttpOnly site cookie, the exact site `Origin`, and a signed DPoP proof:

```http
POST /api/auth/token HTTP/1.1
Host: nas.example.com
Origin: https://nas.example.com
Content-Type: application/x-www-form-urlencoded
DPoP: <proof JWT>

grant_type=urn%3Alantern-dock%3Aparams%3Aoauth%3Agrant-type%3Asession&client_id=https%3A%2F%2Fnas.example.com%2F&resource=https%3A%2F%2Fnas.example.com%2Fnas&scope=account%3Aread
```

The grant type and client ID are required. `resource` defaults to `SITE_ORIGIN + "/nas"` and cannot select another resource. `scope` defaults to `account:read`. Clients may explicitly request a space-separated subset of `account:read`, `links:read`, `links:write` and `inbox:read`. Empty, repeated or unknown scopes are rejected. The response and token contain only the requested scopes, in Discovery order. A scope restricts the credential; it does not assign a NAS role or bypass the NAS administrator check. Recognized parameters may not occur twice. Bodies are limited to 8 KiB.

A valid session and proof without a current server nonce receive:

```http
HTTP/1.1 400 Bad Request
DPoP-Nonce: <opaque server nonce>
Cache-Control: no-store
Pragma: no-cache
Content-Type: application/json

{"error":"use_dpop_nonce","error_description":"Retry with the supplied DPoP nonce and a new proof."}
```

The client retries once with a **new proof and `jti`**, adding the nonce to the proof payload. Nonces are authenticated, expire after 60 seconds and are bound to the browser key and subject. They cannot be used with another user's session or substituted for a session cookie. Successful responses also provide a fresh `DPoP-Nonce`; the browser retains it only in memory.

```json
{
  "access_token": "<signed JWT>",
  "token_type": "DPoP",
  "expires_in": 60,
  "scope": "account:read"
}
```

Token responses use `Cache-Control: no-store` and `Pragma: no-cache`. Invalid sessions use `invalid_grant`; invalid proofs use `invalid_dpop_proof`. Invalid request parameters use OAuth error names including `invalid_request`, `unsupported_grant_type`, `invalid_client`, `invalid_target` and `invalid_scope`. A `message` extension supplies localized UI text; `error_description` is diagnostic text. The old `accessToken` / `expiresAt` response fields are no longer used.

The Worker is stateless across points of presence: it does not maintain a global, single-use `jti` database for token issuance. Its nonce, timestamp window, HttpOnly session, exact Origin check and session-bound browser key constrain token issuance. Nonces are not single-use. NAS resource requests additionally have strict, persistent proof replay rejection.

## JWT access-token validation

The protected header uses `typ: at+jwt`, `alg: EdDSA` and the signing key's `kid`. Keys are Ed25519, published as public OKP JWKs with `use: sig`; private key material is never included in JWKS. Access tokens contain:

| Claim               | Value / validation                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `iss`               | Exact configured LanternDock site origin.                                                                                             |
| `aud`               | Includes `SITE_ORIGIN + "/nas"`, the NAS resource identifier.                                                                         |
| `sub`               | Current opaque site ID: `ld_` plus canonical unpadded Base64URL of 16 bytes (25 characters total).                                    |
| `client_id`         | Built-in client identifier, `SITE_ORIGIN + "/"`. The NAS requires a nonempty identifier.                                              |
| `iat`, `exp`, `jti` | Required issuance/expiry times and unique token identifier. Lifetime is positive and at most 60 seconds; expired tokens are rejected. |
| `scope`             | `account:read` is required for the account endpoint.                                                                                  |
| `cnf.jkt`           | SHA-256 JWK thumbprint of the browser proof key.                                                                                      |
| `lantern_dock`      | Project claim `{ "protocol_version": 2 }`; version 1 tokens are rejected.                                                             |
| `name`, `email`     | Optional display data; do not determine permissions.                                                                                  |

The NAS accepts only signed access tokens of the expected type and algorithm, not OIDC ID tokens or DPoP proof JWTs. The account role is computed locally from the site-issued `sub` and configured `ADMIN_SUBJECTS`, never from a token's claimed role. The issuer is always the configured LanternDock origin. The NAS neither knows nor validates the external login provider. Administrative endpoints require both their operation-specific scope and the current local administrator role. `account:read` cannot read private inbox contents or manage collection links. The Worker does not claim or decide the NAS role; even a signed token with an `admin` or `role` field cannot elevate a member.

The Worker maps the validated external `(issuer, sub)` by hashing the UTF-8 JSON array `["lantern-dock:subject:v1", issuer, sub]` with SHA-256, taking the first 16 bytes, and encoding those bytes as unpadded Base64URL with an `ld_` prefix. The result is exactly 25 characters. Truncate the digest bytes, not the encoded string. For issuer `https://sso.example` and upstream subject `test-user`, the result is `ld_1KzSHPuTIpRkcYiSJTXRlA`. Worker session reads, NAS access-token validation and `ADMIN_SUBJECTS` all require the canonical current format; former 46-character IDs, raw upstream IDs and padded or noncanonical encodings are rejected, with no compatibility aliases. Neither site origin, signing secrets nor key versions are inputs, so key rotation does not change user IDs and the same upstream identity maps identically across deployments. The 128-bit truncated digest is an identifier, not a secret or a guarantee of anonymity. The mapping belongs entirely to the login adapter; NAS implementations validate the public format but treat its contents as opaque. Neither `identity_issuer` nor raw upstream subjects appear in site sessions, NAS tokens or NAS account responses. Site-session cookies include protocol version 2 and are issued under the LanternDock origin. A session can be used until its own expiry without retrieving external identity again.

## NAS resource requests

```http
GET /api/account HTTP/1.1
Authorization: DPoP <access_token>
DPoP: <new proof JWT>
```

The proof uses `typ: dpop+jwt`, `alg: ES256`, a public P-256 JWK, and claims `jti`, `iat`, `htm`, `htu` and `ath`. `ath` is the base64url SHA-256 hash of the access token. The proof's public-key thumbprint must equal `cnf.jkt`. The NAS validates the method and URI, accepts only a short timestamp window, and records a hash of `(jkt, jti)` in SQLite to reject replay, including across restarts. Storage failures are service errors, not authentication failures.

For direct HTTPS, `htu` is the actual NAS endpoint origin plus request path, without query or fragment. Set NAS `NAS_RESOURCE_ORIGIN` when that origin differs from the portal; it defaults to `SITE_ORIGIN`. Scheme/host/default-port and unreserved percent-encoding normalization are supported by the clients/verifier. A reverse proxy must preserve paths.

For WebTransport, this project defines the logical HTTP request URI as `SITE_ORIGIN + request path`; the bridge forwards its origin-form HTTP request to the private NAS. This is a project-specific mapping of HTTP onto WebTransport, not a claim that unmodified OAuth HTTP clients can use the tunnel. See the [bridge contract](bridge-protocol.md).

The NAS does not require its own DPoP nonce: its short-lived grants and persistent proof replay tracking apply at the resource endpoint. `401` responses use `WWW-Authenticate: DPoP` with `algs="ES256"` and, where applicable, `error="invalid_token"` or `error="invalid_dpop_proof"`. Missing scope returns `403` with `error="insufficient_scope"` and a `scope` challenge naming the required operation scope. A verified non-administrator gets `403` with `error="access_denied"` and `code="ADMIN_REQUIRED"` on administrative endpoints. These headers are exposed by NAS CORS. Public WebDAV and file-drop bearer tokens are separate authorization paths.

## Versioning

`lantern_dock.protocol_version` identifies this identity contract; the browser and NAS reject unsupported/missing versions. Additions that old clients can ignore may remain version 2. Incompatible grants, claim meanings or URI mappings require a new protocol version. Discovery/JWKS paths and ordinary JSON property order are not part of the signature contract. Consumers use `kid`, not key-array order, for verification.

Upgrade both Worker and NAS for version 2, refresh the account page and sign in again. Administrators must replace previously configured upstream subjects with the new site subject shown on the account page. Existing public DAV/file-drop APIs are unaffected. See [key rotation](authentication.md#rotate-nas-signing-keys) for maintaining overlapping verification keys.

## Administrative NAS resources

All endpoints below use the same 60-second access-token validation and persistent DPoP replay protection as `/api/account`. A fresh DPoP proof is required for each HTTP request, including each download range and HEAD. The proof URI uses the configured NAS resource origin and exact request path; query parameters are omitted according to DPoP. With WebTransport this normally uses the site origin, while direct HTTPS uses `NAS_RESOURCE_ORIGIN` when the NAS and frontend origins differ. CORS allows Authorization, DPoP, Content-Type, Range and If-Range from configured exact origins.

| Endpoint                                     | Required scope | Additional check          |
| -------------------------------------------- | -------------- | ------------------------- |
| `GET /api/admin/links`                       | `links:read`   | Current NAS administrator |
| `POST /api/admin/links`                      | `links:write`  | Current NAS administrator |
| `DELETE /api/admin/links/<id>`               | `links:write`  | Current NAS administrator |
| `GET /api/admin/inbox`                       | `inbox:read`   | Current NAS administrator |
| `GET`, `HEAD /api/admin/inbox/<id>/download` | `inbox:read`   | Current NAS administrator |

`GET /api/account` adds `capabilities: { "adminLinks": true, "adminInbox": true }` for administrators and false values for other users. Clients must not infer authorization from public capability metadata or the Worker session alone. Older NAS versions omit these fields and do not support the administrative UI. See [NAS API details](nas-server.md#administrative-http-interface) for payloads and pagination.
