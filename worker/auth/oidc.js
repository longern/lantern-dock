import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { safeReturnPath } from "../../shared/routes.js";
import { siteSubject } from "../site-identity.js";
import {
  fetchFor,
  httpsURL,
  json,
  limitedJSON,
  limitedText,
  origin,
  sameOrigin,
} from "./context.js";
import {
  b64,
  cookie,
  now,
  open,
  random,
  seal,
  setCookie,
  startSession,
  STATE_COOKIE,
} from "./session.js";
import { proof } from "./proof.js";

const encoder = new TextEncoder();

export class OIDCProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const providers = new WeakMap();

async function provider(env, cfg, t) {
  const previous = providers.get(env);
  if (
    previous?.issuer === cfg.issuer &&
    previous.site === cfg.site &&
    previous.secret === env.SECRET_KEY &&
    previous.clientId === env.OIDC_CLIENT_ID &&
    previous.expires > Date.now()
  )
    return previous.document;
  const fetcher = fetchFor(env);
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
  const metadata = { ...document, jwks };
  providers.set(env, {
    issuer: cfg.issuer,
    site: cfg.site,
    secret: env.SECRET_KEY,
    clientId: env.OIDC_CLIENT_ID,
    document: metadata,
    expires: Date.now() + 300000,
  });
  return metadata;
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
export function accountError(site, message, destination) {
  const back = safeReturnPath(destination);
  const response = redirect(
    site,
    "/account?error=" +
      encodeURIComponent(message) +
      (back === "/account" ? "" : "&return=" + encodeURIComponent(back)),
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

export async function beginOIDCLogin(request, env, cfg, t) {
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
  let returnTo = "/account";
  if (request.body) {
    try {
      returnTo = safeReturnPath(
        JSON.parse(await limitedText(request.body, 16384)).returnTo,
      );
    } catch {
      return json({ error: t("server.invalidLoginRequest") }, 400);
    }
  }
  // Leave room for the other encrypted OAuth state fields within a cookie.
  if (returnTo.length > 1536) returnTo = "/account";
  const p = await provider(env, cfg, t),
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
      returnTo,
      expires: now() + 600,
    }),
    600,
  );
  return response;
}

export async function finishOIDCLogin(request, env, cfg, t) {
  let returnOnError;
  try {
    const query = new URL(request.url).searchParams,
      state = await open(env, STATE_COOKIE, cookie(request, STATE_COOKIE));
    if (
      !state ||
      state.issuer !== cfg.issuer ||
      query.getAll("state").length !== 1 ||
      query.get("state") !== state.state
    )
      return accountError(cfg.site, t("server.loginExpired"));
    returnOnError = safeReturnPath(state.returnTo);

    if (query.has("iss") && query.get("iss") !== cfg.issuer)
      return accountError(
        cfg.site,
        t("server.loginProviderMismatch"),
        returnOnError,
      );
    if (query.has("error"))
      return accountError(cfg.site, t("server.loginCancelled"), returnOnError);
    if (
      query.getAll("code").length !== 1 ||
      !query.get("code") ||
      query.get("code").length > 4096
    )
      return accountError(
        cfg.site,
        t("server.loginResponseInvalid"),
        returnOnError,
      );
    const p = await provider(env, cfg, t);
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
      name: typeof profile.name === "string" ? profile.name.slice(0, 200) : "",
      email:
        typeof profile.email === "string" ? profile.email.slice(0, 320) : "",
    };
    const response = redirect(cfg.site, safeReturnPath(state.returnTo));

    await startSession(response, env, cfg.site, user, state.jkt);
    return response;
  } catch {
    return accountError(
      cfg.site,
      t("server.loginVerificationFailed"),
      returnOnError,
    );
  }
}
