import { useEffect, useRef } from "preact/hooks";
import { t } from "../../shared/i18n.js";

export function AlbumIndexStatus({ library }) {
  const error = library.indexState === "error";
  if (!error && library.indexState !== "scanning") return null;
  return (
    <div class="album-index-status">
      <p role="status">
        {t(error ? "library.albumIndexError" : "library.albumIndexing")}
      </p>
      {error && (
        <button class="text-button" onClick={library.refresh}>
          {t("library.retry")}
        </button>
      )}
    </div>
  );
}

export function AlbumPaging({ library }) {
  const marker = useRef(null);
  const {
    hasMore,
    loadingMore,
    loading,
    pageError,
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
  const status =
    pageError?.message ||
    (partial && !hasMore && !["scanning", "error"].includes(indexState)
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
          disabled={loadingMore || loading}
          onClick={loadMore}
        >
          {t(loadingMore ? "library.loadingMore" : "library.loadMore")}
        </button>
      )}
      {pageError && (
        <button
          class="text-button"
          onClick={
            pageError?.code === "SEARCH_CURSOR_EXPIRED" ? refresh : loadMore
          }
        >
          {t("library.retry")}
        </button>
      )}
    </div>
  );
}
