import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useReducedMotion } from "../../../hooks/useMediaQuery.js";
import { t } from "../../../../shared/i18n.js";
import {
  previewImage,
  canViewOriginal,
  decodeImage,
  originalImage,
} from "../../../lib/image-preview.js";
import { Icon } from "../../../components/Icon.jsx";
import { afterOverlayEntry } from "../../../lib/overlay-entry.js";
import { VideoPreview } from "../preview/VideoPreview.jsx";
import { LivePhoto } from "../preview/LivePhoto.jsx";
import { AlbumIndicator } from "./AlbumIndicator.jsx";
import { moveAlbumImage } from "./album-thumbnail-transition.jsx";

export function AlbumMedia({
  attrs,
  scale,
  fitted,
  item,
  thumbnail,
  returningToTile,
  videoThumbnail,
  indicator,
  thumbnailLayer,
  indicatorLayer,
  onThumbnailSettled,
  client,
  active,
  open,
  entered,
  signal,
  onSize,
  live,
  liveRequested,
  onLiveStop,
  onVideoPlayer,
}) {
  const root = useRef(null);
  const touchStart = useRef(null);
  touchStart.current = attrs.onTouchStart;
  const previewSlot = useRef(null);
  const thumbnailImage = useRef(null);
  const lifted = !!thumbnailLayer;
  const reducedMotion = useReducedMotion();
  const [low, setLow] = useState(thumbnail || null);
  const [high, setHigh] = useState(null);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState("");
  const [upgrading, setUpgrading] = useState(false);
  const [originalResult, setOriginalResult] = useState(null);
  const canUpgrade =
    active &&
    canViewOriginal(item) &&
    high &&
    !high.original &&
    high.sourceSide > high.previewSide;
  const needsOriginal =
    canUpgrade &&
    open &&
    entered &&
    scale > 1.05 &&
    Math.max(fitted.width, fitted.height) * scale * devicePixelRatio >
      high.previewSide;

  useEffect(() => {
    if (!active || (!needsOriginal && originalResult?.error))
      setUpgrading(false);
    else if (needsOriginal) setUpgrading(true);
  }, [active, needsOriginal, originalResult?.error]);

  // Keep the decoded original after zooming back out, and release it on paging.
  const useOriginal = !!canUpgrade && upgrading;
  const original = useOriginal ? originalResult : null;
  useEffect(() => {
    setOriginalResult(null);
    if (!useOriginal) return;
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal]);
    let url;
    (async () => {
      const { blob } = await originalImage(client, item, combined);
      combined.throwIfAborted();
      url = URL.createObjectURL(blob);
      const size = await decodeImage(url, combined);
      combined.throwIfAborted();
      onSize(item.path, size.width, size.height);
      setOriginalResult({ url });
    })().catch(() => {
      if (url) URL.revokeObjectURL(url);
      url = undefined;
      if (!combined.aborted) setOriginalResult({ error: true });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, item, useOriginal, signal, onSize]);

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
      const size = await decodeImage(url, combined);
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
        setSettled(false);
      }
      return;
    }
    setSettled(false);
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal]);
    let url;
    setError("");
    (async () => {
      const cached = client.images?.peek(item, 1600);
      const image = cached || (await previewImage(client, item, combined));
      combined.throwIfAborted();
      url = URL.createObjectURL(image.blob);
      const size = await decodeImage(url, combined);
      combined.throwIfAborted();
      onSize(item.path, image.width || size.width, image.height || size.height);
      setHigh({
        node: size.image,
        cached: !!cached,
        original: image.original === true,
        sourceSide: Math.max(
          image.width || size.width,
          image.height || size.height,
        ),
        previewSide: Math.max(size.width, size.height),
      });
    })().catch(() => {
      if (!combined.aborted) setError(t("library.imagePreviewFailed"));
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [active, item, client, signal, onSize]);

  useLayoutEffect(() => () => high?.node.remove(), [high]);

  useLayoutEffect(() => {
    if (!high) return;
    const { node } = high;
    node.className = `album-image-high${high.cached ? " is-cached" : ""}${settled ? " is-sharp" : ""}`;
    node.alt = active && settled && !original?.url ? item.name : "";
    node.draggable = false;
    // Fade the decoded image in beside the original thumbnail, under one crop
    // and transform, then move that same image into the viewer.
    moveAlbumImage(node, thumbnailLayer || previewSlot.current);
  }, [high, thumbnailLayer, settled, active, original?.url, item.name]);

  useLayoutEffect(() => {
    if (!open || !high) return;
    if ((high.cached && !lifted) || reducedMotion) {
      setSettled(true);
      return;
    }
    return afterOverlayEntry(high.node, () => setSettled(true));
  }, [open, high, lifted, reducedMotion]);

  useLayoutEffect(() => {
    if (!open || !lifted || !high || !settled || !entered) return;
    const media = root.current;
    // PhotoSlider animates the transform and crop on separate elements.
    return afterOverlayEntry(media.parentElement, () => {
      moveAlbumImage(high.node, previewSlot.current);
      onThumbnailSettled();
    });
  }, [open, lifted, settled, entered, high, onThumbnailSettled]);

  useLayoutEffect(() => {
    if (open || !returningToTile || !high) return;
    if (!lifted && (settled || !thumbnailImage.current?.naturalWidth)) return;
    // Reverse an interrupted sharpening fade from the opacity already on screen.
    const opacity = Number(getComputedStyle(high.node).opacity);
    const fade = high.node.animate([{ opacity }, { opacity: 0 }], {
      duration: 180,
      easing: "ease-out",
      fill: "both",
    });
    return () => fade.cancel();
  }, [open, returningToTile, lifted, high, settled]);

  useLayoutEffect(() => {
    if (!open || !active || item.kind !== "image") return;
    const media = root.current;
    const slide = media.closest(".PhotoView__PhotoWrap");
    const portal = slide?.parentElement;
    if (!portal) return;
    const startFromMargin = (event) => {
      if (
        event.touches.length === 1 &&
        slide.contains(event.target) &&
        !media.contains(event.target)
      )
        touchStart.current?.(event);
    };
    // Letterboxing and the opening crop can leave parts of the slide outside
    // the image's hit area. Start the same drag before PhotoSlider sees a mask press.
    portal.addEventListener("touchstart", startFromMargin, true);
    return () =>
      portal.removeEventListener("touchstart", startFromMargin, true);
  }, [open, active, item.kind]);

  const mediaWidth = indicator ? parseFloat(attrs.style.width) : 0;
  const showIndicator =
    indicator &&
    (indicatorLayer ||
      (attrs.style.opacity === 1 &&
        (!open ||
          attrs.style.transition ||
          Math.abs(mediaWidth * scale - indicator.width) < 1)));
  const movingIndicator = showIndicator && (
    <AlbumIndicator
      kind={indicator.kind}
      tile={indicator.tile}
      scale={
        indicatorLayer
          ? `calc(var(--album-thumbnail-width) / ${indicator.width})`
          : mediaWidth / indicator.width
      }
      phase={
        open ? (attrs.style.transition ? "opening" : "waiting") : "closing"
      }
    />
  );

  return (
    <div
      {...attrs}
      {...(item.kind === "video" && {
        // Give the gallery single-finger swipes without starting a video pinch.
        onMouseDown: undefined,
        onTouchStart: (event) => {
          if (event.touches.length === 1) attrs.onTouchStart?.(event);
          else event.stopPropagation();
        },
        onTouchMove: (event) => {
          if (event.touches.length > 1) event.stopPropagation();
        },
        onWheel: undefined,
      })}
      ref={root}
      className={`album-media${item.kind === "video" && active ? " album-media-video" : ""} ${attrs.className || ""}`}
      data-media-path={item.path}
      data-current={active ? "true" : "false"}
      data-returning-to-tile={returningToTile ? "" : undefined}
      aria-hidden={!active}
    >
      {low && !lifted && (!settled || item.kind === "image") && (
        <img
          key="low"
          ref={thumbnailImage}
          class={`album-image-low${settled ? " is-behind-preview" : ""}`}
          src={low}
          alt={active && !settled ? item.name : ""}
          draggable={false}
          onError={() => setLow(null)}
        />
      )}
      {item.kind === "image" && (
        <span ref={previewSlot} class="album-image-preview" />
      )}
      {original?.url && (
        <img
          class="album-image-original"
          src={original.url}
          alt={item.name}
          draggable={false}
        />
      )}
      {original?.error && (
        <p class="album-image-error" role="status">
          {t("library.originalPreviewFailed")}
        </p>
      )}
      {!lifted &&
        !low &&
        !high &&
        !original?.url &&
        (item.kind === "image" || !active) && (
          <div
            class="album-media-placeholder"
            role={active ? "status" : undefined}
          >
            <Icon name={item.kind} />
            {active && <p>{error || t("library.loadingPreview")}</p>}
          </div>
        )}
      {error &&
        (low || lifted) &&
        !original?.url &&
        !original?.error &&
        item.kind === "image" && (
          <p class="album-image-error" role="status">
            {error}
          </p>
        )}
      {item.kind === "video" && active && (
        <div
          class="album-video-player"
          data-closing={!open && !reducedMotion ? "" : undefined}
        >
          <VideoPreview
            item={item}
            client={client}
            open={open}
            playOnRequest
            retainOnClose={!reducedMotion}
            closingThumbnail={videoThumbnail}
            onPlayer={onVideoPlayer}
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
      {indicatorLayer && movingIndicator
        ? createPortal(movingIndicator, indicatorLayer)
        : movingIndicator}
    </div>
  );
}
