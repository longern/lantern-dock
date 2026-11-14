import { useLayoutEffect, useRef } from "preact/hooks";

const onImageRemoved = new WeakMap();

// Own the image outside Preact's child reconciliation so it can temporarily
// leave its slot while the grid continues to render.
export function AlbumThumbnailImage({ src, alt, decoding, onLoad, onError }) {
  const slot = useRef(null);
  const callbacks = useRef(null);
  callbacks.current = { onLoad, onError };
  useLayoutEffect(() => {
    const image = new Image();
    image.alt = alt;
    image.decoding = decoding;
    image.draggable = false;
    image.onload = (event) => callbacks.current.onLoad?.(event);
    image.onerror = (event) => callbacks.current.onError?.(event);
    image.src = src;
    slot.current.append(image);
    return () => {
      onImageRemoved.get(image)?.();
      image.remove();
    };
  }, [src, alt, decoding]);
  return <span ref={slot} class="album-thumbnail-image" />;
}

export function moveAlbumImage(image, container) {
  if (image.parentElement === container) return;
  if (container.moveBefore && image.isConnected && container.isConnected)
    container.moveBefore(image, null);
  else container.append(image);
}

export function positionAlbumOrigin(origin, rect) {
  origin.style.left = `${rect.left}px`;
  origin.style.top = `${rect.top}px`;
  origin.style.width = `${rect.width}px`;
  origin.style.height = `${rect.height}px`;
}

export function createAlbumIndicatorLayer() {
  const layer = document.createElement("div");
  layer.className = "album-thumbnail-transition-indicators";
  return layer;
}

export function visibleAlbumOrigin(tile) {
  const rect = tile?.getBoundingClientRect();
  if (
    !rect?.width ||
    !rect.height ||
    rect.bottom <= 0 ||
    rect.top >= innerHeight
  )
    return null;
  return tile.querySelector("img") || tile;
}

export function revealAlbumTile(tile) {
  let rect = tile?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return;
  const dialog = tile.closest(".album-page-dialog");
  const header = dialog?.querySelector(".page-dialog-header");
  const top = header?.getBoundingClientRect().bottom ?? 0;
  if (rect.top < top || rect.bottom > innerHeight) {
    tile.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant",
    });
    rect = tile.getBoundingClientRect();
  }
  if (rect.width && rect.height && rect.bottom > top && rect.top < innerHeight)
    return rect;
}

export function liftAlbumThumbnail(image, findViewer, onRemove) {
  const layer = document.createElement("div");
  if (typeof layer.showPopover !== "function") return;
  const slot = image.parentElement;
  const start = image.getBoundingClientRect();
  if (!start.width || !start.height) return;
  const { naturalWidth, naturalHeight } = image;
  const sourceRatio = naturalWidth / naturalHeight;
  const startRatio = start.width / start.height;
  const endScale = Math.min(
    innerWidth / naturalWidth,
    innerHeight / naturalHeight,
  );
  const widthChange = naturalWidth * endScale - start.width;
  const heightChange = naturalHeight * endScale - start.height;
  const picture = document.createElement("div");
  const indicatorLayer = createAlbumIndicatorLayer();
  const position = (rect, clipX = 0, clipY = 0) => {
    const scale = Math.max(
      rect.width / naturalWidth,
      rect.height / naturalHeight,
    );
    const x = Math.max(0, (naturalWidth - rect.width / scale) / 2);
    const y = Math.max(0, (naturalHeight - rect.height / scale) / 2);
    picture.style.clipPath = `inset(${y + clipY / scale}px ${x + clipX / scale}px)`;
    picture.style.transform = `translate(${rect.left - x * scale}px, ${rect.top - y * scale}px) scale(${scale})`;
    // Anchor the badge to the visible crop as it opens up around the photo.
    positionAlbumOrigin(indicatorLayer, {
      left: rect.left + clipX,
      top: rect.top + clipY,
      width: rect.width - 2 * clipX,
      height: rect.height - 2 * clipY,
    });
  };
  picture.style.width = `${naturalWidth}px`;
  picture.style.height = `${naturalHeight}px`;
  position(start);
  layer.className = "album-thumbnail-transition";
  layer.setAttribute("popover", "manual");
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  const backdrop = document.createElement("div");
  backdrop.className = "album-thumbnail-transition-mask";
  // PhotoSlider measures the origin again on exit. Keep an image-shaped anchor
  // available even if navigation temporarily hides the grid during dismissal.
  const origin = new Image();
  origin.alt = "";
  origin.className = "album-thumbnail-transition-origin";
  positionAlbumOrigin(origin, start);
  picture.className = "album-thumbnail-transition-picture";
  layer.append(backdrop, picture, indicatorLayer, origin);
  document.body.append(layer);
  try {
    layer.showPopover();
  } catch {
    layer.remove();
    return;
  }
  moveAlbumImage(image, picture);
  let frame;
  let previous = start;
  let mask;
  let media;
  // Both resolutions are painted inside picture and share this transform and crop.
  // Follow the dialog's gesture and backdrop while the layer is visible.
  const follow = () => {
    const viewer = findViewer();
    media ||= viewer?.querySelector('.album-media[data-current="true"]');
    mask ||= viewer?.querySelector(".PhotoView-Slider__Backdrop");
    if (mask) {
      const style = getComputedStyle(mask);
      if (backdrop.style.backgroundColor !== style.backgroundColor)
        backdrop.style.backgroundColor = style.backgroundColor;
      if (backdrop.style.opacity !== style.opacity)
        backdrop.style.opacity = style.opacity;
    }
    if (media && media.style.opacity !== "0") {
      const rect = media.getBoundingClientRect();
      if (
        rect.height &&
        (rect.x !== previous.x ||
          rect.y !== previous.y ||
          rect.width !== previous.width ||
          rect.height !== previous.height)
      ) {
        const progress = Math.min(
          1,
          Math.max(
            0,
            Math.abs(widthChange) >= Math.abs(heightChange)
              ? (rect.width - start.width) / (widthChange || 1)
              : (rect.height - start.height) / heightChange,
          ),
        );
        const ratio = startRatio + (sourceRatio - startRatio) * progress;
        const clipX = Math.max(0, (rect.width - rect.height * ratio) / 2);
        const clipY = Math.max(0, (rect.height - rect.width / ratio) / 2);
        media.style.clipPath = `inset(${(clipY / rect.height) * 100}% ${(clipX / rect.width) * 100}%)`;
        position(rect, clipX, clipY);
        previous = rect;
      }
    }
    frame = requestAnimationFrame(follow);
  };
  frame = requestAnimationFrame(follow);
  const release = () => {
    onImageRemoved.delete(image);
    cancelAnimationFrame(frame);
    if (media) media.style.removeProperty("clip-path");
    if (image.parentElement === picture && slot.isConnected)
      moveAlbumImage(image, slot);
    layer.remove();
  };
  onImageRemoved.set(image, onRemove);
  const originRef = {
    get current() {
      const rect = slot.getBoundingClientRect();
      if (rect.width && rect.height) positionAlbumOrigin(origin, rect);
      return origin;
    },
  };
  return {
    picture,
    indicatorLayer,
    release,
    originRef,
    width: naturalWidth,
    height: naturalHeight,
  };
}
