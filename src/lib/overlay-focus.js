export const overlayFocusSelector = "[data-overlay-focus]";
export const overlayFocusTarget = { tabIndex: -1, "data-overlay-focus": "" };
export const dialogHeadingFocus = { ...overlayFocusTarget, autofocus: true };

export function restoreOverlayFocus(trigger, fallbackFocus, returnTarget) {
  const active = document.activeElement;
  // The route or collection may change when an exit completes.
  requestAnimationFrame(() => {
    if (
      document.activeElement !== active &&
      document.activeElement !== document.body
    )
      return;
    const modal = [...document.querySelectorAll("dialog:modal")].at(-1);
    const scope = modal || document;
    const candidates = [
      returnTarget?.(scope),
      trigger,
      ...(fallbackFocus ? scope.querySelectorAll(fallbackFocus) : []),
      modal?.querySelector(overlayFocusSelector),
    ];
    const target = candidates.find(
      (node) =>
        node &&
        node !== document.body &&
        node !== document.documentElement &&
        scope.contains(node) &&
        node.getClientRects().length &&
        getComputedStyle(node).visibility !== "hidden" &&
        !node.matches(":disabled") &&
        !node.closest("dialog:not([open]), [inert]"),
    );
    if (target !== document.activeElement)
      target?.focus({ preventScroll: true });
  });
}
