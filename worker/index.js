import { createTranslator, detectRequestLanguage } from "../shared/i18n.js";
import {
  backendDefaults as defaults,
  backendAddress,
  defaultBackendRoot,
} from "../shared/backend-defaults.js";
import { certificateWebhookTokens, validateSecretKey } from "./secrets.js";
import { authentication, secureResponse } from "./auth.js";

const json = (data, status = 200, headers = {}) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });

class SetupRequired extends Error {
  constructor(message, reason = "invalid-configuration") {
    super(message);
    this.reason = reason;
  }
}

function setupConfiguration(env, reason, t) {
  const address = backendAddress(env);
  let hasSecretKey = false;
  try {
    validateSecretKey(env.SECRET_KEY);
    hasSecretKey = true;
  } catch {}
  let endpoint = "";
  try {
    const url = new URL(address.endpoint);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      endpoint = url.href;
  } catch {}
  return {
    version: 1,
    setupRequired: true,
    setup: {
      reason,
      hasSecretKey,
      hasKV:
        typeof env.KV?.get === "function" && typeof env.KV?.put === "function",
      resetVariables: [
        ...["WEBDAV_URL", "WEBTRANSPORT_URL"].filter((key) => env[key]?.trim()),
        ...(env.BACKEND_ROOT ? ["BACKEND_ROOT"] : []),
        ...(env.BACKEND_NAME ? ["BACKEND_NAME"] : []),
        ...Object.entries({
          BACKEND_AUTH: defaults.auth,
          GATEWAY_AUTH: String(defaults.gatewayAuth),
          CERTIFICATE_MODE: defaults.certificateMode,
        })
          .filter(([key, value]) => env[key] && env[key] !== value)
          .map(([key]) => key),
      ],
      backend: {
        name: env.BACKEND_NAME || t("server.defaultBackendName"),
        nameConfigured: Boolean(env.BACKEND_NAME),
        transport:
          address.transport === "webtransport" ? "webtransport" : "http",
        endpoint,
        rootPath:
          env.BACKEND_ROOT === defaults.rootPath ? "" : env.BACKEND_ROOT || "",
        auth: ["basic", "bearer"].includes(env.BACKEND_AUTH)
          ? env.BACKEND_AUTH
          : "none",
        gatewayAuth: env.GATEWAY_AUTH !== "false",
        certificateMode:
          env.CERTIFICATE_MODE === "webpki" ? "webpki" : "pinned",
      },
    },
  };
}

class CertificateInputError extends Error {}

export function validatePins(
  input,
  now = Date.now(),
  t = createTranslator("en"),
) {
  const list = input?.certificates;
  if (
    input?.version !== 1 ||
    !Array.isArray(list) ||
    list.length > 2 ||
    !list.length
  )
    throw new CertificateInputError(t("server.invalidCertificateDocument"));
  return list
    .map((pin) => {
      const start = Date.parse(pin?.notBefore),
        end = Date.parse(pin?.notAfter);
      if (
        pin?.algorithm !== "sha-256" ||
        typeof pin.value !== "string" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(pin.value) ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > 14 * 86400000
      )
        throw new CertificateInputError(t("server.invalidCertificatePin"));
      return {
        algorithm: "sha-256",
        value: pin.value,
        notBefore: pin.notBefore,
        notAfter: pin.notAfter,
      };
    })
    .filter((pin) => Date.parse(pin.notAfter) > now);
}
export async function configuration(env, t = createTranslator("en")) {
  if (env.DEMO_MODE === "true")
    return {
      version: 1,
      backend: {
        name: t("server.demoBackendName"),
        transport: "demo",
        endpoint: "",
        rootPath: "/",
        auth: "none",
        gatewayAuth: false,
        certificates: [],
      },
    };
  const address = backendAddress(env);
  if (address.conflict)
    throw new SetupRequired(
      t("server.conflictingBackends"),
      "conflicting-backends",
    );
  const transport = address.transport;
  if (!["http", "webtransport"].includes(transport))
    throw new SetupRequired(t("server.invalidBackendTransport"));
  if (!address.endpoint)
    throw new SetupRequired(
      t("server.missingBackendEndpoint"),
      "missing-backend",
    );
  let endpoint;
  try {
    endpoint = new URL(address.endpoint);
  } catch {
    throw new SetupRequired(t("server.invalidBackendEndpoint"));
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    !["https:", "http:"].includes(endpoint.protocol)
  )
    throw new SetupRequired(t("server.invalidBackendUrl"));
  if (transport === "webtransport" && endpoint.protocol !== "https:")
    throw new SetupRequired(t("server.webtransportRequiresHttps"));
  const root = env.BACKEND_ROOT || defaultBackendRoot(transport, endpoint);
  if (
    !root.startsWith("/") ||
    /[?#\\\x00-\x1f]/.test(root) ||
    root.split("/").some((part) => [".", ".."].includes(part))
  )
    throw new SetupRequired(t("server.invalidBackendRoot"));
  const auth = env.BACKEND_AUTH || defaults.auth;
  if (!["none", "basic", "bearer"].includes(auth))
    throw new SetupRequired(t("server.invalidBackendAuth"));
  let certificates = [];
  if (transport === "webtransport" && env.CERTIFICATE_MODE !== "webpki") {
    // Storage outages are operational errors, not an invitation to reconfigure.
    const saved =
      typeof env.KV?.get === "function"
        ? await env.KV.get("certificate-pins", "json")
        : env.CERTIFICATES_JSON;
    try {
      certificates = validatePins(
        typeof saved === "string" ? JSON.parse(saved) : saved,
        Date.now(),
        t,
      );
    } catch {
      throw new SetupRequired(
        t("server.missingCertificatePins"),
        "missing-certificates",
      );
    }
    if (!certificates.length)
      throw new SetupRequired(
        t("server.expiredCertificatePins"),
        "missing-certificates",
      );
  }
  return {
    version: 1,
    backend: {
      name: env.BACKEND_NAME || t("server.defaultBackendName"),
      transport,
      endpoint: transport === "http" ? endpoint.origin : endpoint.href,
      rootPath: root.endsWith("/") ? root : root + "/",
      auth,
      gatewayAuth: transport === "webtransport" && env.GATEWAY_AUTH !== "false",
      certificates,
    },
  };
}
async function smallJSON(request, t) {
  const reader = request.body?.getReader();
  if (!reader) throw new CertificateInputError(t("server.missingBody"));
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new CertificateInputError(t("server.bodyTooLarge"));
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CertificateInputError(t("server.invalidJson"));
  }
}
async function equalSecret(a, b) {
  const digest = async (value) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
export default {
  async fetch(request, env) {
    const t = createTranslator(
      detectRequestLanguage(request.headers.get("Accept-Language")),
    );
    const respond = (data, status = 200, headers = {}) =>
      json(data, status, {
        "Content-Language": t.locale,
        Vary: "Accept-Language",
        ...headers,
      });
    const url = new URL(request.url);
    const account = await authentication(request, env, t);
    if (account) return secureResponse(account);
    if (url.pathname === "/api/config" && request.method === "GET") {
      try {
        return respond(await configuration(env, t));
      } catch (error) {
        if (error instanceof SetupRequired)
          return respond(setupConfiguration(env, error.reason, t));
        return respond({ error: t("server.configurationUnavailable") }, 503);
      }
    }
    if (url.pathname.startsWith("/api/certificates/")) {
      if (request.method !== "PUT")
        return respond({ error: t("server.certificateMethod") }, 405, {
          Allow: "PUT",
        });
      if (url.search)
        return respond(
          {
            error: t("server.invalidWebhookUrl"),
            code: "INVALID_WEBHOOK_URL",
          },
          400,
        );
      if (typeof env.KV?.put !== "function")
        return respond(
          {
            error: t("server.missingKvBinding"),
            code: "MISSING_KV_BINDING",
          },
          503,
        );
      const tokens = await certificateWebhookTokens(env).catch(() => null);
      if (!tokens?.length)
        return respond(
          {
            error: t("server.invalidSiteKey"),
            code: "INVALID_SITE_KEY",
          },
          503,
        );
      let authorized = false;
      for (const token of tokens)
        authorized =
          (await equalSecret(url.pathname, `/api/certificates/${token}`)) ||
          authorized;
      if (!authorized)
        return respond(
          {
            error: t("server.invalidWebhookToken"),
            code: "INVALID_WEBHOOK_TOKEN",
          },
          401,
          { "WWW-Authenticate": 'Webhook realm="certificate-updates"' },
        );
      if (
        request.headers.get("Content-Type")?.split(";")[0].trim() !==
        "application/json"
      )
        return respond({ error: t("server.expectedJson") }, 415);
      let data;
      try {
        data = await smallJSON(request, t);
        const certificates = validatePins(data, Date.now(), t);
        if (!certificates.length)
          throw new CertificateInputError(t("server.allCertificatesExpired"));
        data = { version: 1, certificates };
      } catch (error) {
        return respond(
          {
            error:
              error instanceof CertificateInputError
                ? error.message
                : t("server.invalidCertificateDocument"),
          },
          400,
        );
      }
      // Acknowledge only durable writes. A failed PUT is retried by the gateway.
      try {
        await env.KV.put("certificate-pins", JSON.stringify(data));
      } catch {
        return respond(
          { error: t("server.certificateStorageUnavailable") },
          503,
        );
      }
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (url.pathname.startsWith("/api/"))
      return respond({ error: t("server.notFound") }, 404);
    return secureResponse(await env.ASSETS.fetch(request));
  },
};
