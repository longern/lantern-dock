import { t } from "../../shared/i18n.js";
import { MemoryCache, cachePolicy } from "./cache.js";
import { limitedBytes } from "./content.js";
import { backendPaths } from "../../shared/backend-paths.js";

const freshness = 15000;
export class ImageServiceError extends Error {
  constructor(status) {
    super(
      status === 404 ? t("core.imageRemoved") : t("core.imagePreviewFailed"),
    );
    this.status = status;
  }
}
export function imageIdentifier(relative) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(relative)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function iiifSize(info, side) {
  if (
    info?.type !== "ImageService3" ||
    info.protocol !== "http://iiif.io/api/image" ||
    !["level0", "level1", "level2"].includes(info.profile) ||
    !Number.isSafeInteger(info.width) ||
    !Number.isSafeInteger(info.height) ||
    info.width <= 0 ||
    info.height <= 0 ||
    info.width * info.height > 64000000 ||
    !Array.isArray(info.sizes) ||
    !info.sizes.length ||
    info.sizes.length > 32
  )
    throw new ImageServiceError(415);
  const sizes = info.sizes
    .filter(
      (s) =>
        Number.isSafeInteger(s.width) &&
        Number.isSafeInteger(s.height) &&
        s.width > 0 &&
        s.height > 0 &&
        s.width <= info.width &&
        s.height <= info.height &&
        s.width <= 1600 &&
        s.height <= 1600,
    )
    .sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
  if (!sizes.length) throw new ImageServiceError(415);
  return sizes.find((s) => Math.max(s.width, s.height) >= side) || sizes.at(-1);
}

export class ImageClient {
  constructor(transport) {
    this.transport = transport;
    this.responses = new MemoryCache(16 * 1024 * 1024, 512);
    this.previews = new MemoryCache(16 * 1024 * 1024, 256);
    this.failed = new MemoryCache(16384, 128);
    this.liveIndexes = new MemoryCache(2 * 1024 * 1024, 32);
    this.lifetime = new AbortController();
    this.capabilities = null;
    this.queue = [];
    this.active = 0;
    this.revision = 0;
  }
  dispose() {
    this.lifetime.abort();
    for (const job of this.queue.splice(0)) job.cancel();
    this.responses.clear();
    this.previews.clear();
    this.failed.clear();
    this.liveIndexes.clear();
  }
  expire() {
    this.revision++;
    this.responses.expire();
    this.previews.expire();
    this.failed.clear();
    this.liveIndexes.clear();
  }
  run(work, signal) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let job;
      const abort = () => {
        controller.abort(signal?.reason || this.lifetime.signal.reason);
        const position = this.queue.indexOf(job);
        if (position >= 0) {
          this.queue.splice(position, 1);
          job.cancel();
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.lifetime.signal.addEventListener("abort", abort, { once: true });
      const clean = () => {
        signal?.removeEventListener("abort", abort);
        this.lifetime.signal.removeEventListener("abort", abort);
      };
      if (signal?.aborted || this.lifetime.signal.aborted) abort();
      job = {
        cancel: () => {
          controller.abort();
          clean();
          reject(new DOMException(t("core.cancelled"), "AbortError"));
        },
        start: async () => {
          try {
            controller.signal.throwIfAborted();
            resolve(await work(controller.signal));
          } catch (err) {
            reject(err);
          } finally {
            clean();
            this.active--;
            this.pump();
          }
        },
        signal: controller.signal,
      };
      this.queue.push(job);
      this.pump();
    });
  }
  pump() {
    while (this.active < 3 && this.queue.length) {
      const job = this.queue.shift();
      if (job.signal.aborted) {
        job.cancel();
        continue;
      }
      this.active++;
      void job.start();
    }
  }
  async service() {
    if (!this.capabilities)
      this.capabilities = (async () => {
        try {
          const response = await this.transport.request(
            backendPaths.capabilities,
            {
              headers: { Accept: "application/json" },
              signal: this.lifetime.signal,
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            return null;
          }
          const value = JSON.parse(
            new TextDecoder().decode(
              await limitedBytes(response, 8192, this.lifetime.signal),
            ),
          );
          const service = value.version === 1 && value.services?.images;
          const media = value.version === 1 && value.services?.media;
          if (
            media?.enabled &&
            media.protocol === "lantern-dock-media" &&
            media.version === 1 &&
            media.href === backendPaths.media
          )
            this.mediaService = media.href;
          if (
            !service?.enabled ||
            service.protocol !== "http://iiif.io/api/image" ||
            service.version !== 3 ||
            typeof service.href !== "string" ||
            !/^\/(?!\/)[a-zA-Z0-9_/-]+$/.test(service.href) ||
            service.href
              .split("/")
              .some((part) => part === "." || part === "..")
          )
            return null;
          return service.href.replace(/\/$/, "");
        } catch {
          return null;
        }
      })();
    return this.capabilities;
  }
  async read(path, version, signal, limit, accept) {
    signal?.throwIfAborted();
    const key = path + "\0" + version;
    const cached = this.responses.get(key);
    if (cached && Date.now() - cached.time < cached.value.freshFor)
      return cached.value;
    const headers = { Accept: accept };
    if (cached?.value.etag) headers["If-None-Match"] = cached.value.etag;
    const response = await this.transport.request(path, { headers, signal });
    if (response.status === 304 && cached) {
      await response.body?.cancel();
      const headers = new Headers(cached.value.headers);
      for (const name of ["Cache-Control", "Age", "ETag"]) {
        if (response.headers.has(name))
          headers.set(name, response.headers.get(name));
      }
      const value = {
        ...cached.value,
        headers,
        etag: headers.get("ETag"),
        ...cachePolicy(headers),
      };
      if (value.storable) this.responses.set(key, value, cached.weight);
      else this.responses.delete(key);
      return value;
    }
    if (!response.ok) {
      this.responses.delete(key);
      await response.body?.cancel();
      throw new ImageServiceError(response.status);
    }
    const bytes = await limitedBytes(response, limit, signal);
    const value = {
      bytes,
      type: response.headers.get("Content-Type") || "",
      etag: response.headers.get("ETag"),
      headers: new Headers(response.headers),
      ...cachePolicy(response.headers),
    };
    if (value.storable) this.responses.set(key, value, bytes.byteLength);
    else this.responses.delete(key);
    return value;
  }
  async image(item, side, signal) {
    signal?.throwIfAborted();
    if (!item.path.startsWith(backendPaths.files)) return null;
    const version = item.etag || `${item.modified}:${item.size}`;
    const key = `${item.path}\0${version}\0${side}`;
    const cached = this.previews.get(key);
    if (cached && Date.now() - cached.time < cached.value.freshFor)
      return cached.value;
    const failed = this.failed.get(key);
    if (failed && Date.now() - failed.time < freshness) return null;
    return this.run(async (signal) => {
      const service = await this.service();
      signal.throwIfAborted();
      if (!service) return null;
      const relative = decodeURIComponent(
        item.path.slice(backendPaths.files.length),
      );
      const base = service + "/" + imageIdentifier(relative);
      try {
        const metadata = await this.read(
          base + "/info.json",
          version,
          signal,
          16384,
          "application/ld+json",
        );
        const info = JSON.parse(new TextDecoder().decode(metadata.bytes));
        // Never follow an origin or URL supplied by a metadata document.
        const id = new URL(info.id);
        if (
          !["http:", "https:"].includes(id.protocol) ||
          id.pathname !== base ||
          id.search ||
          id.hash ||
          id.username ||
          id.password
        )
          throw new ImageServiceError(415);
        const size = iiifSize(info, side);
        const response = await this.read(
          `${base}/full/${size.width},${size.height}/0/default.jpg`,
          version,
          signal,
          8 * 1024 * 1024,
          "image/jpeg",
        );
        if (response.type.split(";")[0] !== "image/jpeg")
          throw new ImageServiceError(415);
        const result = {
          blob: new Blob([response.bytes], { type: "image/jpeg" }),
          width: info.width,
          height: info.height,
          freshFor: Math.min(response.freshFor, metadata.freshFor),
        };
        if (response.storable && metadata.storable)
          this.previews.set(key, result, result.blob.size);
        else this.previews.delete(key);
        return result;
      } catch (err) {
        this.previews.delete(key);
        if ([400, 413, 415].includes(err.status)) {
          this.failed.set(key, true, key.length * 2);
          return null;
        }
        throw err;
      }
    }, signal);
  }
  peek(item, side) {
    const version = item.etag || `${item.modified}:${item.size}`;
    const entry = this.previews.get(`${item.path}\0${version}\0${side}`);
    return entry && Date.now() - entry.time < freshness ? entry.value : null;
  }
}
