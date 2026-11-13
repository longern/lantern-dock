import { mediaQueries } from "../lib/breakpoints.js";
import { useLayoutEffect, useRef } from "preact/hooks";
import { afterOverlayEntry } from "../lib/overlay-entry.js";
import { restoreOverlayFocus } from "../lib/overlay-focus.js";

// Keep the native modal (focus containment, inert background and backdrop) open
// through its exit animation. All dismiss paths use the same controlled state.
export function Dialog({
  open,
  modal = true,
  animateEntry = true,
  onClose,
  onBeforeOpen,
  onEntered,
  onExited,
  fallbackFocus,
  returnTarget,
  onKeyDown,
  children,
  ...props
}) {
  const element = useRef(null);
  const outsidePress = useRef(false);
  const returnFocus = useRef(null);
  const callbacks = useRef(null);
  callbacks.current = {
    open,
    animateEntry,
    onClose,
    onBeforeOpen,
    onEntered,
    onExited,
    fallbackFocus,
    returnTarget,
  };
  useLayoutEffect(() => {
    const node = element.current;
    if (open) {
      if (node.open && node.matches(":modal") !== modal) node.close();
      if (!node.open) {
        // Latch the entry mode per opening: later navigation inside a direct
        // link must not start an animation on an already visible page.
        node.dataset.entry = callbacks.current.animateEntry
          ? "animated"
          : "instant";
        returnFocus.current ||= document.activeElement;
        callbacks.current.onBeforeOpen?.(node);
        modal ? node.showModal() : node.show();
      }
      if (callbacks.current.onEntered) {
        return afterOverlayEntry(node, () => {
          if (callbacks.current.open) callbacks.current.onEntered?.();
        });
      }
      return;
    }
    if (!node.open) return;
    const value = getComputedStyle(node)
      .getPropertyValue("--motion-exit")
      .trim();
    const parsed = parseFloat(value);
    const duration = matchMedia(mediaQueries.reducedMotion).matches
      ? 0
      : Number.isFinite(parsed)
        ? parsed * (value.endsWith("ms") ? 1 : 1000)
        : 180;
    const timer = setTimeout(
      () => {
        if (callbacks.current.open) return;
        const active = document.activeElement;
        const restoreFocus =
          modal || node.contains(active) || active === document.body;
        node.close();
        const trigger = returnFocus.current;
        returnFocus.current = null;
        const { onExited, fallbackFocus, returnTarget } = callbacks.current;
        onExited?.();
        if (restoreFocus)
          restoreOverlayFocus(trigger, fallbackFocus, returnTarget);
      },
      duration ? duration + 20 : 0,
    );
    return () => clearTimeout(timer);
  }, [open, modal]);
  useLayoutEffect(() => {
    const node = element.current;
    return () => node.close();
  }, []);
  const outside = (event) => {
    const node = element.current;
    const rect = node.getBoundingClientRect();
    return (
      event.target === node &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    );
  };
  return (
    <dialog
      {...props}
      ref={element}
      data-state={open ? "open" : "closed"}
      onCancel={(event) => {
        event.preventDefault();
        callbacks.current.onClose?.();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          modal &&
          event.key === "Tab" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          const node = element.current;
          const targets = [
            ...node.querySelectorAll(
              "a[href], button, input, select, textarea, summary, [tabindex]",
            ),
          ].filter(
            (target) =>
              target.closest("dialog") === node &&
              target.tabIndex >= 0 &&
              !target.matches(":disabled") &&
              target.getClientRects().length &&
              getComputedStyle(target).visibility !== "hidden" &&
              !target.closest("[inert]"),
          );
          const first = targets[0],
            last = targets.at(-1);
          if (
            !first ||
            (event.shiftKey && document.activeElement === first) ||
            (!event.shiftKey && document.activeElement === last)
          ) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }
        if (event.key === "Escape" && !modal) {
          event.preventDefault();
          event.stopPropagation();
          callbacks.current.onClose?.();
        }
      }}
      onPointerDown={(event) => {
        outsidePress.current = outside(event);
      }}
      onClick={(event) => {
        if (modal && outsidePress.current && outside(event))
          callbacks.current.onClose?.();
        outsidePress.current = false;
      }}
    >
      {children}
    </dialog>
  );
}
