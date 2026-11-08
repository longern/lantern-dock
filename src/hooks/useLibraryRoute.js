import { useCallback, useEffect, useRef, useState } from "preact/hooks";

// Only the standalone surfaces need a URL. Folder/filter state continues to be
// owned by useLibrary, so opening a sheet does not reset the current directory.
export const libraryRoute = (hash) =>
  hash === "#/favorites" ? "favorites" : hash === "#/me" ? "me" : null;

export function useLibraryRoute() {
  const [route, setRoute] = useState(() => libraryRoute(location.hash));
  const dismissing = useRef(false);
  useEffect(() => {
    const changed = () => {
      dismissing.current = false;
      setRoute(libraryRoute(location.hash));
    };
    window.addEventListener("hashchange", changed);
    window.addEventListener("popstate", changed);
    return () => {
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("popstate", changed);
    };
  }, []);
  const navigate = useCallback((next, replace = false) => {
    dismissing.current = false;
    const hash = next ? `#/${next}` : "#/";
    if (location.hash !== hash) {
      const state = next === "favorites"
        ? { ...history.state, lanternDockFavoritesFrom: location.hash || "#/" }
        : { ...history.state, lanternDockFavoritesFrom: null };
      history[replace ? "replaceState" : "pushState"](state, "", hash);
    }
    setRoute(libraryRoute(hash));
  }, []);
  const closeFavorites = useCallback((mobile) => {
    if (dismissing.current || libraryRoute(location.hash) !== "favorites") return;
    dismissing.current = true;
    // Only go Back when this entry was pushed from the intended parent. A
    // direct link must not navigate away from the app or back to another site.
    const parent = history.state?.lanternDockFavoritesFrom;
    if (parent && (!mobile || parent === "#/me")) history.back();
    else navigate(mobile ? "me" : null, true);
  }, [navigate]);
  return { route, navigate, closeFavorites };
}
