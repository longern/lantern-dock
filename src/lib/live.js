import { backendPaths } from "../../shared/backend-paths.js";
import { normalizePath, withinRoot } from "./dav.js";
import { limitedBytes } from "./content.js";
import { imageIdentifier } from "./images.js";
import { createVideoSource } from "./video.js";
import { cachePolicy } from "./cache.js";

const resource =
  /^\/api\/media\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\/video\.mp4$/;
const directory = (path) => path.slice(0, path.lastIndexOf("/") + 1);
const photo = (item) =>
  item.kind === "image" && /\.(jpe?g|heic|heif)$/i.test(item.path);
export function liveDescriptor(value, root) {
  try {
    if (
      !value ||
      !["apple", "motion-photo"].includes(value.kind) ||
      typeof value.image !== "string" ||
      !resource.test(value.video) ||
      !Number.isSafeInteger(value.length) ||
      value.length < 16 ||
      !Number.isFinite(value.posterTime) ||
      value.posterTime < 0
    )
      return null;
    const image = normalizePath(value.image);
    if (
      !withinRoot(image, root) ||
      !withinRoot(image, backendPaths.files) ||
      !/\.(jpe?g|heic|heif)$/i.test(image)
    )
      return null;
    const pairedVideo = value.pairedVideo
      ? normalizePath(value.pairedVideo)
      : "";
    if (
      value.kind === "apple" &&
      (!pairedVideo ||
        !withinRoot(pairedVideo, root) ||
        directory(image) !== directory(pairedVideo) ||
        !/\.(mov|mp4|m4v)$/i.test(pairedVideo))
    )
      return null;
    if (value.kind === "motion-photo" && pairedVideo) return null;
    const imageID = imageIdentifier(
      decodeURIComponent(image.slice(backendPaths.files.length)),
    );
    const videoID = imageIdentifier(
      decodeURIComponent(
        (pairedVideo || image).slice(backendPaths.files.length),
      ),
    );
    if (!value.video.startsWith(`${backendPaths.media}/${imageID}/${videoID}/`))
      return null;
    return {
      image,
      video: value.video,
      pairedVideo,
      kind: value.kind,
      length: value.length,
      posterTime: value.posterTime,
    };
  } catch {
    return null;
  }
}

// Discovery is optional. Plain WebDAV stays usable without any metadata service.
export async function fetchLiveMedia(client, entries, signal) {
  const result = new Map();
  if (!client?.images || !entries.some(photo)) return result;
  await client.images.service();
  signal.throwIfAborted();
  if (client.images.mediaService !== backendPaths.media) return result;
  const directories = new Map();
  for (const item of entries) {
    if (!photo(item) || !withinRoot(item.path, backendPaths.files)) continue;
    const dir = directory(item.path);
    if (!directories.has(dir)) directories.set(dir, []);
    directories
      .get(dir)
      .push(`${item.path}:${item.etag || `${item.modified}:${item.size}`}`);
  }
  for (const [dir, versions] of directories) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(versions.sort().join("\0")),
    );
    const key = `${dir}\0${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const cached = client.images.liveIndexes.get(key);
    let values =
      cached && Date.now() - cached.time < cached.value.freshFor
        ? cached.value.items
        : null;
    if (!values) {
      const relative =
        decodeURIComponent(
          dir.slice(backendPaths.files.length).replace(/\/$/, ""),
        ) || ".";
      const base = `${backendPaths.media}/${imageIdentifier(relative)}/index.json`;
      let offset = 0,
        revision;
      for (let page = 0; page < 158; page++) {
        const path = offset
          ? `${base}?offset=${offset}&revision=${revision}`
          : base;
        const response = await client.transport.request(path, {
          signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Live metadata unavailable");
        }
        const value = JSON.parse(
          new TextDecoder().decode(
            await limitedBytes(response, 2 * 1024 * 1024, signal),
          ),
        );
        if (
          value.version !== 1 ||
          !/^[a-f0-9]{64}$/.test(value.revision) ||
          (revision && revision !== value.revision) ||
          !Array.isArray(value.items) ||
          value.items.length > 10000
        )
          throw new Error("Invalid live index");
        revision = value.revision;
        if (value.nextOffset === null) {
          values = value.items
            .map((entry) => liveDescriptor(entry, client.root))
            .filter((entry) => entry && directory(entry.image) === dir);
          const policy = cachePolicy(response.headers);
          if (policy.storable)
            client.images.liveIndexes.set(
              key,
              { items: values, freshFor: policy.freshFor },
              key.length * 2 + JSON.stringify(values).length * 2,
            );
          break;
        }
        if (
          !Number.isInteger(value.nextOffset) ||
          value.nextOffset !== offset + 64 ||
          value.nextOffset > 10000
        )
          throw new Error("Invalid live page");
        offset = value.nextOffset;
      }
      if (!values) throw new Error("Incomplete live index");
    }
    // Apply only the final index: a later page can reveal duplicate Apple IDs.
    for (const value of values) result.set(value.image, value);
  }
  return result;
}

export function albumLiveItems(entries, metadata) {
  const images = new Set(
    entries.filter((item) => item.kind === "image").map((item) => item.path),
  );
  const paired = new Set(
    [...metadata.values()]
      .filter((live) => images.has(live.image))
      .map((live) => live.pairedVideo)
      .filter(Boolean),
  );
  return entries
    .filter((item) => !paired.has(item.path))
    .map((item) =>
      metadata.has(item.path)
        ? { ...item, live: metadata.get(item.path) }
        : item,
    );
}

export function createLiveVideoSource(client, live, signal) {
  if (!liveDescriptor(live, client.root))
    throw new Error("Invalid live resource");
  // The DAV client's file-root boundary remains unchanged. This adapter permits
  // exactly one validated media resource, including its bounded Range requests.
  const adapter = {
    root: backendPaths.media + "/",
    transport: client.transport,
    read(path, requestSignal, headers = {}, method = "GET") {
      if (path !== live.video || !["GET", "HEAD"].includes(method))
        throw new Error("Invalid live request");
      return client.transport.request(path, {
        signal: requestSignal,
        headers,
        method,
      });
    },
  };
  return createVideoSource(
    adapter,
    { path: live.video, name: "motion.mp4", size: live.length },
    signal,
  );
}
