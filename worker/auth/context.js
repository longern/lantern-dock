import { validateSecretKey } from "../../shared/site-secret.js";

const automaticSites = new WeakMap();
export const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    },
  });

export function origin(value) {
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
export function httpsURL(value) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.hash)
    throw new Error("Invalid OIDC endpoint");
  return u.href;
}
export function settings(env, oidc = false) {
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
export function requestEnvironment(request, env) {
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

export async function limitedText(body, limit) {
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
export async function limitedJSON(response) {
  if (!response.ok) throw new Error("OIDC response failed");
  return JSON.parse(await limitedText(response.body, 128 * 1024));
}
export function fetchFor(env) {
  return env.SSO_SERVICE
    ? (url, init) => env.SSO_SERVICE.fetch(new Request(url, init))
    : fetch;
}

export function sameOrigin(request, site) {
  return request.headers.get("Origin") === site;
}
