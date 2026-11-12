import { useEffect, useRef } from "preact/hooks";
import { t } from "../../../../shared/i18n.js";

export function AlbumPaging({ library, hasPhotos }) {
  const marker = useRef(null);
  const {
    hasMore,
    loadingMore,
    loading,
    refreshing,
    pageError,
    requestError,
    indexState,
    partial,
    supported,
    refresh,
    loadMore,
  } = library;
  useEffect(() => {
    const node = marker.current;
    if (!node || !hasMore || loading || loadingMore || pageError) return;
    const load = () => {
      const dialog = [...document.querySelectorAll("dialog:modal")].at(-1);
      if (dialog && !dialog.contains(node)) return;
      const box = node.getBoundingClientRect();
      if (box.top < innerHeight + 400 && box.bottom > 0) loadMore();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    document.addEventListener("close", load, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("close", load, true);
    };
  }, [hasMore, loadingMore, loading, pageError, loadMore]);
  const refreshError = hasPhotos && (requestError || indexState === "error");
  const status =
    pageError?.message ||
    (refreshError
      ? t(
          requestError
            ? "library.albumRefreshError"
            : "library.albumIndexError",
        )
      : partial && !hasMore && !["scanning", "error"].includes(indexState)
        ? t("library.albumPartialResults")
        : supported === false && library.connection?.client.transport
          ? t("library.albumCurrentFolderOnly")
          : "");
  if (!hasMore && !status) return null;
  return (
    <div class="album-paging" ref={marker}>
      {status && <p role="status">{status}</p>}
      {hasMore && !pageError && (
        <button
          class="text-button"
          disabled={loadingMore || (loading && !hasPhotos)}
          onClick={loadMore}
        >
          {t(loadingMore ? "library.loadingMore" : "library.loadMore")}
        </button>
      )}
      {(pageError || refreshError) && (
        <button
          class="text-button"
          disabled={refreshing}
          onClick={
            !pageError || pageError.code === "SEARCH_CURSOR_EXPIRED"
              ? refresh
              : loadMore
          }
        >
          {t("library.retry")}
        </button>
      )}
    </div>
  );
}
