export function normalizePath(value) {
  if (!value.startsWith("/") || /[?#\\\x00-\x1f]/.test(value))
    throw new Error("无效文件路径");
  const trailing = value.endsWith("/");
  const parts = value
    .split("/")
    .filter(Boolean)
    .map((part) => {
      let decoded;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        throw new Error("无效路径编码");
      }
      if ([".", ".."].includes(decoded) || /[\/\\\x00-\x1f]/.test(decoded))
        throw new Error("不允许访问此路径");
      return encodeURIComponent(decoded);
    });
  return "/" + parts.join("/") + (trailing && parts.length ? "/" : "");
}
export function withinRoot(path, root) {
  const base = root === "/" ? "/" : root.replace(/\/$/, "") + "/";
  return path === root.replace(/\/$/, "") || path.startsWith(base);
}
export function kindFor(name, isDirectory) {
  if (isDirectory) return "folder";
  const ext = name.split(".").pop().toLowerCase();
  if (
    ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "heic"].includes(ext)
  )
    return "image";
  if (["mp4", "mkv", "mov", "webm", "avi"].includes(ext)) return "video";
  if (["mp3", "flac", "m4a", "wav", "ogg"].includes(ext)) return "audio";
  if (
    [
      "txt",
      "md",
      "json",
      "csv",
      "log",
      "yaml",
      "yml",
      "xml",
      "js",
      "css",
    ].includes(ext)
  )
    return "text";
  if (ext === "pdf") return "pdf";
  if (["zip", "7z", "rar", "tar", "gz"].includes(ext)) return "archive";
  return "file";
}
const localChildren = (node, name) =>
  Array.from(node.children).filter(
    (child) => child.localName === name && child.namespaceURI === "DAV:",
  );
const child = (node, name) => localChildren(node, name)[0];
const text = (node, name) => child(node, name)?.textContent?.trim() || "";
export function parseDAV(xml, currentPath, rootPath) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("后端返回了不安全的 XML");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (
    doc.querySelector("parsererror") ||
    doc.documentElement.localName !== "multistatus" ||
    doc.documentElement.namespaceURI !== "DAV:"
  )
    throw new Error(
      "后端未返回有效 WebDAV 目录。请确认地址指向 WebDAV 挂载路径。",
    );
  const current = normalizePath(currentPath),
    root = normalizePath(rootPath),
    items = [],
    seen = new Set();
  for (const response of localChildren(doc.documentElement, "response")) {
    const href = text(response, "href");
    if (!href) continue;
    let path;
    try {
      path = normalizePath(
        new URL(href, "https://backend.invalid" + current).pathname,
      );
    } catch {
      continue;
    }
    if (
      !withinRoot(path, root) ||
      path.replace(/\/$/, "") === current.replace(/\/$/, "")
    )
      continue;
    const relative = path.slice(current.length);
    if (!path.startsWith(current) || relative.replace(/\/$/, "").includes("/"))
      continue;
    const propstat = localChildren(response, "propstat").find((node) =>
      /^HTTP\/\d\.\d 2\d\d/.test(text(node, "status")),
    );
    const prop = propstat && child(propstat, "prop");
    if (!prop) continue;
    const directory = !!child(
      child(prop, "resourcetype") || prop,
      "collection",
    );
    if (directory && !path.endsWith("/")) path += "/";
    if (seen.has(path)) continue;
    seen.add(path);
    const name = decodeURIComponent(path.replace(/\/$/, "").split("/").pop());
    const rawSize = text(prop, "getcontentlength");
    items.push({
      path,
      name,
      isDirectory: directory,
      size: /^\d+$/.test(rawSize) ? Number(rawSize) : null,
      modified: text(prop, "getlastmodified"),
      mime: text(prop, "getcontenttype"),
      etag: text(prop, "getetag"),
      kind: kindFor(name, directory),
    });
  }
  return items;
}
export async function limitedBytes(response, limit, signal) {
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > limit) {
    await response.body?.cancel();
    throw new Error("文件超过此浏览器的预览 / 内存下载限制。");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit)
        throw new Error("文件超过此浏览器的预览 / 内存下载限制。");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of chunks) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
export function checkResponse(response) {
  if (!response.ok) void response.body?.cancel().catch(() => {});
  if (response.status === 401)
    throw new Error("后端需要登录，请填写后端账号或访问令牌。");
  if (response.status === 407)
    throw new Error("网关需要认证，请填写 Bridge 访问令牌。");
  if (response.status === 403)
    throw new Error("后端拒绝访问。请检查文件权限和网关路径白名单。");
  if (!response.ok)
    throw new Error(`后端返回 ${response.status}，请检查服务地址和访问权限。`);
  return response;
}
export class DAVClient {
  constructor(transport, config) {
    this.transport = transport;
    this.root = normalizePath(config.rootPath);
  }
  async list(path, signal) {
    path = normalizePath(path);
    if (!withinRoot(path, this.root)) throw new Error("不能离开配置的根目录");
    if (!path.endsWith("/")) path += "/";
    const response = checkResponse(
      await this.transport.request(path, {
        method: "PROPFIND",
        headers: {
          Depth: "1",
          "Content-Type": "application/xml; charset=utf-8",
          Accept: "application/xml",
        },
        body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/><d:getetag/></d:prop></d:propfind>',
        signal,
      }),
    );
    const bytes = await limitedBytes(response, 8 * 1024 * 1024, signal);
    return parseDAV(new TextDecoder().decode(bytes), path, this.root);
  }
  async get(path, signal) {
    path = normalizePath(path);
    if (!withinRoot(path, this.root)) throw new Error("不能离开配置的根目录");
    return checkResponse(await this.transport.request(path, { signal }));
  }
}
