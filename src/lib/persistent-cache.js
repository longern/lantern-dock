import { cachePolicy } from "./cache.js";
import { limitedBytes } from "./content.js";

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
const storedBytes = (entries) =>
  entries.reduce((total, entry) => total + entry.size, 0);

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

// Cache API stores Responses, not credentials. Web Locks serialize the bounded
// LRU across tabs; storage is optional for callers.
export class PersistentByteCache {
  constructor(
    transport,
    policy,
    {
      root = transport.config?.rootPath,
      storage = cacheStorage(),
      locks = globalThis.navigator?.locks,
      origin = globalThis.location?.origin,
      secure = globalThis.isSecureContext,
      maxBytes,
      maxEntries,
    } = {},
  ) {
    this.storage = storage;
    this.locks = locks;
    this.origin = origin;
    this.policy = policy;
    this.maxBytes = maxBytes ?? this.policy.maxBytes;
    this.maxEntries = maxEntries ?? this.policy.maxEntries;
    this.root = typeof root === "string" ? root.replace(/\/?$/, "/") : "";
    this.transport = transport;
    const config = transport.config;
    this.disabled =
      !secure ||
      !storage ||
      !locks?.request ||
      !origin ||
      !anonymous(transport) ||
      (policy.transport && config.transport !== policy.transport) ||
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

  async key(path, version, variant) {
    try {
      if (!this.policy.allowsKey(path, variant, this)) return null;
      return (
        this.origin +
        this.policy.prefix +
        (await this.scope) +
        "/" +
        (await digest(JSON.stringify([path, version, variant])))
      );
    } catch {
      this.disabled = true;
      return null;
    }
  }

  async index(cache) {
    const { prefix, maxBody } = this.policy;
    const key = this.origin + prefix + "index";
    const response = await cache.match(key);
    let index;
    try {
      index =
        response &&
        JSON.parse(
          new TextDecoder().decode(
            await limitedBytes(
              response,
              this.policy.maxIndexBytes ?? 512 * 1024,
            ),
          ),
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
      return await this.locks.request(this.policy.name, async () => {
        if (this.disabled || !anonymous(this.transport)) return null;
        const cache = await this.storage.open(this.policy.name);
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
      // Quota, privacy settings and storage failures never block media delivery.
      this.disabled = true;
      return null;
    }
  }

  async get(path, version, variant, limit, signal) {
    if (this.disabled) return null;
    const key = await this.key(path, version, variant);
    if (!key) return null;
    return this.run(async (cache, index) => {
      signal?.throwIfAborted();
      const entry = index.entries.find((entry) => entry.key === key);
      if (!entry || entry.size > limit) return null;
      const response = await cache.match(key);
      if (!response || !this.policy.allowsResponse(response.headers, variant))
        return null;
      const bytes = await limitedBytes(
        response,
        Math.min(limit, this.policy.maxBody),
        signal,
      );
      if (bytes.byteLength !== entry.size) return null;
      return {
        bytes,
        time: entry.touched,
        type: response.headers.get("Content-Type"),
        etag: response.headers.get("ETag"),
        headers: response.headers,
        ...cachePolicy(response.headers),
      };
    });
  }

  budget(index) {
    const budget =
      this.policy.adaptive &&
      Number.isSafeInteger(index.budget) &&
      index.budget >= 0
        ? index.budget
        : (this.policy.defaultBudget ?? this.maxBytes);
    return Math.min(this.maxBytes, budget);
  }

  async evict(cache, index, pendingBytes = 0, pendingEntries = 0) {
    index.entries.sort((a, b) => a.touched - b.touched);
    let bytes = storedBytes(index.entries) + pendingBytes;
    const budget = this.budget(index);
    while (
      index.entries.length &&
      (bytes > budget ||
        index.entries.length + pendingEntries > this.maxEntries)
    ) {
      const oldest = index.entries.shift();
      bytes -= oldest.size;
      await cache.delete(oldest.key);
    }
  }

  async resize(estimateBudget) {
    return this.run(async (cache, index) => {
      const oldCount = index.entries.length;
      await this.reconcile(cache, index);
      const bytes = storedBytes(index.entries);
      const budget = Math.min(this.maxBytes, await estimateBudget(bytes));
      if (
        index.budget === budget &&
        bytes <= budget &&
        oldCount === index.entries.length
      )
        return;
      index.budget = budget;
      await this.evict(cache, index);
      await cache.put(
        this.origin + this.policy.prefix + "index",
        Response.json(index),
      );
    });
  }

  async reconcile(cache, index, keep) {
    const indexURL = this.origin + this.policy.prefix + "index";
    const actual = new Set((await cache.keys()).map((request) => request.url));
    index.entries = index.entries.filter((entry) => actual.has(entry.key));
    const known = new Set(index.entries.map((entry) => entry.key));
    for (const url of actual)
      if (url !== keep && url !== indexURL && !known.has(url))
        await cache.delete(url);
  }

  async put(path, version, variant, value, signal) {
    const { prefix, maxBody } = this.policy;
    if (this.disabled) return;
    if (!this.policy.allowsResponse(value.headers, variant))
      return this.delete(path, version, variant);
    const size = value.bytes.byteLength;
    if (size > Math.min(maxBody, this.maxBytes)) return;
    const key = await this.key(path, version, variant);
    if (!key) return;
    await this.run(async (cache, index) => {
      signal?.throwIfAborted();
      if (size > this.budget(index)) return;
      const headers = new Headers();
      for (const field of this.policy.headers)
        if (value.headers.has(field))
          headers.set(field, value.headers.get(field));
      index.entries = index.entries.filter((entry) => entry.key !== key);
      // The larger video bucket reconciles once at player open, rather than
      // enumerating up to thousands of Cache API keys for each range write.
      if (!this.policy.adaptive) await this.reconcile(cache, index, key);
      const save = async () => {
        await this.evict(cache, index, size, 1);
        signal?.throwIfAborted();
        await cache.put(key, new Response(value.bytes, { headers }));
        index.entries.push({ key, size, touched: value.time ?? Date.now() });
        await cache.put(this.origin + prefix + "index", Response.json(index));
      };
      try {
        await save();
      } catch (error) {
        if (!this.policy.adaptive || error?.name !== "QuotaExceededError")
          throw error;
        // A quota estimate can be optimistic. Reclaim actual cached bytes
        // under the same lock, so every open player sees the reduced budget.
        await cache.delete(key);
        index.entries = index.entries.filter((entry) => entry.key !== key);
        index.budget = Math.floor(
          Math.min(this.budget(index), storedBytes(index.entries) + size) / 2,
        );
        if (size <= index.budget) {
          try {
            await save();
            return;
          } catch (retryError) {
            if (retryError?.name !== "QuotaExceededError") throw retryError;
            await cache.delete(key);
            index.entries = index.entries.filter((entry) => entry.key !== key);
          }
        }
        await this.evict(cache, index);
        await cache.put(this.origin + prefix + "index", Response.json(index));
      }
    });
  }

  async delete(path, version, variant) {
    if (this.disabled) return;
    const key = await this.key(path, version, variant);
    if (!key) return;
    await this.run(async (cache, index) => {
      await cache.delete(key);
      index.entries = index.entries.filter((entry) => entry.key !== key);
      await cache.put(
        this.origin + this.policy.prefix + "index",
        Response.json(index),
      );
    });
  }
}

export async function clearPersistentCaches(
  policies,
  {
    storage = cacheStorage(),
    locks = globalThis.navigator?.locks,
    origin = globalThis.location?.origin,
  } = {},
) {
  if (!storage || !locks?.request || !origin) return;
  await Promise.allSettled(
    policies.map(async ({ name, prefix }) =>
      locks.request(name, async () => {
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
      }),
    ),
  );
}

export function publicFileKey(path, { root, origin }, publicRoot) {
  const url = new URL(path, origin);
  return (
    path.startsWith(publicRoot) &&
    path.startsWith(root) &&
    !path.endsWith("/") &&
    url.pathname === path &&
    !/%2f|%5c/i.test(path)
  );
}
