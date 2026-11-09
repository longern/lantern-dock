import { cachePolicy } from "./cache.js";
import { limitedBytes } from "./content.js";

const name = "lantern-dock-public-images-v1";
const prefix = "/.lantern-dock-cache/images/v1/";
const maxBody = 8 * 1024 * 1024;
const headerNames = ["Content-Type", "Cache-Control", "ETag", "Age", "Vary"];
function cacheStorage() {
  try {
    return globalThis.caches;
  } catch {
    return undefined;
  }
}
const digest = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

function anonymous(transport) {
  const config = transport.config;
  try {
    const endpoint = new URL(config?.endpoint);
    return (
      ["http", "webtransport"].includes(config?.transport) &&
      ["http:", "https:"].includes(endpoint.protocol) &&
      !endpoint.username &&
      !endpoint.password &&
      config.auth === "none" &&
      (transport.credentials?.mode || "none") === "none" &&
      !transport.credentials?.gatewayToken
    );
  } catch {
    return false;
  }
}

function allowed(headers, accept) {
  const type = headers.get("Content-Type")?.split(";")[0].trim();
  const etag = headers.get("ETag");
  return (
    etag &&
    etag.length <= 1024 &&
    cachePolicy(headers).storable &&
    (accept === "image/jpeg"
      ? type === "image/jpeg"
      : accept === "application/ld+json" &&
        ["application/json", "application/ld+json"].includes(type)) &&
    (headers.get("Vary") || "")
      .split(",")
      .every((value) =>
        ["", "accept", "origin"].includes(value.trim().toLowerCase()),
      )
  );
}

// Cache API stores Responses, not credentials. Web Locks serialize the bounded
// LRU across tabs; browsers without either API keep using the memory cache.
export class PersistentImageCache {
  constructor(
    transport,
    {
      root = transport.config?.rootPath,
      storage = cacheStorage(),
      locks = globalThis.navigator?.locks,
      origin = globalThis.location?.origin,
      secure = globalThis.isSecureContext,
      maxBytes = 64 * 1024 * 1024,
      maxEntries = 512,
    } = {},
  ) {
    this.storage = storage;
    this.locks = locks;
    this.origin = origin;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.transport = transport;
    const config = transport.config;
    this.disabled =
      !secure ||
      !storage ||
      !locks?.request ||
      !origin ||
      !anonymous(transport) ||
      typeof root !== "string";
    if (!this.disabled) {
      this.scope = digest(
        JSON.stringify([config.transport, config.endpoint, root]),
      );
      this.scope.catch(() => {
        this.disabled = true;
      });
      // Fence even clients still waiting for service discovery when another
      // tab logs out. They must not adopt the post-logout epoch on first use.
      this.ready = this.run(() => true).catch(() => {
        this.disabled = true;
      });
    }
  }

  async key(path, version, accept) {
    // Only IIIF information and advertised JPEG renditions may reach disk.
    if (
      !/^\/api\/[a-zA-Z0-9_/-]+\/[^/]+\/(?:info\.json|full\/\d+,\d+\/0\/default\.jpg)$/.test(
        path,
      )
    )
      return null;
    try {
      return (
        this.origin +
        prefix +
        (await this.scope) +
        "/" +
        (await digest(JSON.stringify([path, version, accept])))
      );
    } catch {
      this.disabled = true;
      return null;
    }
  }

  async index(cache) {
    const key = this.origin + prefix + "index";
    const response = await cache.match(key);
    let index;
    try {
      index =
        response &&
        JSON.parse(
          new TextDecoder().decode(await limitedBytes(response, 512 * 1024)),
        );
      if (
        index?.version !== 1 ||
        typeof index.epoch !== "string" ||
        !Array.isArray(index.entries) ||
        index.entries.length > this.maxEntries ||
        index.entries.some(
          (entry) =>
            typeof entry.key !== "string" ||
            !entry.key.startsWith(this.origin + prefix) ||
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0 ||
            entry.size > maxBody ||
            !Number.isSafeInteger(entry.touched) ||
            entry.touched < 0,
        )
      )
        index = null;
    } catch {
      index = null;
    }
    if (!index) {
      // Recover interrupted writes or an obsolete/corrupt index conservatively.
      for (const request of await cache.keys()) await cache.delete(request);
      index = { version: 1, epoch: crypto.randomUUID(), entries: [] };
      await cache.put(key, Response.json(index));
    }
    return index;
  }

  async run(work) {
    if (this.disabled || !anonymous(this.transport)) return null;
    try {
      return await this.locks.request(name, async () => {
        if (this.disabled || !anonymous(this.transport)) return null;
        const cache = await this.storage.open(name);
        const index = await this.index(cache);
        // A logout/credential change invalidates queued writes from old clients,
        // including other tabs, without clearing unrelated site storage.
        this.epoch ??= index.epoch;
        if (this.epoch !== index.epoch) {
          this.disabled = true;
          return null;
        }
        return work(cache, index);
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // Quota, privacy settings and storage failures never block image delivery.
      this.disabled = true;
      return null;
    }
  }

  async get(path, version, accept, limit, signal) {
    if (this.disabled) return null;
    const key = await this.key(path, version, accept);
    if (!key) return null;
    return this.run(async (cache, index) => {
      signal?.throwIfAborted();
      const entry = index.entries.find((entry) => entry.key === key);
      if (!entry || entry.size > limit) return null;
      const response = await cache.match(key);
      if (!response || !allowed(response.headers, accept)) return null;
      const bytes = await limitedBytes(
        response,
        Math.min(limit, maxBody),
        signal,
      );
      if (bytes.byteLength !== entry.size) return null;
      // Disk entries are validators only: every restored response must first
      // be revalidated through the current connection, even with max-age.
      return {
        bytes,
        type: response.headers.get("Content-Type"),
        etag: response.headers.get("ETag"),
        headers: response.headers,
        ...cachePolicy(response.headers),
      };
    });
  }

  async put(path, version, accept, value, signal) {
    if (this.disabled) return;
    if (!allowed(value.headers, accept))
      return this.delete(path, version, accept);
    const size = value.bytes.byteLength;
    if (size > Math.min(maxBody, this.maxBytes)) return;
    const key = await this.key(path, version, accept);
    if (!key) return;
    await this.run(async (cache, index) => {
      signal?.throwIfAborted();
      const headers = new Headers();
      for (const field of headerNames)
        if (value.headers.has(field))
          headers.set(field, value.headers.get(field));
      const actual = new Set(
        (await cache.keys()).map((request) => request.url),
      );
      index.entries = index.entries.filter(
        (entry) => entry.key !== key && actual.has(entry.key),
      );
      const known = new Set(index.entries.map((entry) => entry.key));
      for (const url of actual)
        if (
          url !== key &&
          url !== this.origin + prefix + "index" &&
          !known.has(url)
        )
          await cache.delete(url);
      index.entries.sort((a, b) => a.touched - b.touched);
      let bytes = index.entries.reduce(
        (total, entry) => total + entry.size,
        size,
      );
      while (bytes > this.maxBytes || index.entries.length >= this.maxEntries) {
        const oldest = index.entries.shift();
        bytes -= oldest.size;
        await cache.delete(oldest.key);
      }
      signal?.throwIfAborted();
      await cache.put(key, new Response(value.bytes, { headers }));
      index.entries.push({ key, size, touched: Date.now() });
      await cache.put(this.origin + prefix + "index", Response.json(index));
    });
  }

  async delete(path, version, accept) {
    if (this.disabled) return;
    const key = await this.key(path, version, accept);
    if (!key) return;
    await this.run(async (cache, index) => {
      await cache.delete(key);
      index.entries = index.entries.filter((entry) => entry.key !== key);
      await cache.put(this.origin + prefix + "index", Response.json(index));
    });
  }
}

export async function clearPersistentImages({
  storage = cacheStorage(),
  locks = globalThis.navigator?.locks,
  origin = globalThis.location?.origin,
} = {}) {
  if (!storage || !locks?.request || !origin) return;
  try {
    await locks.request(name, async () => {
      const cache = await storage.open(name);
      for (const request of await cache.keys()) await cache.delete(request);
      await cache.put(
        origin + prefix + "index",
        Response.json({
          version: 1,
          epoch: crypto.randomUUID(),
          entries: [],
        }),
      );
    });
  } catch {
    /* Best effort: storage can be unavailable in private browsing. */
  }
}
