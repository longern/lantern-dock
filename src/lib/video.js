import { t } from "../../shared/i18n.js";
import { coreError } from "./errors.js";
import { normalizePath, withinRoot } from "./dav.js";
import { authorization } from "./transport.js";

export const unsupportedVideo = t("core.error.VIDEO_UNSUPPORTED");
export async function createVideoSource(client, item, signal) {
  signal?.throwIfAborted();
  const path = normalizePath(item.path);
  if (!withinRoot(path, client.root)) throw coreError("OUTSIDE_ROOT");
  const transport = client.transport;
  if (
    transport?.config.transport === "http" &&
    !authorization(transport.credentials)
  ) {
    const url = new URL(path, transport.config.endpoint);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw coreError("VIDEO_HTTPS_REQUIRED");
    return {
      mode: "direct",
      attach(video) {
        video.crossOrigin = "anonymous";
        video.src = url.href;
      },
      dispose() {},
    };
  }
  if (
    !/\.(mp4|m4v|mov)$/i.test(item.name) ||
    !globalThis.MediaSource ||
    !client.read
  )
    throw coreError("VIDEO_UNSUPPORTED");
  // Load the parser only when a video needs page-local fragmentation.
  const { MP4MediaSource } = await import("./video-mp4.js");
  signal?.throwIfAborted();
  return new MP4MediaSource(client, { ...item, path }, signal);
}
