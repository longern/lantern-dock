import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { albumImage, decodeAlbumImage } from "../lib/album-media.js";
import { Icon } from "./Icon.jsx";
import { VideoPreview } from "./VideoPreview.jsx";
import { LivePhoto } from "./LivePhoto.jsx";

// PhotoSlider owns the transform/crop and gestures. These two image layers share
// its exact geometry, so sharpening cannot move or stretch the photograph.
export function AlbumMedia({
  attrs,
  item,
  thumbnail,
  client,
  active,
  open,
  entered,
  signal,
  onSize,
  live,
  liveRequested,
  onLiveStop,
}) {
  const root = useRef(null);
  const [low, setLow] = useState(thumbnail || null);
  const [high, setHigh] = useState(null);
  const [shown, setShown] = useState(false);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal]);
    let url;
    (async () => {
      let image = client.images?.peek(item, 384);
      // Clone a displayed no-store thumbnail into a viewer-owned Blob URL. Never
      // revoke the URL owned by Thumbnail, or fetch an arbitrary remote URL here.
      if (!image && /^(blob:|data:image\/)/.test(thumbnail || ""))
        image = {
          blob: await (await fetch(thumbnail, { signal: combined })).blob(),
        };
      image ||= await client.images?.image(item, 384, combined);
      if (!image) return;
      combined.throwIfAborted();
      url = URL.createObjectURL(image.blob);
      const size = await decodeAlbumImage(url, combined);
      combined.throwIfAborted();
      setLow(url);
      onSize(item.path, image.width || size.width, image.height || size.height);
    })().catch(() => {});
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [item, client, thumbnail, signal, onSize]);

  useEffect(() => {
    if (!active || item.kind !== "image") {
      if (open) {
        setHigh(null);
        setShown(false);
        setSettled(false);
      }
      return;
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal]);
    let url;
    setError("");
    (async () => {
      const cached = client.images?.peek(item, 1600);
      const image = cached || (await albumImage(client, item, combined));
      combined.throwIfAborted();
      url = URL.createObjectURL(image.blob);
      const size = await decodeAlbumImage(url, combined);
      combined.throwIfAborted();
      onSize(item.path, image.width || size.width, image.height || size.height);
      setHigh({ url, cached: !!cached });
    })().catch(() => {
      if (!combined.aborted) setError(t("library.imagePreviewFailed"));
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [active, item, client, signal, onSize]);

  useEffect(() => {
    setShown(false);
    setSettled(false);
    if (!high || (!entered && !high.cached)) return;
    let frame, next, timer;
    frame = requestAnimationFrame(() => {
      next = requestAnimationFrame(() => {
        setShown(true);
        // Animated images retain their base until the actual transition ends.
        if (
          high.cached ||
          matchMedia("(prefers-reduced-motion: reduce)").matches
        )
          timer = setTimeout(() => setSettled(true), 0);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(next);
      clearTimeout(timer);
    };
  }, [high, entered]);

  // Keep native video controls out of the gallery's drag and wheel handlers.
  const nativeControl = (event) => {
    // A swipe across the picture still pages on touch devices. Reserve the
    // bottom native-controls strip for scrubbing, volume and play/pause.
    if (event.type === "touchstart" && event.touches.length === 1 && event.touches[0].clientY < event.currentTarget.getBoundingClientRect().bottom - 64) return;
    event.stopPropagation();
  };
  return (
    <div
      {...attrs}
      ref={root}
      className={`album-media ${attrs.className || ""}`}
      data-media-path={item.path}
      data-current={active ? "true" : "false"}
      aria-hidden={!active}
    >
      {low && !settled && (
        <img
          key="low"
          class="album-image-low"
          src={low}
          alt={active ? item.name : ""}
          draggable={false}
          onError={() => setLow(null)}
        />
      )}
      {high && (
        <img
          key="high"
          class={`album-image-high${shown ? " is-sharp" : ""}${high.cached ? " is-cached" : ""}`}
          src={high.url}
          alt={active && settled ? item.name : ""}
          draggable={false}
          onTransitionEnd={(event) => {
            if (event.propertyName === "opacity" && shown) setSettled(true);
          }}
        />
      )}
      {!low && !high && (item.kind === "image" || !active) && (
        <div
          class="album-media-placeholder"
          role={active ? "status" : undefined}
        >
          <Icon name={item.kind} />
          {active && <p>{error || t("library.loadingPreview")}</p>}
        </div>
      )}
      {error && low && item.kind === "image" && (
        <p class="album-image-error" role="status">
          {error}
        </p>
      )}
      {item.kind === "video" && active && (
        <div
          class="album-video-player"
          onMouseDown={nativeControl}
          onTouchStart={nativeControl}
          onWheel={nativeControl}
        >
          <VideoPreview
            item={item}
            client={client}
            open={open}
            onError={setError}
            onDimensions={(width, height) => onSize(item.path, width, height)}
          />
        </div>
      )}
      {live && active && open && (
        <LivePhoto
          key={live.video}
          client={client}
          live={live}
          requested={liveRequested}
          onStop={onLiveStop}
          target={root}
        />
      )}
    </div>
  );
}
