import { t } from "../../shared/i18n.js";
import { checkFileResponse, limitedBytes } from "./dav.js";
import { isMissingFileStatus } from "./errors.js";
import { originalImageLimit } from "./image-cache.js";
import { ImageServiceError } from "./images.js";
export const canViewOriginal = (item) =>
  item.kind === "image" && !(item.size > originalImageLimit);

// Previews render locally owned blobs and keep NAS credentials in the client.
export async function previewImage(client, item, signal) {
  try {
    const image = await client.images?.image(item, 1600, signal);
    if (image) return image;
  } catch (error) {
    if (
      !(error instanceof ImageServiceError) ||
      !isMissingFileStatus(error.status)
    )
      throw error;
    // The preview route can be missing even when the original exists. Verify
    // the source through DAV so confirmed misses also clear the recent entry.
    const source = await client.read(item.path, signal, {}, "HEAD");
    signal?.throwIfAborted();
    checkFileResponse(source);
    await source.body?.cancel();
  }
  return originalImage(client, item, signal);
}

export async function originalImage(client, item, signal) {
  if (!canViewOriginal(item)) throw new Error(t("library.previewTooLarge"));
  const cached = await client.readOriginal?.(item, signal);
  if (cached) return { original: true, blob: cached };
  const response = await client.get(item.path, signal);
  const mime = response.headers.get("Content-Type")?.split(";")[0];
  if (mime && !mime.startsWith("image/")) {
    await response.body?.cancel();
    throw new Error(t("library.imageResponseInvalid"));
  }
  return {
    original: true,
    blob: new Blob([await limitedBytes(response, originalImageLimit, signal)], {
      type: mime || "image/*",
    }),
  };
}

export async function decodeImage(url, signal) {
  signal.throwIfAborted();
  const image = new Image();
  const abort = () => {
    image.src = "";
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    return { image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
