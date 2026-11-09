import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { Icon } from "./Icon.jsx";
import { afterOverlayEntry } from "../lib/overlay-entry.js";
import { captureListingMenuMotion, getListingMenuPlacement } from "../lib/listing-menu.js";

export function ListingOptionsMenu({ sort, view, onSortChange, onViewChange, edge = false }) {
  const id = useId();
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const surface = useRef(null);
  const initialFocus = useRef(0);
  const [state, setState] = useState({ phase: "closed" });
  const currentState = useRef(state);
  const open = state.phase === "open";
  const present = state.phase !== "closed";
  const transition = (phase) => {
    // The identity also invalidates completion callbacks before Preact commits
    // a rapid close/reopen, including two changes within the same event turn.
    const next = { phase };
    currentState.current = next;
    setState(next);
    return next;
  };
  const setInteractive = (interactive) => {
    const popup = menu.current;
    if (!popup) return;
    popup.toggleAttribute("inert", !interactive);
    if (interactive) popup.removeAttribute("aria-hidden");
    else popup.setAttribute("aria-hidden", "true");
    // Also protect browsers without inert, and programmatic activation during
    // the closing frame before the next render has disabled these controls.
    popup.querySelectorAll('[role="menuitemradio"]').forEach((item) => { item.disabled = !interactive; });
  };
  const close = (restoreFocus = true, immediately = false) => {
    if (currentState.current.phase === "closed" || (!immediately && currentState.current.phase !== "open")) return;
    captureListingMenuMotion(surface.current);
    transition(immediately ? "closed" : "closing");
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    else if (menu.current?.contains(document.activeElement)) document.activeElement.blur();
    setInteractive(false);
  };
  const openMenu = (index = 0) => {
    const dialog = trigger.current?.closest("dialog");
    if (dialog && (!dialog.open || dialog.dataset.state === "closed")) return;
    initialFocus.current = index;
    if (currentState.current.phase === "closing") captureListingMenuMotion(surface.current);
    transition("open");
    setInteractive(true);
  };

  useLayoutEffect(() => {
    if (!present) return;
    const popup = menu.current;
    const panel = surface.current;
    const dialog = popup.closest("dialog");
    // A manual popover stays in this DOM/focus scope but paints in the top
    // layer. Keep it there until exit finishes, rather than hiding on close.
    let topLayer = false;
    if (typeof popup.showPopover === "function") {
      try {
        popup.showPopover();
        topLayer = true;
      } catch {
        // A partial Popover implementation must not leave the fallback hidden.
        popup.removeAttribute("popover");
      }
    } else popup.removeAttribute("popover");
    const position = () => {
      const anchor = trigger.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const area = {
        left: viewport?.offsetLeft || 0,
        top: viewport?.offsetTop || 0,
        width: viewport?.width || document.documentElement.clientWidth,
        height: viewport?.height || window.innerHeight,
      };
      popup.style.maxWidth = `${Math.max(0, area.width - 16)}px`;
      popup.style.maxHeight = `${Math.max(0, area.height - 16)}px`;
      // Only the inner surface animates. Measuring this shell never feeds the
      // current grow/shrink scale back into its placement or transform origin.
      popup.style.left = "0px";
      popup.style.top = "0px";
      const bounds = popup.getBoundingClientRect();
      const placed = getListingMenuPlacement(anchor, bounds, area);
      const scaleX = bounds.width / popup.offsetWidth || 1;
      const scaleY = bounds.height / popup.offsetHeight || 1;
      // Without Popover, account for a translated/scrolled/scaled containing
      // dialog as well as the viewport offset.
      popup.style.left = `${(placed.left - bounds.left) / scaleX}px`;
      popup.style.top = `${(placed.top - bounds.top) / scaleY}px`;
      panel.style.transformOrigin = `${placed.originX / scaleX}px ${placed.originY / scaleY}px`;
      popup.dataset.placement = placed.placement;
    };
    position();
    let frame;
    const trackDialog = () => {
      position();
      if (dialog && (typeof dialog.getAnimations !== "function" || dialog.getAnimations().some((animation) =>
        animation.playState === "running" || animation.playState === "paused"))) {
        frame = requestAnimationFrame(trackDialog);
      }
    };
    const followDialog = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(trackDialog);
    };
    followDialog();
    // Exit with the owner, but remove immediately if its native dialog closes.
    // A detached/closed owner must never leave a separate top-layer popup.
    const dialogState = dialog && new MutationObserver(() => {
      if (!dialog.open) close(false, true);
      else if (dialog.dataset.state === "closed") close(false);
      followDialog();
    });
    dialogState?.observe(dialog, { attributes: true, attributeFilter: ["open", "data-state"] });
    const ownerClosed = () => close(false, true);
    dialog?.addEventListener("close", ownerClosed);
    dialog?.addEventListener("animationstart", followDialog);
    const outsidePointer = (event) => {
      if (!root.current.contains(event.target)) close(false);
    };
    const outsideFocus = (event) => {
      if (!root.current.contains(event.target)) close(false);
    };
    const onScroll = (event) => {
      if (!popup.contains(event.target)) position();
    };
    document.addEventListener("pointerdown", outsidePointer, true);
    document.addEventListener("focusin", outsideFocus);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      cancelAnimationFrame(frame);
      dialogState?.disconnect();
      dialog?.removeEventListener("close", ownerClosed);
      dialog?.removeEventListener("animationstart", followDialog);
      if (topLayer && popup.isConnected) {
        try { popup.hidePopover(); } catch { /* Already closed by its owner. */ }
      }
      document.removeEventListener("pointerdown", outsidePointer, true);
      document.removeEventListener("focusin", outsideFocus);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [present]);

  useLayoutEffect(() => {
    if (state.phase === "open") {
      const items = menu.current.querySelectorAll('[role="menuitemradio"]');
      items[initialFocus.current < 0 ? items.length - 1 : initialFocus.current]?.focus({ preventScroll: true });
    } else if (state.phase === "closing") {
      // Use the actual CSS animation, including cancellation/reduced motion,
      // and the existing computed-duration fallback for older engines.
      return afterOverlayEntry(surface.current, () => {
        if (currentState.current === state) transition("closed");
      });
    }
  }, [state]);

  const onKeyDown = (event) => {
    if (currentState.current.phase !== "open") return;
    if (event.key === "Escape") {
      // Prevent the containing native dialog from also handling Escape.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      // All menu items are outside the tab order. Continue from the trigger,
      // allowing a containing dialog's normal focus trap to handle the edge.
      close();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const items = [...menu.current.querySelectorAll('[role="menuitemradio"]')];
      const current = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  };
  const groups = [
    { key: "sort", label: t("library.sort"), selected: sort, change: onSortChange,
      options: [["name", t("library.name")], ["modified", t("library.modifiedAt")], ["size", t("library.size")]] },
    { key: "view", label: t("library.viewMode"), selected: view, change: onViewChange,
      options: [["list", t("library.listView")], ["grid", t("library.gridView")]] },
  ];
  return (
    <div class="listing-options" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        class={`icon-button listing-options-trigger${edge === "start" || edge === "end" ? ` edge-${edge}` : ""}`}
        aria-label={t("library.listingOptions")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => currentState.current.phase === "open" ? close() : openMenu()}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            openMenu(event.key === "ArrowUp" ? -1 : 0);
          }
        }}
      >
        <Icon name="ellipsis" />
      </button>
      {present && (
        <div
          ref={menu}
          id={id}
          popover="manual"
          class="listing-options-menu"
          role="menu"
          aria-label={t("library.listingOptions")}
          data-state={open ? "open" : "closed"}
          aria-hidden={open ? undefined : "true"}
          inert={!open}
        >
          <div ref={surface} class="listing-options-surface">
            {groups.map((group) => (
              <div key={group.key} role="group" aria-labelledby={`${id}-${group.key}`}>
                <div class="listing-options-label" id={`${id}-${group.key}`}>{group.label}</div>
                {group.options.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    tabIndex={-1}
                    disabled={!open}
                    aria-checked={group.selected === value}
                    data-option={value}
                    onClick={() => {
                      if (currentState.current.phase !== "open") return;
                      group.change(value);
                      close();
                    }}
                  >
                    {group.key === "view" && <Icon name={value} />}
                    <span>{label}</span>
                    <Icon name="check" class="listing-options-check" />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
