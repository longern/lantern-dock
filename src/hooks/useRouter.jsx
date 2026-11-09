import { createContext } from "preact";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { parseRoute, safeReturnPath } from "../../shared/routes.js";
const Context = createContext(null);
export const navigationEvent = "lantern-dock:navigate";
const snapshot = () => ({
  route: parseRoute(location.href),
  state: history.state?.lanternDockRoute || {},
});
export function RouterProvider({ children }) {
  const [value, setValue] = useState(() => ({ ...snapshot(), initial: true }));
  const pendingPop = useRef(null);
  const commit = useCallback((href, { replace = false, state = {} } = {}) => {
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin)
      throw new Error("External navigation denied");
    const next = url.pathname + url.search + url.hash;
    if (
      next !== location.pathname + location.search + location.hash ||
      replace
    ) {
      history[replace ? "replaceState" : "pushState"](
        { lanternDockRoute: state },
        "",
        next,
      );
      window.dispatchEvent(new Event(navigationEvent));
    }
  }, []);
  const navigate = useCallback(
    (href, options = {}) => {
      // Back is asynchronous; a preview opened during its close must survive it.
      if (pendingPop.current) {
        pendingPop.current.next = { href, options };
        return;
      }
      commit(href, options);
    },
    [commit],
  );
  useEffect(() => {
    const changed = (event) => {
      if (event?.type === "popstate" && pendingPop.current) {
        const pending = pendingPop.current;
        pendingPop.current = null;
        if (pending.next) {
          commit(pending.next.href, {
            ...pending.next.options,
            replace: false,
          });
          return;
        }
      }
      setValue({ ...snapshot(), initial: !event });
    };
    const link = (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = event.target.closest?.("a[href]");
      if (
        !anchor ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self") ||
        anchor.relList.contains("external")
      )
        return;
      const url = new URL(anchor.href);
      if (
        url.origin !== location.origin ||
        parseRoute(url.href).page === "not-found"
      )
        return;
      event.preventDefault();
      navigate(url.pathname + url.search + url.hash);
    };
    window.addEventListener("popstate", changed);
    window.addEventListener(navigationEvent, changed);
    window.addEventListener("hashchange", changed);
    document.addEventListener("click", link);
    changed();
    return () => {
      window.removeEventListener("popstate", changed);
      window.removeEventListener(navigationEvent, changed);
      window.removeEventListener("hashchange", changed);
      document.removeEventListener("click", link);
    };
  }, [navigate, commit]);
  const close = useCallback(
    (field, fallback) => {
      const from = history.state?.lanternDockRoute?.[field];
      if (pendingPop.current) return;
      if (from && safeReturnPath(from, "") === from) {
        pendingPop.current = { from };
        history.back();
      } else navigate(fallback, { replace: true });
    },
    [navigate],
  );
  const context = useMemo(
    () => ({ ...value, navigate, close }),
    [value, navigate, close],
  );
  return <Context.Provider value={context}>{children}</Context.Provider>;
}
export function useRouter() {
  const value = useContext(Context);
  if (!value) throw new Error("RouterProvider is required");
  return value;
}
