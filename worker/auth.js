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

const SESSION_SECONDS = 1800;
export const GRANT_SECONDS = 60;
const STATE_COOKIE = "__Host-lantern-oidc";
const SESSION_COOKIE = "__Host-lantern-session";
const encoder = new TextEncoder();
const cache = new WeakMap();
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
function settings(env) {
  const site = origin(env.SITE_ORIGIN);
  const issuer = httpsURL(env.OIDC_ISSUER_URL);
  if (new URL(issuer).search) throw new Error("Invalid issuer");
  validateSecretKey(env.SECRET_KEY);
  return {
    site,
    issuer: env.OIDC_ISSUER_URL,
    clientId: env.OIDC_CLIENT_ID || site + "/api/auth/oidc/client.json",
    redirectUri: site + "/auth/callback",
  };
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
async function material(env) {
  const state = stateFor(env);
  const cfg = settings(env);
  if (!state.keys)
    state.keys = (async () => {
      const seed = Uint8Array.from(
        (
          await deriveSecret(
            env.SECRET_KEY,
            "lantern-dock:identity-signing:v1:" + cfg.site,
          )
        ).match(/../g),
        (x) => parseInt(x, 16),
      );
      const prefix = Uint8Array.from([
        48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32,
      ]);
      const key = await crypto.subtle.importKey(
        "pkcs8",
        new Uint8Array([...prefix, ...seed]),
        "Ed25519",
        true,
        ["sign"],
      );
      const exported = await crypto.subtle.exportKey("jwk", key);
      const jwk = {
        kty: "OKP",
        crv: "Ed25519",
        x: exported.x,
        alg: "EdDSA",
        use: "sig",
      };
      jwk.kid = await calculateJwkThumbprint(jwk);
      return { key, jwk };
    })();
  return state.keys;
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
async function limitedJSON(response) {
  if (!response.ok) throw new Error("OIDC response failed");
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 128 * 1024) throw new Error("OIDC response too large");
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
  return JSON.parse(new TextDecoder().decode(bytes));
}
function fetchFor(env) {
  return env.SSO_SERVICE
    ? (url, init) => env.SSO_SERVICE.fetch(new Request(url, init))
    : fetch;
}
async function provider(env) {
  const state = stateFor(env);
  if (state.provider && state.provider.expires > Date.now())
    return state.provider;
  const cfg = settings(env),
    fetcher = fetchFor(env);
  const document = await limitedJSON(
    await fetcher(
      cfg.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration",
      {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { Accept: "application/json" },
      },
    ),
  );
  if (document.issuer !== cfg.issuer) throw new Error("Issuer mismatch");
  if (
    !env.OIDC_CLIENT_ID &&
    document.client_id_metadata_document_supported !== true
  )
    throw new Error("CIMD is not supported");
  if (!document.code_challenge_methods_supported?.includes("S256"))
    throw new Error("PKCE S256 is required");
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"])
    httpsURL(document[key]);
  const jwks = createRemoteJWKSet(new URL(document.jwks_uri), {
    [customFetch]: async (url, init) => {
      const r = await fetcher(url, {
        ...init,
        redirect: "error",
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
    payload.htu !== target ||
    typeof payload.jti !== "string" ||
    payload.jti.length < 16 ||
    payload.jti.length > 128
  )
    throw new Error("Proof mismatch");
  const thumbprint = await calculateJwkThumbprint(jwk);
  if (expectedThumbprint && expectedThumbprint !== thumbprint)
    throw new Error("Browser key changed");
  return thumbprint;
}
function sameOrigin(request, site) {
  return request.headers.get("Origin") === site;
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

export async function authentication(request, env) {
  const path = new URL(request.url).pathname;
  if (path !== "/auth/callback" && !path.startsWith("/api/auth/")) return null;
  if (path === "/api/auth/oidc/client.json") {
    if (request.method !== "GET")
      return json({ error: "Method not allowed" }, 405);
    try {
      const metadata = clientMetadata(env);
      if (new URL(request.url).origin !== origin(env.SITE_ORIGIN))
        return json({ error: "Use the configured site origin" }, 400);
      return json(metadata);
    } catch {
      return json(
        { error: "请配置 SITE_ORIGIN。", code: "AUTH_NOT_CONFIGURED" },
        503,
      );
    }
  }
  let cfg;
  try {
    cfg = settings(env);
    if (new URL(request.url).origin !== cfg.site)
      return json({ error: "请从配置的站点地址登录。" }, 400);
  } catch {
    return json(
      {
        enabled: false,
        error: "请在 Worker 配置 SITE_ORIGIN 和 OIDC_ISSUER_URL。",
        code: "AUTH_NOT_CONFIGURED",
      },
      503,
    );
  }
  try {
    if (path === "/api/auth/jwks.json" && request.method === "GET") {
      const { jwk } = await material(env);
      const response = json({ keys: [jwk] });
      response.headers.set("Cache-Control", "public, max-age=300");
      response.headers.delete("Vary");
      return response;
    }
    if (path === "/api/auth/session" && request.method === "GET") {
      const session = await open(
        env,
        SESSION_COOKIE,
        cookie(request, SESSION_COOKIE),
      );
      if (!session || session.issuer !== cfg.issuer)
        return json({ authenticated: false });
      return json({
        authenticated: true,
        user: session.user,
        expiresAt: new Date(session.expires * 1000).toISOString(),
      });
    }
    if (path === "/api/auth/login" && request.method === "POST") {
      if (!sameOrigin(request, cfg.site))
        return json({ error: "请求来源不匹配。" }, 403);
      let jkt;
      try {
        jkt = await proof(request, cfg.site);
      } catch {
        return json(
          { error: "无法验证浏览器密钥，请重试。", code: "INVALID_PROOF" },
          401,
        );
      }
      const p = await provider(env),
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
        return accountError(env, "登录请求已过期或已更新，请重新登录。");
      if (query.has("iss") && query.get("iss") !== cfg.issuer)
        return accountError(env, "登录服务不匹配，请重试。");
      if (query.has("error"))
        return accountError(env, "登录未完成或授权已取消。");
      if (
        query.getAll("code").length !== 1 ||
        !query.get("code") ||
        query.get("code").length > 4096
      )
        return accountError(env, "登录响应无效，请重试。");
      const p = await provider(env);
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
          redirect: "error",
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
            redirect: "error",
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
        issuer: cfg.issuer,
        sub: payload.sub,
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
          issuer: cfg.issuer,
          user,
          jkt: state.jkt,
          expires: now() + SESSION_SECONDS,
        }),
        SESSION_SECONDS,
      );
      return response;
    }
    if (path === "/api/auth/token" && request.method === "POST") {
      if (!sameOrigin(request, cfg.site))
        return json({ error: "请求来源不匹配。" }, 403);
      const session = await open(
        env,
        SESSION_COOKIE,
        cookie(request, SESSION_COOKIE),
      );
      if (!session || session.issuer !== cfg.issuer)
        return json({ error: "请重新登录。", code: "LOGIN_REQUIRED" }, 401);
      let jkt;
      try {
        jkt = await proof(request, cfg.site, session.jkt);
      } catch {
        return json(
          { error: "浏览器密钥已改变，请重新登录。", code: "KEY_MISMATCH" },
          401,
        );
      }
      const { key, jwk } = await material(env);
      const issuedAt = now();
      const accessToken = await new SignJWT({
        identity_issuer: cfg.issuer,
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
      return json({
        accessToken,
        expiresAt: new Date((issuedAt + GRANT_SECONDS) * 1000).toISOString(),
      });
    }
    if (path === "/api/auth/logout" && request.method === "POST") {
      if (!sameOrigin(request, cfg.site))
        return json({ error: "请求来源不匹配。" }, 403);
      const response = json({ ok: true });
      setCookie(response, SESSION_COOKIE, "", 0);
      setCookie(response, STATE_COOKIE, "", 0);
      return response;
    }
    return json({ error: "Not found" }, 404);
  } catch {
    if (path === "/auth/callback")
      return accountError(env, "登录验证失败，请重新登录。");
    return json(
      { error: "登录服务暂不可用，请稍后重试。", code: "AUTH_UNAVAILABLE" },
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
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; connect-src 'self' https: http://localhost:* http://127.0.0.1:* wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
