import { createPortal } from "preact/compat";
import { useLayoutEffect, useState } from "preact/hooks";
import { Icon } from "../../../components/Icon.jsx";
import {
  createAlbumIndicatorLayer,
  positionAlbumOrigin,
} from "./album-thumbnail-transition.jsx";
// Redrawn for LanternDock from the Apple Live Photos design reference.
// Reference artwork © Apple Inc.
// https://developer.apple.com/design/human-interface-guidelines/live-photos
import livePhotoBadge from "./live-photo-badge.svg";

export function AlbumIndicator({ kind, tile, phase }) {
  useLayoutEffect(() => {
    if (!tile) return;
    tile.setAttribute("data-moving-indicator", "");
    return () => tile.removeAttribute("data-moving-indicator");
  }, [tile]);

  return (
    <span
      class={`album-indicator album-${kind}-indicator`}
      data-motion={phase}
      style={{
        backgroundImage:
          kind === "live" ? `url("${livePhotoBadge}")` : undefined,
      }}
      aria-hidden="true"
    >
      {kind === "video" && <Icon name="play" />}
    </span>
  );
}

export function MovingAlbumIndicator({ media, thumbnailLayer, ...indicator }) {
  const [viewerLayer, setViewerLayer] = useState(null);
  useLayoutEffect(() => {
    if (thumbnailLayer) return;
    const node = media.current;
    const viewer = node.closest(".PhotoView-Portal");
    const layer = createAlbumIndicatorLayer();
    viewer.append(layer);
    setViewerLayer(layer);
    let frame;
    // Sample the rendered rect so the badge follows the animation in screen pixels.
    const follow = () => {
      positionAlbumOrigin(layer, node.getBoundingClientRect());
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => {
      cancelAnimationFrame(frame);
      layer.remove();
    };
  }, [media, thumbnailLayer]);
  const layer = thumbnailLayer || viewerLayer;
  return layer && createPortal(<AlbumIndicator {...indicator} />, layer);
}
