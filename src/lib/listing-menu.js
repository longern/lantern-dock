const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(value, maximum));

// All inputs are viewport coordinates. Derive the pivot after clamping, rather
// than assuming the popup always fits below and to the left of its trigger.
export function getListingMenuPlacement(anchor, bounds, viewport) {
  const margin = 8;
  const gap = 6;
  const left = clamp(anchor.right - bounds.width,
    viewport.left + margin, viewport.left + viewport.width - bounds.width - margin);
  const below = anchor.bottom + gap;
  const above = anchor.top - bounds.height - gap;
  const placement = below + bounds.height <= viewport.top + viewport.height - margin ? "bottom" : "top";
  const top = clamp(placement === "bottom" ? below : above,
    viewport.top + margin, viewport.top + viewport.height - bounds.height - margin);
  return {
    left,
    top,
    placement,
    originX: clamp((anchor.left + anchor.right) / 2 - left, 0, bounds.width),
    originY: clamp((placement === "bottom" ? anchor.bottom : anchor.top) - top, 0, bounds.height),
  };
}

// Preserve the displayed frame when an entry or exit is interrupted. CSS owns
// the animation, so reduced motion and engines without Web Animations work too.
export function captureListingMenuMotion(surface) {
  if (!surface) return;
  const style = getComputedStyle(surface);
  surface.style.setProperty("--menu-from-opacity", style.opacity);
  surface.style.setProperty("--menu-from-transform", style.transform);
}
