import { normalizePath, withinRoot } from "./dav.js";
import { authorization } from "./transport.js";

export const unsupportedVideo =
  "浏览器不支持此视频的格式或编码，请下载后播放。";
export async function createVideoSource(client, item, signal) {
  signal?.throwIfAborted();
  const path = normalizePath(item.path);
  if (!withinRoot(path, client.root)) throw new Error("不能离开配置的根目录");
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
      throw new Error("视频直连需要 HTTPS 地址。");
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
    throw new Error(unsupportedVideo);
  // Load the parser only when a video needs page-local fragmentation.
  const { MP4MediaSource } = await import("./video-mp4.js");
  signal?.throwIfAborted();
  return new MP4MediaSource(client, { ...item, path }, signal);
}
