import { useLayoutEffect } from "preact/hooks";
import { Icon } from "../../../components/Icon.jsx";
// Redrawn for LanternDock from the Apple Live Photos design reference.
// Reference artwork © Apple Inc.
// https://developer.apple.com/design/human-interface-guidelines/live-photos
import livePhotoBadge from "./live-photo-badge.svg";

export function AlbumIndicator({ kind, tile, scale, phase }) {
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
        "--album-indicator-scale": scale,
        backgroundImage:
          kind === "live" ? `url("${livePhotoBadge}")` : undefined,
      }}
      aria-hidden="true"
    >
      {kind === "video" && <Icon name="play" />}
    </span>
  );
}
