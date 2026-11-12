import { cachePolicy } from "./cache.js";
import {
  PersistentByteCache,
  clearPersistentCaches,
  publicFileKey,
} from "./persistent-cache.js";
import { backendPaths } from "../../shared/backend-paths.js";

const MiB = 1024 * 1024;
export const originalImageLimit = 25 * MiB;
export const originalImageAccept = "image/*";
const headers = ["Content-Type", "Cache-Control", "ETag", "Age", "Vary"];
const preview = {
  name: "lantern-dock-public-images-v1",
  prefix: "/.lantern-dock-cache/images/v1/",
  maxBody: 8 * MiB,
  maxBytes: 64 * MiB,
  maxEntries: 512,
  headers,
  allowsKey: (path, accept) =>
    accept !== originalImageAccept &&
    /^\/api\/[a-zA-Z0-9_/-]+\/[^/]+\/(?:info\.json|full\/\d+,\d+\/0\/default\.jpg)$/.test(
      path,
    ),
  allowsResponse: allowed,
};
const originals = {
  name: "lantern-dock-public-originals-v1",
  prefix: "/.lantern-dock-cache/originals/v1/",
  maxBody: originalImageLimit,
  maxBytes: 128 * MiB,
  maxEntries: 32,
  headers,
  transport: "webtransport",
  allowsKey: (path, accept, cache) =>
    accept === originalImageAccept &&
    publicFileKey(path, cache, backendPaths.files),
  allowsResponse: allowed,
};
export const supportedImageVary = (headers) =>
  (headers.get("Vary") || "")
    .split(",")
    .every((value) =>
      ["", "accept", "origin"].includes(value.trim().toLowerCase()),
    );

function allowed(headers, accept) {
  const type = headers.get("Content-Type")?.split(";")[0].trim();
  const etag = headers.get("ETag");
  return (
    etag &&
    etag.length <= 1024 &&
    cachePolicy(headers).storable &&
    (accept === originalImageAccept
      ? type?.startsWith("image/")
      : accept === "image/jpeg"
        ? type === "image/jpeg"
        : accept === "application/ld+json" &&
          ["application/json", "application/ld+json"].includes(type)) &&
    supportedImageVary(headers)
  );
}

export class PersistentImageCache extends PersistentByteCache {
  constructor(transport, { original = false, ...options } = {}) {
    super(transport, original ? originals : preview, options);
  }
}

export function clearPersistentImages(options) {
  return clearPersistentCaches([preview, originals], options);
}
