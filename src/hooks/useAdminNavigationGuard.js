import { useLayoutEffect } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { parseRoute } from "../../shared/routes.js";

export function useAdminNavigationGuard(working) {
  useLayoutEffect(() => {
    if (!working) return;
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
        url.origin === location.origin &&
        parseRoute(url.href).page === "admin" &&
        !window.confirm(t("library.leaveForAdmin"))
      )
        event.preventDefault();
    };
    const leave = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    // Account overlays live outside the library tree. Capture before the router
    // handles their anchors, and leave modified/new-tab clicks to the browser.
    document.addEventListener("click", link, true);
    window.addEventListener("beforeunload", leave);
    return () => {
      document.removeEventListener("click", link, true);
      window.removeEventListener("beforeunload", leave);
    };
  }, [working]);
}
