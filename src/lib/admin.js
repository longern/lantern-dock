import { t } from "../../shared/i18n.js";
import { identityProof, requestNASGrant } from "./identity.js";
import { DirectTransport } from "./transport.js";

export const ADMIN_LINKS = "/api/admin/links";
export const ADMIN_INBOX = "/api/admin/inbox";
const MiB = 1024 * 1024;

export function adminAccess(identity, nas) {
  if (identity.status === "loading") return "checking";
  if (identity.status === "signed-out") return "signed-out";
  if (identity.status !== "authenticated") return "identity-error";
  if (nas.status === "loading" || nas.status === "idle") return "checking";
  if (nas.status !== "ready") {
    if (nas.error?.code === "LOGIN_REQUIRED" || nas.error?.kind === "session-expired") return "identity-error";
    if (nas.error?.kind === "unauthorized" || nas.error?.kind === "identity-mismatch") return "unverified";
    return nas.error?.code === "NAS_NOT_CONFIGURED" ? "not-configured" : "nas-error";
  }
  if (nas.account?.user?.role !== "admin") return "forbidden";
  if (nas.account.capabilities?.adminLinks !== true && nas.account.capabilities?.adminInbox !== true)
    return "unsupported";
  return "ready";
}

function invalidResponse() {
  return new Error(t("admin.invalidResponse"));
}
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

// Pick public metadata explicitly. Never retain a token accidentally returned by
// a list response, or put it into the normal collection state.
export function linkMetadata(value) {
  if (!value || !identifier(value.id) || typeof value.title !== "string" ||
      !timestamp(value.expiresAt) || typeof value.revoked !== "boolean" ||
      !integer(value.maxFileBytes, 1) || !integer(value.maxTotalBytes, value.maxFileBytes) ||
      !integer(value.maxFiles, 1) || !integer(value.usedBytes) || !integer(value.usedFiles))
    throw invalidResponse();
  const { id, title, expiresAt, maxFileBytes, maxTotalBytes, maxFiles, revoked, usedBytes, usedFiles } = value;
  return { id, title, expiresAt, maxFileBytes, maxTotalBytes, maxFiles, revoked, usedBytes, usedFiles };
}
function uploadMetadata(value) {
  if (!value || !identifier(value.id) || !identifier(value.linkId) ||
      typeof value.linkTitle !== "string" || typeof value.name !== "string" ||
      !integer(value.size) || value.status !== "complete" || !timestamp(value.createdAt))
    throw invalidResponse();
  const { id, linkId, linkTitle, name, size, status, createdAt } = value;
  return { id, linkId, linkTitle, name, size, status, createdAt };
}
function pageResult(value, field, map) {
  if (!Array.isArray(value[field]) || value[field].length > 200 ||
      !(value.nextOffset === null || integer(value.nextOffset))) throw invalidResponse();
  return { items: value[field].map(map), nextOffset: value.nextOffset };
}
function itemPath(base, id) {
  if (!identifier(id)) throw invalidResponse();
  return `${base}/${encodeURIComponent(id)}`;
}
export function uploadLinkURL(token, base = location.href) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidResponse();
  const url = new URL(base);
  url.search = "";
  url.hash = `/upload/${token}`;
  return url.href;
}
export function linkState(link, now = Date.now()) {
  if (link.revoked) return "revoked";
  if (Date.parse(link.expiresAt) <= now) return "expired";
  if (link.usedFiles >= link.maxFiles || link.usedBytes >= link.maxTotalBytes) return "full";
  return "active";
}
export function createLinkInput(values, now = Date.now()) {
  const title = String(values.title || "").trim();
  if (!title || new TextEncoder().encode(title).length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(title))
    throw new Error(t("admin.invalidTitle"));
  const expiry = new Date(values.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now)
    throw new Error(t("admin.invalidExpiry"));
  const maxFileBytes = Math.round(Number(values.maxFileMiB) * MiB);
  const maxTotalBytes = Math.round(Number(values.maxTotalMiB) * MiB);
  const maxFiles = Number(values.maxFiles);
  if (!integer(maxFileBytes, 1) || !integer(maxTotalBytes, maxFileBytes) || !integer(maxFiles, 1))
    throw new Error(t("admin.invalidLimits"));
  return { title, expiresAt: expiry.toISOString(), maxFileBytes, maxTotalBytes, maxFiles };
}
export function localDateTime(value = new Date()) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export class AdminClient {
  constructor(account, { grant = requestNASGrant, proof = identityProof, transport } = {}) {
    this.account = account;
    this.transport = transport || new DirectTransport(account.backend);
    this.closed = false;
    this.grant = grant;
    this.proof = proof;
  }
  close() {
    this.closed = true;
    this.transport.close();
  }
  async response(path, scope, { method = "GET", signal, body } = {}) {
    if (this.closed) throw new DOMException(t("core.connectionClosed"), "AbortError");
    const capability = scope.startsWith("links:") ? "adminLinks" : "adminInbox";
    if (this.account.user?.role !== "admin" || this.account.capabilities?.[capability] !== true)
      throw new Error(t("admin.forbiddenDescription"));
    signal?.throwIfAborted();
    const grant = await this.grant(signal, scope);
    signal?.throwIfAborted();
    const config = this.transport.config;
    const origin = config.transport === "http" ? new URL(config.endpoint).origin : location.origin;
    const proof = await this.proof(method, origin + path, grant.access_token);
    signal?.throwIfAborted();
    if (this.closed) throw new DOMException(t("core.connectionClosed"), "AbortError");
    const response = await this.transport.request(path, {
      method, signal,
      headers: {
        Authorization: `DPoP ${grant.access_token}`, DPoP: proof,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      const error = new Error(typeof value.error === "string" ? value.error : t("admin.requestFailed"));
      error.code = value.code;
      error.status = response.status;
      throw error;
    }
    return response;
  }
  async links({ offset = 0, signal } = {}) {
    const response = await this.response(`${ADMIN_LINKS}?limit=100&offset=${offset}`, "links:read", { signal });
    return pageResult(await response.json(), "links", linkMetadata);
  }
  async create(input, signal) {
    const response = await this.response(ADMIN_LINKS, "links:write", { method: "POST", body: input, signal });
    const value = await response.json();
    const link = linkMetadata(value.link);
    // Validate before exposing a URL. This result lives only in the creation dialog.
    const url = uploadLinkURL(value.token);
    return { link, url };
  }
  async revoke(id, signal) {
    const response = await this.response(itemPath(ADMIN_LINKS, id), "links:write", { method: "DELETE", signal });
    await response.body?.cancel();
  }
  async inbox({ linkId = "", offset = 0, signal } = {}) {
    const query = new URLSearchParams({ limit: "100", offset: String(offset) });
    if (linkId) {
      if (!identifier(linkId)) throw invalidResponse();
      query.set("linkId", linkId);
    }
    const response = await this.response(`${ADMIN_INBOX}?${query}`, "inbox:read", { signal });
    return pageResult(await response.json(), "uploads", uploadMetadata);
  }
  download(id, signal) {
    return this.response(`${itemPath(ADMIN_INBOX, id)}/download`, "inbox:read", { signal });
  }
}
