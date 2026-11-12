import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../../../shared/i18n.js";
import { Icon } from "../../../components/Icon.jsx";
import { useReducedMotion } from "../../../hooks/useMediaQuery.js";
import { decodeImage, previewImage } from "../../../lib/image-preview.js";

export function PreviewImage({
  item,
  client,
  thumbnail,
  onDimensions,
  onError,
}) {
  const reducedMotion = useReducedMotion();
  const [low, setLow] = useState(null);
  const [high, setHigh] = useState(null);
  const [faded, setFaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const reportError = useRef(onError);
  reportError.current = onError;

  useLayoutEffect(() => {
    const image =
      thumbnail ||
      client.images?.peek(item, 384) ||
      client.images?.peek(item, 128);
    if (!image) {
      setLow(null);
      return;
    }
    // The listing can unmount as soon as navigation updates its route.
    const url = URL.createObjectURL(image.blob);
    setLow({ url, width: image.width, height: image.height });
    onDimensions(`${image.width} × ${image.height}`);
    return () => URL.revokeObjectURL(url);
  }, [client, item, thumbnail, onDimensions]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let url;
    setHigh(null);
    setFailed(false);
    setFaded(false);
    (async () => {
      const cached = client.images?.peek(item, 1600);
      const image = await previewImage(client, item, signal);
      signal.throwIfAborted();
      url = URL.createObjectURL(image.blob);
      const size = await decodeImage(url, signal);
      const width = image.width || size.width;
      const height = image.height || size.height;
      setHigh({ url, width, height, cached: image === cached });
      onDimensions(`${width} × ${height}`);
    })().catch((error) => {
      if (url) URL.revokeObjectURL(url);
      url = undefined;
      if (signal.aborted) return;
      setFailed(true);
      reportError.current(error.message || t("library.imagePreviewFailed"));
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, item, client.images?.revision, onDimensions]);

  const image = high || low;
  if (!image)
    return (
      <div class="preview-placeholder">
        <Icon name="image" />
        <p role="status">
          {t(failed ? "library.filePreviewFailed" : "library.loadingPreview")}
        </p>
      </div>
    );

  const fade = low && high && !high.cached && !reducedMotion;
  const showLow = low && (!high || (fade && !faded));
  return (
    <div
      class="preview-image"
      style={{
        "--preview-image-width": `${image.width}px`,
        "--preview-image-ratio": image.width / image.height,
      }}
    >
      {showLow && (
        <img
          key="thumbnail"
          src={low.url}
          alt={high ? "" : item.name}
          onError={() => setLow(null)}
        />
      )}
      {high && (
        <img
          key="preview"
          class={fade ? "preview-image-sharp" : undefined}
          src={high.url}
          alt={item.name}
          onAnimationEnd={() => setFaded(true)}
        />
      )}
    </div>
  );
}
