import { cachePolicy } from "./cache.js";
import { clearPersistentImages } from "./image-cache.js";
import {
  PersistentByteCache,
  clearPersistentCaches,
  publicFileKey,
} from "./persistent-cache.js";
import { backendPaths } from "../../shared/backend-paths.js";

export const videoRangeSize = 1024 * 1024;
const defaultBudget = 512 * videoRangeSize;
const reservedBytes = 256 * videoRangeSize;
const maximumBudget = 2 * 1024 * videoRangeSize;
const cacheHeaders = [
  "Cache-Control",
  "Age",
  "Date",
  "Expires",
  "ETag",
  "Vary",
];
const strongETag = /^"[\x21\x23-\x7e\x80-\xff]*"$/;

export function videoETag(headers) {
  const value = headers.get("ETag");
  return value?.length <= 1024 && strongETag.test(value) ? value : "";
}

export function videoRange(headers) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    headers.get("Content-Range") || "",
  );
  if (!match) return null;
  const start = Number(match[1]),
    end = Number(match[2]),
    size = Number(match[3]);
  return [start, end, size].every(Number.isSafeInteger) &&
    start <= end &&
    end < size &&
    end - start < videoRangeSize
    ? { start, end, size }
    : null;
}

const supportedVary = (headers) =>
  (headers.get("Vary") || "")
    .split(",")
    .every((field) =>
      ["", "origin", "range"].includes(field.trim().toLowerCase()),
    );

export function canStoreVideoRange(headers, range) {
  const value = videoRange(headers);
  const key = /^bytes=(\d+)-(\d+)$/.exec(range);
  const encoding = headers.get("Content-Encoding")?.trim().toLowerCase();
  return !!(
    key &&
    value &&
    value.start === Number(key[1]) &&
    value.end === Math.min(Number(key[2]), value.size - 1) &&
    (!encoding || encoding === "identity") &&
    videoETag(headers) &&
    cachePolicy(headers).storable &&
    supportedVary(headers)
  );
}

const videos = {
  name: "lantern-dock-public-video-ranges-v1",
  prefix: "/.lantern-dock-cache/video-ranges/v1/",
  maxBody: videoRangeSize,
  maxBytes: maximumBudget,
  maxEntries: maximumBudget / videoRangeSize,
  maxIndexBytes: videoRangeSize,
  adaptive: true,
  defaultBudget,
  headers: [
    ...cacheHeaders,
    "Content-Type",
    "Content-Range",
    "Content-Encoding",
  ],
  transport: "webtransport",
  allowsKey: (path, range, cache) =>
    /^bytes=\d+-\d+$/.test(range) &&
    publicFileKey(path, cache, backendPaths.files),
  allowsResponse: canStoreVideoRange,
};

export class PersistentVideoCache extends PersistentByteCache {
  constructor(
    transport,
    {
      estimate = () => globalThis.navigator?.storage?.estimate?.(),
      ...options
    } = {},
  ) {
    super(transport, videos, options);
    if (!this.disabled) {
      void this.resize(async (bytes) => {
        let timer;
        try {
          const storage = await Promise.race([
            estimate(),
            new Promise((resolve) => {
              timer = setTimeout(resolve, 250);
            }),
          ]);
          return videoCacheBudget(storage, bytes);
        } catch {
          return defaultBudget;
        } finally {
          clearTimeout(timer);
        }
      }).catch(() => {
        this.disabled = true;
      });
    }
  }
}

export function videoCacheBudget({ quota, usage } = {}, videoBytes = 0) {
  if (![quota, usage].every((value) => Number.isFinite(value) && value >= 0))
    return defaultBudget;
  return Math.floor(
    Math.min(
      maximumBudget,
      Math.max(0, quota - usage + videoBytes - reservedBytes),
    ),
  );
}

// Discovery also supplies the poster. A slow optional capability response
// should not hold up the first video range.
export async function waitForPublicFiles(images) {
  if (images.publicFiles !== undefined) return images.publicFiles;
  let timer;
  try {
    return await Promise.race([
      images.service().then(
        () => images.publicFiles,
        () => false,
      ),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 250, false);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function clearPersistentMedia(options) {
  return Promise.all([
    clearPersistentImages(options),
    clearPersistentCaches([videos], options),
  ]);
}

export function isFreshVideoRange({ headers, time }, now = Date.now()) {
  const policy = headers.get("Cache-Control") || "";
  if (/\b(?:no-cache|no-store)\b/i.test(policy) || now < time) return false;
  const maxAge = [
    ...policy.matchAll(/(?:^|,)\s*max-age\s*=\s*(?:"(\d+)"|(\d+))\s*(?=,|$)/gi),
  ];
  if (maxAge.length > 1 || (!maxAge.length && /\bmax-age\b/i.test(policy)))
    return false;
  const serverTime = Date.parse(headers.get("Date"));
  const date = Number.isFinite(serverTime) ? serverTime : time;
  const expires = Date.parse(headers.get("Expires"));
  const lifetime = maxAge.length
    ? Math.min(2 ** 31, Number(maxAge[0][1] ?? maxAge[0][2])) * 1000
    : expires - date;
  const age = Number(headers.get("Age"));
  const initialAge = Math.max(
    0,
    time - date,
    Number.isFinite(age) ? age * 1000 : 0,
  );
  return now - time + initialAge < lifetime;
}

export function revalidatedVideoHeaders(cached, response) {
  const etag = response.get("ETag");
  if (
    (etag !== null && etag !== cached.get("ETag")) ||
    !supportedVary(response)
  )
    return null;
  const headers = new Headers(cached);
  headers.delete("Date");
  headers.delete("Age");
  for (const name of cacheHeaders)
    if (response.has(name)) headers.set(name, response.get(name));
  return headers;
}
