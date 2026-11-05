import {
  backendDefaults as defaults,
  backendAddress,
} from "../shared/backend-defaults.js";
import { certificateWebhookTokens } from "./secrets.js";

const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

class SetupRequired extends Error {
  constructor(message, reason = "invalid-configuration") {
    super(message);
    this.reason = reason;
  }
}

function setupConfiguration(env, reason) {
  const address = backendAddress(env);
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
      resetVariables: [
        ...["WEBDAV_URL", "WEBTRANSPORT_URL"].filter((key) => env[key]?.trim()),
        ...(env.BACKEND_ROOT ? ["BACKEND_ROOT"] : []),
        ...Object.entries({
          BACKEND_NAME: defaults.name,
          BACKEND_AUTH: defaults.auth,
          GATEWAY_AUTH: String(defaults.gatewayAuth),
          CERTIFICATE_MODE: defaults.certificateMode,
        })
          .filter(([key, value]) => env[key] && env[key] !== value)
          .map(([key]) => key),
      ],
      backend: {
        name: env.BACKEND_NAME || defaults.name,
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

export function validatePins(input, now = Date.now()) {
  const list = input?.certificates;
  if (
    input?.version !== 1 ||
    !Array.isArray(list) ||
    list.length > 2 ||
    !list.length
  )
    throw new Error("Invalid certificate document");
  return list
    .map((pin) => {
      const start = Date.parse(pin.notBefore),
        end = Date.parse(pin.notAfter);
      if (
        pin.algorithm !== "sha-256" ||
        typeof pin.value !== "string" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(pin.value) ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > 14 * 86400000
      )
        throw new Error("Invalid certificate pin");
      return {
        algorithm: "sha-256",
        value: pin.value,
        notBefore: pin.notBefore,
        notAfter: pin.notAfter,
      };
    })
    .filter((pin) => Date.parse(pin.notAfter) > now);
}
export async function configuration(env) {
  if (env.DEMO_MODE === "true")
    return {
      version: 1,
      backend: {
        name: "公开资源库",
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
      "Set either WEBDAV_URL or WEBTRANSPORT_URL",
      "conflicting-backends",
    );
  const transport = address.transport;
  if (!["http", "webtransport"].includes(transport))
    throw new SetupRequired("BACKEND_TRANSPORT must be http or webtransport");
  if (!address.endpoint)
    throw new SetupRequired(
      "Configure BACKEND_ENDPOINT before connecting",
      "missing-backend",
    );
  let endpoint;
  try {
    endpoint = new URL(address.endpoint);
  } catch {
    throw new SetupRequired("Configure a valid BACKEND_ENDPOINT");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    !["https:", "http:"].includes(endpoint.protocol)
  )
    throw new SetupRequired("Invalid backend URL");
  if (transport === "webtransport" && endpoint.protocol !== "https:")
    throw new SetupRequired("WebTransport requires an HTTPS endpoint");
  const root =
    env.BACKEND_ROOT ||
    (transport === "http" ? endpoint.pathname : defaults.rootPath);
  if (
    !root.startsWith("/") ||
    /[?#\\\x00-\x1f]/.test(root) ||
    root.split("/").some((part) => [".", ".."].includes(part))
  )
    throw new SetupRequired("Invalid BACKEND_ROOT");
  const auth = env.BACKEND_AUTH || defaults.auth;
  if (!["none", "basic", "bearer"].includes(auth))
    throw new SetupRequired("Invalid BACKEND_AUTH");
  let certificates = [];
  if (transport === "webtransport" && env.CERTIFICATE_MODE !== "webpki") {
    // Storage outages are operational errors, not an invitation to reconfigure.
    const saved = env.PINS
      ? await env.PINS.get("certificate-pins", "json")
      : env.CERTIFICATES_JSON;
    try {
      certificates = validatePins(
        typeof saved === "string" ? JSON.parse(saved) : saved,
      );
    } catch {
      throw new SetupRequired(
        "Publish valid gateway certificate pins",
        "missing-certificates",
      );
    }
    if (!certificates.length)
      throw new SetupRequired(
        "No unexpired certificate pins; publish the gateway certificate first",
        "missing-certificates",
      );
  }
  return {
    version: 1,
    backend: {
      name: env.BACKEND_NAME || defaults.name,
      transport,
      endpoint: transport === "http" ? endpoint.origin : endpoint.href,
      rootPath: root.endsWith("/") ? root : root + "/",
      auth,
      gatewayAuth: transport === "webtransport" && env.GATEWAY_AUTH !== "false",
      certificates,
    },
  };
}
async function smallJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new Error("Body exceeds 8 KiB");
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
  return JSON.parse(new TextDecoder().decode(bytes));
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
    const url = new URL(request.url);
    if (url.pathname === "/api/config" && request.method === "GET") {
      try {
        return json(await configuration(env));
      } catch (error) {
        if (error instanceof SetupRequired)
          return json(setupConfiguration(env, error.reason));
        return json({ error: "服务配置暂不可用，请稍后重试。" }, 503);
      }
    }
    if (url.pathname.startsWith("/api/certificates/")) {
      if (request.method !== "PUT" || url.search || !env.PINS)
        return json({ error: "Not found" }, 404);
      const tokens = await certificateWebhookTokens(env).catch(() => []);
      let authorized = false;
      for (const token of tokens)
        authorized =
          (await equalSecret(url.pathname, `/api/certificates/${token}`)) ||
          authorized;
      if (!authorized) return json({ error: "Not found" }, 404);
      if (
        request.headers.get("Content-Type")?.split(";")[0].trim() !==
        "application/json"
      )
        return json({ error: "Expected JSON" }, 415);
      let data;
      try {
        data = await smallJSON(request);
        const certificates = validatePins(data);
        if (!certificates.length) throw new Error("All certificates expired");
        data = { version: 1, certificates };
      } catch (error) {
        return json({ error: error.message }, 400);
      }
      // Acknowledge only durable writes. A failed PUT is retried by the gateway.
      try {
        await env.PINS.put("certificate-pins", JSON.stringify(data));
      } catch {
        return json({ error: "Certificate storage unavailable" }, 503);
      }
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (url.pathname.startsWith("/api/"))
      return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
