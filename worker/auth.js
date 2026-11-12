import { createTranslator, detectRequestLanguage } from "../shared/i18n.js";
import { AUTHORIZATION_METADATA_PATH } from "../shared/identity-protocol.js";
import { signingKeys } from "./signing-keys.js";
import {
  json,
  origin,
  requestEnvironment,
  sameOrigin,
  settings,
} from "./auth/context.js";
import { authorizationMetadata, issueGrant, oauthError } from "./auth/grant.js";
import {
  accountError,
  beginOIDCLogin,
  clientMetadata,
  finishOIDCLogin,
  OIDCProviderError,
} from "./auth/oidc.js";
import {
  SESSION_COOKIE,
  setCookie,
  siteSession,
  STATE_COOKIE,
} from "./auth/session.js";

export { clientMetadata };

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
      return await beginOIDCLogin(request, env, cfg, t);
    }
    if (path === "/auth/callback" && request.method === "GET") {
      return await finishOIDCLogin(request, env, cfg, t);
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
      return accountError(cfg.site, t("server.loginVerificationFailed"));
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
