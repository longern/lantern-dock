import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { Icon } from "./Icon.jsx";

export function ListingOptionsMenu({ sort, view, onSortChange, onViewChange }) {
  const id = useId();
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const initialFocus = useRef(0);
  const [open, setOpen] = useState(false);
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  const openMenu = (index = 0) => {
    initialFocus.current = index;
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const popup = menu.current;
    const dialog = popup.closest("dialog");
    // A manual popover stays in this DOM/focus scope but paints in the top
    // layer, above the dialog's scrolling and animated containing block.
    const topLayer = typeof popup.showPopover === "function";
    if (topLayer) popup.showPopover();
    const position = () => {
      const anchor = trigger.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      const width = viewport?.width || document.documentElement.clientWidth;
      const height = viewport?.height || window.innerHeight;
      const margin = 8;
      popup.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
      popup.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
      // Reset and measure the real fixed-position origin. In older browsers
      // without Popover, this also accounts for a translated/scrolled dialog.
      popup.style.left = "0px";
      popup.style.top = "0px";
      const bounds = popup.getBoundingClientRect();
      const below = anchor.bottom + 6;
      const above = anchor.top - bounds.height - 6;
      popup.style.left = `${Math.max(left + margin, Math.min(anchor.right - bounds.width, left + width - bounds.width - margin)) - bounds.left}px`;
      popup.style.top = `${Math.max(top + margin, Math.min(below + bounds.height <= top + height - margin ? below : above, top + height - bounds.height - margin)) - bounds.top}px`;
    };
    position();
    let frame;
    const trackEntry = () => {
      position();
      if (dialog?.getAnimations().some((animation) => animation.playState === "running")) {
        frame = requestAnimationFrame(trackEntry);
      }
    };
    frame = requestAnimationFrame(trackEntry);
    // A top-layer popover must not outlive the dialog that owns it.
    const dialogState = dialog && new MutationObserver(() => {
      if (!dialog.open || dialog.dataset.state === "closed") close(false);
    });
    dialogState?.observe(dialog, { attributes: true, attributeFilter: ["open", "data-state"] });
    const items = popup.querySelectorAll('[role="menuitemradio"]');
    items[initialFocus.current < 0 ? items.length - 1 : initialFocus.current]?.focus({ preventScroll: true });
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
      if (topLayer && popup.matches(":popover-open")) popup.hidePopover();
      document.removeEventListener("pointerdown", outsidePointer, true);
      document.removeEventListener("focusin", outsideFocus);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open]);

  const onKeyDown = (event) => {
    if (!open) return;
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
        class="icon-button listing-options-trigger"
        aria-label={t("library.listingOptions")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => open ? close() : openMenu()}
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
      {open && (
        <div ref={menu} id={id} popover="manual" class="listing-options-menu" role="menu" aria-label={t("library.listingOptions")}>
          {groups.map((group) => (
            <div key={group.key} role="group" aria-labelledby={`${id}-${group.key}`}>
              <div class="listing-options-label" id={`${id}-${group.key}`}>{group.label}</div>
              {group.options.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={group.selected === value}
                  data-option={value}
                  onClick={() => { group.change(value); close(); }}
                >
                  {group.key === "view" && <Icon name={value} />}
                  <span>{label}</span>
                  <Icon name="check" class="listing-options-check" />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
