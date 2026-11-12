import { SignJWT } from "jose";
import {
  SESSION_GRANT_TYPE,
  ACCOUNT_SCOPE,
  NAS_SCOPES,
  GRANT_SECONDS,
  IDENTITY_PROTOCOL_VERSION,
} from "../../shared/identity-protocol.js";
import { signingKeys } from "../signing-keys.js";
import { json, limitedText, sameOrigin } from "./context.js";
import {
  now,
  open,
  random,
  renewSession,
  seal,
  SESSION_MAX_SECONDS,
  siteSession,
} from "./session.js";
import { proof } from "./proof.js";

export function oauthError(
  error,
  description,
  message,
  status = 400,
  code = error,
) {
  const response = json(
    { error, error_description: description, message, code },
    status,
  );
  response.headers.set("Pragma", "no-cache");
  return response;
}
export function authorizationMetadata(site) {
  return {
    issuer: site,
    jwks_uri: site + "/api/auth/jwks.json",
    token_endpoint: site + "/api/auth/token",
    grant_types_supported: [SESSION_GRANT_TYPE],
    response_types_supported: [],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: NAS_SCOPES,
    dpop_signing_alg_values_supported: ["ES256"],
    // This is a session-backed extension grant, not a second OIDC provider.
    lantern_dock: {
      protocol_version: IDENTITY_PROTOCOL_VERSION,
      resource: site + "/nas",
    },
  };
}
export async function issueGrant(request, env, cfg, t) {
  if (!sameOrigin(request, cfg.site))
    return oauthError(
      "invalid_request",
      "The request origin is not allowed.",
      t("server.originMismatch"),
      403,
    );
  if (
    request.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/x-www-form-urlencoded"
  )
    return oauthError(
      "invalid_request",
      "Use application/x-www-form-urlencoded.",
      t("server.invalidTokenFormat"),
    );
  let params;
  try {
    params = new URLSearchParams(await limitedText(request.body, 8192));
  } catch {
    return oauthError(
      "invalid_request",
      "The request body is invalid or too large.",
      t("server.invalidTokenRequest"),
    );
  }
  for (const key of ["grant_type", "client_id", "resource", "scope"])
    if (params.getAll(key).length > 1)
      return oauthError(
        "invalid_request",
        "Duplicate request parameter.",
        t("server.duplicateTokenParameter"),
      );
  if (params.get("grant_type") !== SESSION_GRANT_TYPE)
    return oauthError(
      "unsupported_grant_type",
      "Only the LanternDock session grant is supported.",
      t("server.refreshAndSignIn"),
    );
  if (params.get("client_id") !== cfg.site + "/")
    return oauthError(
      "invalid_client",
      "The client_id is not allowed.",
      t("server.clientMismatch"),
    );
  if (params.has("resource") && params.get("resource") !== cfg.site + "/nas")
    return oauthError(
      "invalid_target",
      "The requested resource is not allowed.",
      t("server.resourceMismatch"),
    );
  const requestedScopes = (params.get("scope") ?? ACCOUNT_SCOPE).split(" ");
  if (
    requestedScopes.some((scope) => !NAS_SCOPES.includes(scope)) ||
    new Set(requestedScopes).size !== requestedScopes.length
  )
    return oauthError(
      "invalid_scope",
      "The requested scope is not allowed.",
      t("server.invalidScope"),
    );
  // Request scopes only restrict a browser-bound credential. They never assert
  // an administrator role: NAS checks ADMIN_SUBJECTS on every protected request.
  const scope = NAS_SCOPES.filter((value) =>
    requestedScopes.includes(value),
  ).join(" ");
  const session = await siteSession(request, env, cfg.site);
  if (!session)
    return oauthError(
      "invalid_grant",
      "The site session has expired or is missing.",
      t("server.loginRequired"),
      400,
      "LOGIN_REQUIRED",
    );
  let verified;
  try {
    verified = await proof(request, cfg.site, session.jkt);
  } catch {
    return oauthError(
      "invalid_dpop_proof",
      "The DPoP proof is invalid or uses a different key.",
      t("server.invalidProofSignIn"),
      400,
      "INVALID_PROOF",
    );
  }
  const { thumbprint: jkt, payload } = verified;
  const nonce =
    typeof payload.nonce === "string"
      ? await open(env, "dpop-nonce", payload.nonce)
      : null;
  const nextNonce = () =>
    seal(env, "dpop-nonce", {
      jkt,
      sub: session.user.sub,
      expires: now() + 60,
    });
  if (!nonce || nonce.jkt !== jkt || nonce.sub !== session.user.sub) {
    const response = oauthError(
      "use_dpop_nonce",
      "Retry with the supplied DPoP nonce and a new proof.",
      t("server.verifyingRequest"),
    );
    response.headers.set("DPoP-Nonce", await nextNonce());
    return response;
  }
  const {
    active: { key, jwk },
  } = await signingKeys(env, cfg.site);
  const issuedAt = now();
  if (
    session.expires <= issuedAt ||
    session.startedAt + SESSION_MAX_SECONDS <= issuedAt
  )
    return oauthError(
      "invalid_grant",
      "The site session has expired or is missing.",
      t("server.loginRequired"),
      400,
      "LOGIN_REQUIRED",
    );
  const accessToken = await new SignJWT({
    lantern_dock: { protocol_version: IDENTITY_PROTOCOL_VERSION },
    client_id: cfg.site + "/",
    scope,
    name: session.user.name,
    email: session.user.email,
    cnf: { jkt },
  })
    .setProtectedHeader({ alg: "EdDSA", kid: jwk.kid, typ: "at+jwt" })
    .setIssuer(cfg.site)
    .setSubject(session.user.sub)
    .setAudience(cfg.site + "/nas")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + GRANT_SECONDS)
    .setJti(random())
    .sign(key);
  const response = json({
    access_token: accessToken,
    token_type: "DPoP",
    expires_in: GRANT_SECONDS,
    scope,
  });
  response.headers.set("Pragma", "no-cache");
  response.headers.set("DPoP-Nonce", await nextNonce());
  // Account probes run in the shared session provider and are not activity.
  // Fully verified management requests renew only after half the window.
  // The idle window is therefore conservatively between 30 and 60 minutes.
  if (requestedScopes.some((value) => value !== ACCOUNT_SCOPE))
    await renewSession(response, env, session, issuedAt);
  return response;
}
