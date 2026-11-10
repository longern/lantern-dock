import { t } from "../../shared/i18n.js";
import { limitedBytes } from "./dav.js";
import { originalImageLimit } from "./image-cache.js";
export const canViewOriginal = (item) =>
  item.kind === "image" && !(item.size > originalImageLimit);

// The viewer never hands a NAS URL or credentials to the gallery library.
export async function albumImage(client, item, signal) {
  const image = await client.images?.image(item, 1600, signal);
  return image || originalImage(client, item, signal);
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

export async function decodeAlbumImage(url, signal) {
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
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function fitAlbumMedia(width, height, viewportWidth, viewportHeight) {
  const ratio = width > 0 && height > 0 ? width / height : 1;
  const fittedWidth = Math.min(viewportWidth, viewportHeight * ratio);
  return { width: fittedWidth, height: fittedWidth / ratio };
}
