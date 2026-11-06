import { normalizePath } from "./dav.js";
import {
  backendDefaults as defaults,
  defaultBackendRoot,
} from "../../shared/backend-defaults.js";

export function setupVariables(form, resetVariables = []) {
  const name = (form.name || "").trim() || defaults.name;
  if (/[\x00-\x1f]/.test(name))
    throw new Error("资源名称不能包含换行或控制字符。");
  if (!["http", "webtransport"].includes(form.transport))
    throw new Error("请选择连接方式。");
  let endpoint;
  try {
    endpoint = new URL(form.endpoint.trim());
  } catch {
    throw new Error("请填写完整的后端地址，例如 https://files.example.com。");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("请使用 HTTP(S) 地址，账号和令牌在连接时填写。");
  if (form.transport === "webtransport" && endpoint.protocol !== "https:")
    throw new Error("WebTransport 地址必须以 https:// 开头。");
  let root;
  try {
    root = normalizePath(
      form.rootPath.trim() || defaultBackendRoot(form.transport, endpoint),
    );
  } catch {
    throw new Error("根目录必须以 / 开头，且不能包含 ..、查询参数或无效编码。");
  }
  if (!root.endsWith("/")) root += "/";
  if (!["none", "basic", "bearer"].includes(form.auth))
    throw new Error("请选择后端认证方式。");
  const vars = {
    [form.transport === "http" ? "WEBDAV_URL" : "WEBTRANSPORT_URL"]:
      form.transport === "http"
        ? endpoint.origin + (root === "/" ? "" : root)
        : endpoint.href,
  };
  // Keep an explicit reset only when an existing variable would override the new defaults.
  const optional = (key, value, fallback) => {
    if (value !== fallback || resetVariables.includes(key)) vars[key] = value;
  };
  const otherAddress =
    form.transport === "http" ? "WEBTRANSPORT_URL" : "WEBDAV_URL";
  if (resetVariables.includes(otherAddress)) vars[otherAddress] = "";
  optional("BACKEND_NAME", name, defaults.name);
  optional("BACKEND_AUTH", form.auth, defaults.auth);
  if (form.transport === "webtransport") {
    optional("BACKEND_ROOT", root, defaults.rootPath);
    optional(
      "GATEWAY_AUTH",
      String(!!form.gatewayAuth),
      String(defaults.gatewayAuth),
    );
  } else if (root === "/") {
    // A bare origin uses /dav/ by default; preserve an explicit third-party root.
    vars.BACKEND_ROOT = "/";
  } else if (resetVariables.includes("BACKEND_ROOT")) vars.BACKEND_ROOT = "";
  if (form.transport === "webtransport") {
    if (!["pinned", "webpki"].includes(form.certificateMode))
      throw new Error("请选择网关证书类型。");
    optional(
      "CERTIFICATE_MODE",
      form.certificateMode,
      defaults.certificateMode,
    );
  }
  return vars;
}

export function setupSnippet(vars, target, secretKey = "") {
  if (target === "wrangler") return JSON.stringify({ vars }, null, 2) + "\n";
  return (
    Object.entries(secretKey ? { ...vars, SECRET_KEY: secretKey } : vars)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n"
  );
}
