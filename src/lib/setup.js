import { normalizePath } from "./dav.js";

export function setupVariables(form) {
  const name = (form.name || "").trim() || "我的文件";
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
  if (form.transport === "http" && endpoint.pathname !== "/")
    throw new Error(
      "HTTPS 地址只需填写域名和端口，请把 WebDAV 挂载路径填到根目录。",
    );
  if (form.transport === "webtransport" && endpoint.protocol !== "https:")
    throw new Error("WebTransport 地址必须以 https:// 开头。");
  let root;
  try {
    root = normalizePath(form.rootPath.trim() || "/");
  } catch {
    throw new Error("根目录必须以 / 开头，且不能包含 ..、查询参数或无效编码。");
  }
  if (!root.endsWith("/")) root += "/";
  if (!["none", "basic", "bearer"].includes(form.auth))
    throw new Error("请选择后端认证方式。");
  const vars = {
    BACKEND_NAME: name,
    BACKEND_TRANSPORT: form.transport,
    BACKEND_ENDPOINT:
      form.transport === "http" ? endpoint.origin : endpoint.href,
    BACKEND_ROOT: root,
    BACKEND_AUTH: form.auth,
    GATEWAY_AUTH: String(
      form.transport === "webtransport" && !!form.gatewayAuth,
    ),
  };
  if (form.transport === "webtransport") {
    if (!["pinned", "webpki"].includes(form.certificateMode))
      throw new Error("请选择网关证书类型。");
    vars.CERTIFICATE_MODE = form.certificateMode;
  }
  vars.DEMO_MODE = "false";
  return vars;
}

export function setupSnippet(vars, target) {
  return target === "local"
    ? Object.entries(vars)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") + "\n"
    : JSON.stringify({ vars }, null, 2) + "\n";
}
