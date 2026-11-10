import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { selectPaths } from "../lib/selection.js";

const empty = () => ({ paths: new Set(), anchor: null, mode: null });
const holdDelay = 450;
const moveTolerance = 10;

export function useFileSelection(
  entries,
  scope,
  onTouchSelection,
  onCopyLinks,
) {
  const [state, setState] = useState(empty);
  const list = useRef(null);
  const owner = useRef(Symbol("file-selection"));
  const press = useRef(null);
  const suppressed = useRef(null);
  const lastFocus = useRef(null);
  const lastPointer = useRef(null);
  const order = useMemo(() => entries.map((item) => item.path), [entries]);
  const items = useMemo(
    () => entries.filter((item) => state.paths.has(item.path)),
    [entries, state.paths],
  );
  const cancelPress = useCallback(() => {
    clearTimeout(press.current?.timer);
    press.current = null;
  }, []);
  const focus = (path, scroll = false) => {
    const node = [...(list.current?.querySelectorAll(".file-open") || [])].find(
      (button) => button.dataset.path === path,
    );
    (node || list.current)?.focus({ preventScroll: true });
    if (scroll) node?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const clear = (restore = true) => {
    cancelPress();
    setState(empty());
    if (restore) focus(lastFocus.current);
  };
  useLayoutEffect(() => {
    cancelPress();
    suppressed.current = null;
    setState(empty());
  }, [scope, cancelPress]);
  useLayoutEffect(() => {
    const valid = new Set(order);
    setState((current) => {
      const paths = new Set(
        [...current.paths].filter((path) => valid.has(path)),
      );
      if (paths.size === current.paths.size) return current;
      return paths.size
        ? {
            ...current,
            paths,
            anchor: valid.has(current.anchor) ? current.anchor : null,
          }
        : empty();
    });
    cancelPress();
  }, [order, cancelPress]);
  useLayoutEffect(() => {
    onTouchSelection?.(owner.current, state.mode === "touch");
    return () => onTouchSelection?.(owner.current, false);
  }, [onTouchSelection, state.mode === "touch"]);
  useEffect(() => {
    const down = (event) => {
      if (press.current && event.pointerId !== press.current.pointerId)
        cancelPress();
    };
    const move = (event) => {
      const current = press.current;
      if (
        current &&
        (event.pointerId !== current.pointerId ||
          Math.hypot(event.clientX - current.x, event.clientY - current.y) >
            moveTolerance)
      )
        cancelPress();
    };
    const visibility = () => {
      if (document.hidden) cancelPress();
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", cancelPress);
    window.addEventListener("pointercancel", cancelPress);
    window.addEventListener("scroll", cancelPress, {
      capture: true,
      passive: true,
    });
    window.addEventListener("blur", cancelPress);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelPress();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", cancelPress);
      window.removeEventListener("pointercancel", cancelPress);
      window.removeEventListener("scroll", cancelPress, true);
      window.removeEventListener("blur", cancelPress);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [cancelPress]);
  const select = (path, options) => {
    lastFocus.current = path;
    setState((current) => selectPaths(current, order, path, options));
  };
  const selectAll = () =>
    setState((current) => ({
      paths: new Set(order),
      anchor: current.anchor || order[0],
      mode: current.mode || "desktop",
    }));
  const keyDown = (event) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.target.closest("input,textarea,select,[contenteditable='true']")
    )
      return;
    if (event.key === "Escape" && state.mode) {
      event.preventDefault();
      event.stopPropagation();
      clear();
      return;
    }
    const button = event.target.closest(".file-open");
    if (!button || !list.current?.contains(button)) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
    } else if (modifier && event.key.toLowerCase() === "c" && items.length) {
      event.preventDefault();
      onCopyLinks?.(items);
    } else if (event.key === " ") {
      event.preventDefault();
      if (event.repeat) return;
      select(button.dataset.path, {
        toggle: true,
        range: event.shiftKey,
        mode: state.mode || "desktop",
      });
    } else if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      event.preventDefault();
      const index = order.indexOf(button.dataset.path);
      let end =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? order.length - 1
            : Math.max(
                0,
                Math.min(
                  order.length - 1,
                  index +
                    (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1),
                ),
              );
      if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        const rect = button.getBoundingClientRect();
        const direction = event.key === "ArrowUp" ? -1 : 1;
        const candidates = [...list.current.querySelectorAll(".file-open")]
          .map((node) => ({ node, rect: node.getBoundingClientRect() }))
          .filter((item) => (item.rect.top - rect.top) * direction > 1)
          .sort(
            (a, b) =>
              Math.abs(a.rect.top - rect.top) -
                Math.abs(b.rect.top - rect.top) ||
              Math.abs(a.rect.left - rect.left) -
                Math.abs(b.rect.left - rect.left),
          );
        end = candidates.length
          ? order.indexOf(candidates[0].node.dataset.path)
          : index;
      }
      if (!modifier || event.shiftKey)
        select(order[end], {
          range: event.shiftKey,
          toggle: modifier,
          mode: state.mode || "desktop",
        });
      lastFocus.current = order[end];
      focus(order[end], true);
    }
  };
  return {
    list,
    items,
    mode: state.mode,
    touch: state.mode === "touch",
    isSelected: (item) => state.paths.has(item.path),
    clear,
    selectAll,
    keyDown,
    deselectAll: () =>
      setState((current) => ({
        ...empty(),
        mode: current.mode === "touch" ? "touch" : null,
      })),
    props(item, open) {
      return {
        onPointerDown(event) {
          cancelPress();
          suppressed.current = null;
          lastFocus.current = item.path;
          lastPointer.current = { path: item.path, type: event.pointerType };
          if (
            !["touch", "pen"].includes(event.pointerType) ||
            event.isPrimary === false ||
            event.button > 0 ||
            state.mode === "touch"
          )
            return;
          const node = event.currentTarget;
          const current = {
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
          };
          current.timer = setTimeout(() => {
            if (press.current !== current || !node.isConnected) return;
            suppressed.current = item.path;
            select(item.path, { mode: "touch" });
            node.focus({ preventScroll: true });
          }, holdDelay);
          press.current = current;
        },
        onClick(event) {
          if (suppressed.current === item.path) {
            suppressed.current = null;
            event.preventDefault();
            return;
          }
          cancelPress();
          // Older mobile browsers expose click as MouseEvent, after touch
          // PointerEvents. Keep the gesture's input type for that release click.
          const pointerType =
            event.pointerType ||
            (lastPointer.current?.path === item.path
              ? lastPointer.current.type
              : undefined);
          const touch = ["touch", "pen"].includes(pointerType);
          if (state.mode === "touch")
            select(item.path, { toggle: true, mode: "touch" });
          else if (!touch && (event.ctrlKey || event.metaKey || event.shiftKey))
            select(item.path, {
              toggle: event.ctrlKey || event.metaKey,
              range: event.shiftKey,
            });
          else if (touch || event.detail === 0) {
            clear(false);
            open(item);
          } else if (event.detail === 1) select(item.path);
        },
        onDblClick(event) {
          if (
            state.mode === "touch" ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return;
          clear(false);
          open(item);
        },
        onContextMenu(event) {
          if (press.current || state.mode === "touch") event.preventDefault();
        },
        onDragStart: (event) => event.preventDefault(),
      };
    },
  };
}
