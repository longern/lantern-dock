import { IDENTITY_PROTOCOL_VERSION } from "../../shared/identity-protocol.js";
import { deriveSecret } from "../../shared/site-secret.js";
import { validSiteSubject } from "../site-identity.js";
import { settings } from "./context.js";

const SESSION_IDLE_SECONDS = 60 * 60;
export const SESSION_MAX_SECONDS = 8 * 60 * 60;
export const STATE_COOKIE = "__Host-lantern-oidc";
export const SESSION_COOKIE = "__Host-lantern-session";
const encoder = new TextEncoder();
const cache = new WeakMap();

export const b64 = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64 = (value) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
export const now = () => Math.floor(Date.now() / 1000);
export const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));

export function cookie(request, name) {
  const values = (request.headers.get("Cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="));
  return values.length === 1 ? values[0].slice(name.length + 1) : "";
}
export function setCookie(response, name, value, seconds) {
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
    state.site !== env.SITE_ORIGIN
  ) {
    state = {
      secret: env.SECRET_KEY,
      site: env.SITE_ORIGIN,
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
export async function seal(env, name, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
    await cookieKey(env),
    encoder.encode(JSON.stringify(value)),
  );
  return b64(new Uint8Array([...iv, ...new Uint8Array(data)]));
}
export async function open(env, name, value) {
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

export async function siteSession(request, env, site) {
  const session = await open(
    env,
    SESSION_COOKIE,
    cookie(request, SESSION_COOKIE),
  );
  const startedAt = session?.startedAt;
  return session?.version === IDENTITY_PROTOCOL_VERSION &&
    session.issuer === site &&
    session.user?.issuer === site &&
    validSiteSubject(session.user.sub) &&
    Number.isSafeInteger(startedAt) &&
    startedAt >= 0 &&
    startedAt <= now() &&
    Number.isSafeInteger(session.expires) &&
    session.expires > startedAt &&
    session.expires <= startedAt + SESSION_MAX_SECONDS &&
    startedAt + SESSION_MAX_SECONDS > now()
    ? session
    : null;
}

export async function startSession(response, env, site, user, jkt) {
  const startedAt = now();
  setCookie(response, STATE_COOKIE, "", 0);
  setCookie(
    response,
    SESSION_COOKIE,
    await seal(env, SESSION_COOKIE, {
      version: IDENTITY_PROTOCOL_VERSION,
      issuer: site,
      user,
      jkt,
      startedAt,
      expires: startedAt + SESSION_IDLE_SECONDS,
    }),
    SESSION_IDLE_SECONDS,
  );
}

export async function renewSession(response, env, session, issuedAt) {
  if (session.expires - issuedAt <= SESSION_IDLE_SECONDS / 2) {
    const expires = Math.min(
      issuedAt + SESSION_IDLE_SECONDS,
      session.startedAt + SESSION_MAX_SECONDS,
    );
    if (expires > session.expires && now() < session.expires)
      setCookie(
        response,
        SESSION_COOKIE,
        await seal(env, SESSION_COOKIE, { ...session, expires }),
        expires - now(),
      );
  }
}
