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
const clickHandoff = 1000;
const isTouchPointer = (type) => type === "touch" || type === "pen";

export function useFileSelection(
  entries,
  scope,
  onTouchSelection,
  onCopyLinks,
  onContextMenu,
  { openOnClick = false } = {},
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
    lastPointer.current = null;
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
      lastPointer.current = null;
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
    const end = (event) => {
      const pointer = lastPointer.current;
      if (pointer?.id === event.pointerId) {
        if (event.type === "pointercancel") lastPointer.current = null;
        else pointer.releasedAt = event.timeStamp;
      }
      cancelPress();
    };
    const blur = () => {
      lastPointer.current = null;
      cancelPress();
    };
    const visibility = () => {
      if (document.hidden) blur();
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("scroll", cancelPress, {
      capture: true,
      passive: true,
    });
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelPress();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("scroll", cancelPress, true);
      window.removeEventListener("blur", blur);
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
  const contextMenu = (event, item, keyboard = false) => {
    if (!item) return;
    const pointer = lastPointer.current;
    if (
      !keyboard &&
      (press.current ||
        isTouchPointer(
          (pointer?.path === item.path && pointer.type) || event.pointerType,
        ))
    ) {
      event.preventDefault();
      return;
    }
    if (!onContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    cancelPress();
    if (!state.paths.has(item.path) || state.mode !== "desktop")
      select(item.path, { mode: "desktop" });
    const target = event.target.closest(".file-open");
    const rect = target.getBoundingClientRect();
    onContextMenu({
      item,
      target,
      keyboard: keyboard || (!event.clientX && !event.clientY),
      point:
        keyboard || (!event.clientX && !event.clientY)
          ? { x: rect.left + 16, y: rect.bottom }
          : { x: event.clientX, y: event.clientY },
    });
  };
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
    if (
      (event.shiftKey && event.key === "F10") ||
      event.key === "ContextMenu"
    ) {
      contextMenu(
        event,
        entries.find((item) => item.path === button.dataset.path),
        true,
      );
      return;
    }
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
          lastPointer.current = {
            path: item.path,
            id: event.pointerId,
            type: event.pointerType,
          };
          if (
            !isTouchPointer(event.pointerType) ||
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
          }, holdDelay);
          press.current = current;
        },
        onClick(event) {
          const pointer = lastPointer.current;
          lastPointer.current = null;
          if (suppressed.current === item.path) {
            suppressed.current = null;
            event.preventDefault();
            return;
          }
          cancelPress();
          // Safari can report a touch-generated click as a mouse click.
          const sinceRelease = event.timeStamp - pointer?.releasedAt;
          const matchingGesture =
            event.detail !== 0 &&
            pointer?.path === item.path &&
            sinceRelease >= 0 &&
            sinceRelease <= clickHandoff;
          const touch = isTouchPointer(
            matchingGesture ? pointer.type : event.pointerType,
          );
          if (state.mode === "touch")
            select(item.path, { toggle: true, mode: "touch" });
          else if (!touch && (event.ctrlKey || event.metaKey || event.shiftKey))
            select(item.path, {
              toggle: event.ctrlKey || event.metaKey,
              range: event.shiftKey,
            });
          else if (openOnClick || touch || event.detail === 0) {
            clear(false);
            open(item);
          } else if (event.detail === 1) select(item.path);
        },
        onDblClick(event) {
          if (
            openOnClick ||
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
          contextMenu(event, item);
        },
        onDragStart: (event) => event.preventDefault(),
      };
    },
  };
}
