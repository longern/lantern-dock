import { coreError } from "./errors.js";
import { limitedBytes } from "./content.js";
export { limitedBytes } from "./content.js";
import { MemoryCache, cachePolicy } from "./cache.js";
import { ImageClient } from "./images.js";

export function normalizePath(value) {
  if (!value.startsWith("/") || /[?#\\\x00-\x1f]/.test(value))
    throw coreError("INVALID_PATH");
  const trailing = value.endsWith("/");
  const parts = value
    .split("/")
    .filter(Boolean)
    .map((part) => {
      let decoded;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        throw coreError("INVALID_PATH_ENCODING");
      }
      if ([".", ".."].includes(decoded) || /[\/\\\x00-\x1f]/.test(decoded))
        throw coreError("PATH_DENIED");
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
    ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "heic", "heif"].includes(ext)
  )
    return "image";
  if (["mp4", "m4v", "mkv", "mov", "webm", "avi", "ogv"].includes(ext))
    return "video";
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
    throw coreError("UNSAFE_XML");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (
    doc.querySelector("parsererror") ||
    doc.documentElement.localName !== "multistatus" ||
    doc.documentElement.namespaceURI !== "DAV:"
  )
    throw coreError("INVALID_WEBDAV");
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
export function checkResponse(response) {
  if (!response.ok) void response.body?.cancel().catch(() => {});
  if (response.status === 401)
    throw coreError("BACKEND_LOGIN_REQUIRED");
  if (response.status === 407)
    throw coreError("GATEWAY_AUTH_REQUIRED");
  if (response.status === 403)
    throw coreError("BACKEND_ACCESS_DENIED");
  if (!response.ok)
    throw coreError("BACKEND_RESPONSE_ERROR", { status: response.status });
  return response;
}
export class DAVClient {
  constructor(transport, config) {
    this.transport = transport;
    this.root = normalizePath(config.rootPath);
    this.directories = new MemoryCache(16 * 1024 * 1024, 64);
    this.images = new ImageClient(transport, { root: this.root });
  }
  dispose() {
    this.images.dispose();
    this.directories.clear();
  }
  cached(path) {
    return this.directories.get(normalizePath(path).replace(/\/?$/, "/"))?.value
      .entries;
  }
  async list(path, signal, { force = false } = {}) {
    signal?.throwIfAborted();
    path = normalizePath(path);
    if (!withinRoot(path, this.root)) throw coreError("OUTSIDE_ROOT");
    if (!path.endsWith("/")) path += "/";
    const cached = this.directories.get(path);
    if (!force && cached && Date.now() - cached.time < cached.value.freshFor)
      return cached.value.entries;
    if (force) this.images.expire();
    try {
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
      const result = parseDAV(new TextDecoder().decode(bytes), path, this.root);
      const policy = cachePolicy(response.headers);
      if (policy.storable)
        this.directories.set(
          path,
          { entries: result, freshFor: policy.freshFor },
          JSON.stringify(result).length * 2,
        );
      else this.directories.delete(path);
      return result;
    } catch (error) {
      if (!signal?.aborted) this.directories.delete(path);
      throw error;
    }
  }
  async read(path, signal, headers = {}, method = "GET") {
    path = normalizePath(path);
    if (!withinRoot(path, this.root)) throw coreError("OUTSIDE_ROOT");
    if (!["GET", "HEAD"].includes(method))
      throw coreError("PREVIEW_READ_ONLY");
    return this.transport.request(path, { signal, headers, method });
  }
  async get(path, signal) {
    return checkResponse(await this.read(path, signal));
  }
}
