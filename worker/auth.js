import { createTranslator, detectRequestLanguage } from "../shared/i18n.js";
import {
  SignJWT,
  calculateJwkThumbprint,
  createRemoteJWKSet,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  customFetch,
} from "jose";
import { deriveSecret, validateSecretKey } from "../shared/site-secret.js";
import { signingKeys } from "./signing-keys.js";
import { siteSubject, validSiteSubject } from "./site-identity.js";
import {
  AUTHORIZATION_METADATA_PATH,
  SESSION_GRANT_TYPE,
  ACCOUNT_SCOPE,
  NAS_SCOPES,
  GRANT_SECONDS,
  IDENTITY_PROTOCOL_VERSION,
  canonicalProofURI,
} from "../shared/identity-protocol.js";
export { GRANT_SECONDS } from "../shared/identity-protocol.js";

const SESSION_SECONDS = 1800;
const STATE_COOKIE = "__Host-lantern-oidc";
const SESSION_COOKIE = "__Host-lantern-session";
const encoder = new TextEncoder();
const cache = new WeakMap();
const automaticSites = new WeakMap();
const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    },
  });
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const b64 = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64 = (value) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
const now = () => Math.floor(Date.now() / 1000);
function origin(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("Invalid SITE_ORIGIN");
  return u.origin;
}
function httpsURL(value) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.hash)
    throw new Error("Invalid OIDC endpoint");
  return u.href;
}
function settings(env, oidc = false) {
  const site = origin(env.SITE_ORIGIN);
  validateSecretKey(env.SECRET_KEY);
  if (!oidc) return { site };
  const issuer = httpsURL(env.OIDC_ISSUER_URL);
  if (new URL(issuer).search) throw new Error("Invalid issuer");
  return {
    site,
    issuer: env.OIDC_ISSUER_URL,
    clientId: env.OIDC_CLIENT_ID || site + "/api/auth/oidc/client.json",
    redirectUri: site + "/auth/callback",
  };
}
function requestEnvironment(request, env) {
  // Workers supplies the public request URL. Do not trust forwarded/Host headers.
  const site = origin(env.SITE_ORIGIN || new URL(request.url).origin);
  if (env.SITE_ORIGIN) return env;
  let sites = automaticSites.get(env);
  if (!sites) {
    sites = new Map();
    automaticSites.set(env, sites);
  }
  if (!sites.has(site)) {
    // Keep bindings live without mutating the shared environment across origins.
    sites.set(site, Object.create(env, { SITE_ORIGIN: { value: site } }));
    if (sites.size > 8) sites.delete(sites.keys().next().value);
  }
  return sites.get(site);
}
function cookie(request, name) {
  const values = (request.headers.get("Cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="));
  return values.length === 1 ? values[0].slice(name.length + 1) : "";
}
function setCookie(response, name, value, seconds) {
  response.headers.append(
    "Set-Cookie",
    `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`,
  );
}
function stateFor(env) {
  let state = cache.get(env);
  if (
    !state ||
    state.secret !== env.SECRET_KEY ||
    state.site !== env.SITE_ORIGIN ||
    state.issuer !== env.OIDC_ISSUER_URL ||
    state.clientId !== env.OIDC_CLIENT_ID
  ) {
    state = {
      secret: env.SECRET_KEY,
      site: env.SITE_ORIGIN,
      issuer: env.OIDC_ISSUER_URL,
      clientId: env.OIDC_CLIENT_ID,
    };
    cache.set(env, state);
  }
  return state;
}
async function cookieKey(env) {
  const state = stateFor(env);
  if (!state.cookieKey)
    state.cookieKey = (async () => {
      const hex = await deriveSecret(
        env.SECRET_KEY,
        "lantern-dock:identity-cookies:v1:" + settings(env).site,
      );
      return crypto.subtle.importKey(
        "raw",
        Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
    })();
  return state.cookieKey;
}
async function seal(env, name, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
    await cookieKey(env),
    encoder.encode(JSON.stringify(value)),
  );
  return b64(new Uint8Array([...iv, ...new Uint8Array(data)]));
}
async function open(env, name, value) {
  try {
    if (!value || value.length > 6000) return null;
    const bytes = unb64(value);
    const data = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, 12),
        additionalData: encoder.encode(name),
      },
      await cookieKey(env),
      bytes.slice(12),
    );
    const result = JSON.parse(new TextDecoder().decode(data));
    return result.expires > now() ? result : null;
  } catch {
    return null;
  }
}
async function siteSession(request, env, site) {
  const session = await open(
    env,
    SESSION_COOKIE,
    cookie(request, SESSION_COOKIE),
  );
  return session?.version === IDENTITY_PROTOCOL_VERSION &&
    session.issuer === site &&
    session.user?.issuer === site &&
    validSiteSubject(session.user.sub)
    ? session
    : null;
}
async function limitedText(body, limit) {
  if (!body) return "";
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error("Response too large");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(bytes);
}
async function limitedJSON(response) {
  if (!response.ok) throw new Error("OIDC response failed");
  return JSON.parse(await limitedText(response.body, 128 * 1024));
}
function fetchFor(env) {
  return env.SSO_SERVICE
    ? (url, init) => env.SSO_SERVICE.fetch(new Request(url, init))
    : fetch;
}
class OIDCProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
async function provider(env, t) {
  const state = stateFor(env);
  if (state.provider && state.provider.expires > Date.now())
    return state.provider;
  const cfg = settings(env, true),
    fetcher = fetchFor(env);
  let response;
  try {
    response = await fetcher(
      cfg.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration",
      {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: { Accept: "application/json" },
      },
    );
  } catch {
    throw new OIDCProviderError(
      "OIDC_DISCOVERY_UNREACHABLE",
      t("server.oidcDiscoveryUnreachable"),
    );
  }
  if (!response.ok)
    throw new OIDCProviderError(
      "OIDC_DISCOVERY_HTTP_ERROR",
      t("server.oidcDiscoveryHttpError", { status: response.status }),
    );
  let document;
  try {
    document = await limitedJSON(response);
  } catch {
    throw new OIDCProviderError(
      "OIDC_DISCOVERY_INVALID",
      t("server.oidcDiscoveryInvalidJson"),
    );
  }
  if (document?.issuer !== cfg.issuer)
    throw new OIDCProviderError(
      "OIDC_ISSUER_MISMATCH",
      t("server.oidcIssuerMismatch"),
    );
  if (
    !env.OIDC_CLIENT_ID &&
    document.client_id_metadata_document_supported !== true
  )
    throw new OIDCProviderError(
      "OIDC_CIMD_UNSUPPORTED",
      t("server.oidcCimdUnsupported"),
    );
  if (!document.code_challenge_methods_supported?.includes("S256"))
    throw new OIDCProviderError(
      "OIDC_PKCE_UNSUPPORTED",
      t("server.oidcPkceUnsupported"),
    );
  try {
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"])
      httpsURL(document[key]);
  } catch {
    throw new OIDCProviderError(
      "OIDC_DISCOVERY_INVALID",
      t("server.oidcDiscoveryInvalidEndpoint"),
    );
  }
  const jwks = createRemoteJWKSet(new URL(document.jwks_uri), {
    [customFetch]: async (url, init) => {
      const r = await fetcher(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      const value = await limitedJSON(r);
      return Response.json(value);
    },
  });
  state.provider = { ...document, jwks, expires: Date.now() + 300000 };
  return state.provider;
}
async function proof(request, site, expectedThumbprint) {
  const raw = request.headers.get("DPoP");
  if (!raw || raw.length > 8192) throw new Error("Proof required");
  const header = decodeProtectedHeader(raw);
  const jwk = header.jwk;
  if (
    header.alg !== "ES256" ||
    header.typ !== "dpop+jwt" ||
    !jwk ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    "d" in jwk
  )
    throw new Error("Invalid proof key");
  const { payload } = await jwtVerify(raw, await importJWK(jwk, "ES256"), {
    algorithms: ["ES256"],
    typ: "dpop+jwt",
    maxTokenAge: "60s",
    clockTolerance: 5,
  });
  const target = site + new URL(request.url).pathname;
  if (
    payload.htm !== request.method ||
    canonicalProofURI(payload.htu) !== canonicalProofURI(target) ||
    typeof payload.jti !== "string" ||
    payload.jti.length < 16 ||
    payload.jti.length > 128
  )
    throw new Error("Proof mismatch");
  const thumbprint = await calculateJwkThumbprint(jwk);
  if (expectedThumbprint && expectedThumbprint !== thumbprint)
    throw new Error("Browser key changed");
  return { thumbprint, payload };
}
function sameOrigin(request, site) {
  return request.headers.get("Origin") === site;
}
function oauthError(error, description, message, status = 400, code = error) {
  const response = json(
    { error, error_description: description, message, code },
    status,
  );
  response.headers.set("Pragma", "no-cache");
  return response;
}
function authorizationMetadata(site) {
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
async function issueGrant(request, env, cfg, t) {
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
  const scope = NAS_SCOPES.filter((value) => requestedScopes.includes(value)).join(" ");
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
  return response;
}
function redirect(site, path) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: site + path,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
function accountError(env, message) {
  const response = redirect(
    settings(env).site,
    "/#/account?error=" + encodeURIComponent(message),
  );
  setCookie(response, STATE_COOKIE, "", 0);
  return response;
}
export function clientMetadata(env) {
  const site = origin(env.SITE_ORIGIN);
  return {
    client_id: site + "/api/auth/oidc/client.json",
    client_name: "LanternDock",
    client_uri: site + "/",
    redirect_uris: [site + "/auth/callback"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    token_endpoint_auth_methods_supported: ["none"],
    scope: "openid profile email",
  };
}

export async function authentication(
  request,
  env,
  t = createTranslator(
    detectRequestLanguage(request.headers.get("Accept-Language")),
  ),
) {
  const response = await handleAuthentication(request, env, t);
  // Public discovery and JWKS responses are language-neutral and cacheable.
  if (
    response &&
    !response.headers.get("Cache-Control")?.startsWith("public")
  ) {
    response.headers.set("Content-Language", t.locale);
    const vary = response.headers.get("Vary");
    response.headers.set(
      "Vary",
      vary ? `${vary}, Accept-Language` : "Accept-Language",
    );
  }
  return response;
}

async function handleAuthentication(request, env, t) {
  const path = new URL(request.url).pathname;
  if (
    path !== AUTHORIZATION_METADATA_PATH &&
    path !== "/auth/callback" &&
    !path.startsWith("/api/auth/")
  )
    return null;
  try {
    env = requestEnvironment(request, env);
  } catch {
    return json(
      {
        error: t("server.invalidSiteOrigin"),
        code: "INVALID_SITE_ORIGIN",
      },
      400,
    );
  }
  if (path === "/api/auth/oidc/client.json") {
    if (request.method !== "GET")
      return json({ error: t("server.methodNotAllowed") }, 405);
    try {
      const metadata = clientMetadata(env);
      if (new URL(request.url).origin !== origin(env.SITE_ORIGIN))
        return json({ error: t("server.useConfiguredOrigin") }, 400);
      return json(metadata);
    } catch {
      return json(
        { error: t("server.configureSiteOrigin"), code: "AUTH_NOT_CONFIGURED" },
        503,
      );
    }
  }
  let cfg;
  try {
    cfg = settings(env);
    if (new URL(request.url).origin !== cfg.site)
      return json({ error: t("server.signInAtConfiguredOrigin") }, 400);
  } catch {
    return json(
      {
        enabled: false,
        error: t("server.configureSecretKey"),
        code: "AUTH_NOT_CONFIGURED",
      },
      503,
    );
  }
  if (path === "/api/auth/login" || path === "/auth/callback") {
    try {
      cfg = settings(env, true);
    } catch {
      return json(
        {
          enabled: false,
          error: t("server.configureOidcIssuer"),
          code: "OIDC_NOT_CONFIGURED",
        },
        503,
      );
    }
  }
  try {
    if (path === AUTHORIZATION_METADATA_PATH && request.method === "GET") {
      const response = json(authorizationMetadata(cfg.site));
      response.headers.set("Cache-Control", "public, max-age=300");
      response.headers.delete("Vary");
      return response;
    }
    if (path === "/api/auth/jwks.json" && request.method === "GET") {
      const { jwks } = await signingKeys(env, cfg.site);
      const response = json(jwks);
      response.headers.set("Cache-Control", "public, max-age=300");
      response.headers.delete("Vary");
      return response;
    }
    if (path === "/api/auth/session" && request.method === "GET") {
      const session = await siteSession(request, env, cfg.site);
      if (!session) return json({ authenticated: false });
      return json({
        authenticated: true,
        user: session.user,
        expiresAt: new Date(session.expires * 1000).toISOString(),
      });
    }
    if (path === "/api/auth/login" && request.method === "POST") {
      if (!sameOrigin(request, cfg.site))
        return json({ error: t("server.originMismatch") }, 403);
      let jkt;
      try {
        jkt = (await proof(request, cfg.site)).thumbprint;
      } catch {
        return json(
          { error: t("server.invalidProofRetry"), code: "INVALID_PROOF" },
          401,
        );
      }
      const p = await provider(env, t),
        state = random(),
        nonce = random(),
        verifier = random();
      const challenge = b64(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
        ),
      );
      const target = new URL(p.authorization_endpoint);
      for (const [k, v] of Object.entries({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        response_type: "code",
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }))
        target.searchParams.set(k, v);
      const response = json({ url: target.href });
      setCookie(
        response,
        STATE_COOKIE,
        await seal(env, STATE_COOKIE, {
          state,
          nonce,
          verifier,
          jkt,
          issuer: cfg.issuer,
          expires: now() + 600,
        }),
        600,
      );
      return response;
    }
    if (path === "/auth/callback" && request.method === "GET") {
      const query = new URL(request.url).searchParams,
        state = await open(env, STATE_COOKIE, cookie(request, STATE_COOKIE));
      if (
        !state ||
        state.issuer !== cfg.issuer ||
        query.getAll("state").length !== 1 ||
        query.get("state") !== state.state
      )
        return accountError(env, t("server.loginExpired"));
      if (query.has("iss") && query.get("iss") !== cfg.issuer)
        return accountError(env, t("server.loginProviderMismatch"));
      if (query.has("error"))
        return accountError(env, t("server.loginCancelled"));
      if (
        query.getAll("code").length !== 1 ||
        !query.get("code") ||
        query.get("code").length > 4096
      )
        return accountError(env, t("server.loginResponseInvalid"));
      const p = await provider(env, t);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        code: query.get("code"),
        code_verifier: state.verifier,
      });
      if (env.OIDC_CLIENT_SECRET)
        body.set("client_secret", env.OIDC_CLIENT_SECRET);
      const tokens = await limitedJSON(
        await fetchFor(env)(p.token_endpoint, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body,
        }),
      );
      const { payload } = await jwtVerify(tokens.id_token, p.jwks, {
        issuer: cfg.issuer,
        audience: cfg.clientId,
        algorithms: ["EdDSA", "RS256", "PS256", "ES256"],
        requiredClaims: ["exp", "iat", "sub", "nonce"],
        maxTokenAge: "10m",
        clockTolerance: 5,
      });
      if (
        payload.nonce !== state.nonce ||
        !Number.isFinite(payload.iat) ||
        payload.iat > now() + 5 ||
        typeof payload.sub !== "string" ||
        !payload.sub.length ||
        payload.sub.length > 255 ||
        /[^\x20-\x7e]/.test(payload.sub) ||
        (Array.isArray(payload.aud) &&
          payload.aud.length > 1 &&
          payload.azp !== cfg.clientId) ||
        (payload.azp && payload.azp !== cfg.clientId)
      )
        throw new Error("Invalid identity claims");
      let profile = payload;
      if (p.userinfo_endpoint) {
        if (typeof tokens.access_token !== "string" || !tokens.access_token)
          throw new Error("Missing UserInfo access token");
        profile = await limitedJSON(
          await fetchFor(env)(httpsURL(p.userinfo_endpoint), {
            redirect: "manual",
            signal: AbortSignal.timeout(10000),
            headers: {
              Authorization: "Bearer " + tokens.access_token,
              Accept: "application/json",
            },
          }),
        );
        if (profile.sub !== payload.sub)
          throw new Error("UserInfo subject mismatch");
      }
      const user = {
        issuer: cfg.site,
        sub: await siteSubject(cfg.issuer, payload.sub),
        name:
          typeof profile.name === "string" ? profile.name.slice(0, 200) : "",
        email:
          typeof profile.email === "string" ? profile.email.slice(0, 320) : "",
      };
      const response = redirect(cfg.site, "/#/account");
      setCookie(response, STATE_COOKIE, "", 0);
      setCookie(
        response,
        SESSION_COOKIE,
        await seal(env, SESSION_COOKIE, {
          version: IDENTITY_PROTOCOL_VERSION,
          issuer: cfg.site,
          user,
          jkt: state.jkt,
          expires: now() + SESSION_SECONDS,
        }),
        SESSION_SECONDS,
      );
      return response;
    }
    if (path === "/api/auth/token") {
      if (request.method !== "POST") {
        const response = oauthError(
          "invalid_request",
          "Use POST for token requests.",
          t("server.tokenRequiresPost"),
          405,
        );
        response.headers.set("Allow", "POST");
        return response;
      }
      return await issueGrant(request, env, cfg, t);
    }
    if (path === "/api/auth/logout" && request.method === "POST") {
      if (!sameOrigin(request, cfg.site))
        return json({ error: t("server.originMismatch") }, 403);
      const response = json({ ok: true });
      setCookie(response, SESSION_COOKIE, "", 0);
      setCookie(response, STATE_COOKIE, "", 0);
      return response;
    }
    return json({ error: t("server.notFound") }, 404);
  } catch (error) {
    if (path === "/auth/callback")
      return accountError(env, t("server.loginVerificationFailed"));
    if (path === "/api/auth/login" && error instanceof OIDCProviderError)
      return json({ error: error.message, code: error.code }, 503);
    if (path === "/api/auth/token")
      return oauthError(
        "temporarily_unavailable",
        "The authorization service is temporarily unavailable.",
        t("server.authUnavailable"),
        503,
        "AUTH_UNAVAILABLE",
      );
    return json(
      { error: t("server.authUnavailable"), code: "AUTH_UNAVAILABLE" },
      503,
    );
  }
}

export function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: https: http://localhost:* http://127.0.0.1:*; connect-src 'self' https: http://localhost:* http://127.0.0.1:* wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
