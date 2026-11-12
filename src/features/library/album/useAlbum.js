import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { MemoryCache } from "../../../lib/cache.js";
import { searchAlbum } from "../../../lib/search.js";
import { coreError } from "../../../lib/errors.js";

const empty = Object.freeze({
  entries: [],
  loading: true,
  loadingMore: false,
  refreshing: false,
  cursor: "",
  pages: 0,
  indexState: null,
  revision: "",
  requestError: null,
  pageError: null,
});
export function useAlbum(connection, path, enabled) {
  const [state, setState] = useState(null);
  const manager = useRef(null);
  const cache = useRef(null);
  const client = connection?.client;
  if (cache.current?.client !== client)
    cache.current = { client, values: new MemoryCache(8 * 1024 * 1024, 16) };
  useEffect(() => {
    if (!enabled || !client) return;
    const lifetime = new AbortController();
    const storage = cache.current.values;
    const owner = { client, path };
    let value = storage.get(path)?.value || empty;
    let firstRequest, moreRequest, polling;
    let seen = new Set();
    const publish = (next) => {
      if (lifetime.signal.aborted) return;
      value = next;
      setState({ ...next, client, path });
      if (next.requestError || next.pageError) storage.delete(path);
      else if (!next.loading && !next.loadingMore && !next.refreshing)
        storage.set(path, next, JSON.stringify(next.entries).length * 2 + 1024);
    };
    const nextPage = async (cursor, revision, used, signal) => {
      const page = await searchAlbum(client, path, { cursor }, signal);
      signal.throwIfAborted();
      if (
        page.revision !== revision ||
        page.cursor === cursor ||
        (page.cursor && used.has(page.cursor))
      )
        throw coreError("SEARCH_INVALID");
      used.add(cursor);
      return page;
    };
    const schedule = () => {
      clearTimeout(polling);
      if (value.indexState === "scanning")
        polling = setTimeout(() => {
          if (firstRequest || moreRequest) schedule();
          else void first(false, true);
        }, 2500);
    };
    const first = async (refresh = false, keep = false) => {
      firstRequest?.abort();
      moreRequest?.abort();
      moreRequest = null;
      const controller = new AbortController();
      firstRequest = controller;
      const signal = AbortSignal.any([controller.signal, lifetime.signal]);
      const current = keep ? value : empty;
      publish({
        ...current,
        loading: true,
        loadingMore: false,
        refreshing: refresh || current.refreshing,
        requestError: refresh ? null : current.requestError,
        pageError: refresh ? null : current.pageError,
      });
      let firstPage;
      try {
        firstPage = await searchAlbum(client, path, { refresh }, signal);
        signal.throwIfAborted();
        let page = firstPage;
        let entries = firstPage.entries;
        let pages = 1;
        const same =
          current.entries.length &&
          page.revision &&
          page.revision === current.revision &&
          !(refresh && current.pageError);
        if (same) {
          // Keep the DOM and loaded pages intact for status-only changes.
          entries = current.entries;
          pages = current.pages;
          page = {
            ...page,
            cursor: current.cursor,
            partial: page.cursor ? current.partial : page.partial,
          };
        } else {
          const used = new Set();
          if (page.cursor && current.entries.length) {
            // Load the previously browsed range before replacing the grid.
            // Allow one extra page when new entries push existing photos back.
            const previous = new Set(current.entries.map((item) => item.path));
            const target =
              current.entries.length +
              entries.filter((item) => !previous.has(item.path)).length;
            const collected = new Map(entries.map((item) => [item.path, item]));
            while (
              page.cursor &&
              collected.size < target &&
              pages <= current.pages
            ) {
              page = await nextPage(
                page.cursor,
                firstPage.revision,
                used,
                signal,
              );
              pages++;
              for (const item of page.entries) collected.set(item.path, item);
            }
            if (used.size) entries = [...collected.values()];
          }
          seen = used;
        }
        publish({
          ...page,
          entries,
          pages,
          loading: false,
          loadingMore: false,
          refreshing: value.refreshing && page.indexState === "scanning",
          requestError: null,
          pageError: same ? current.pageError : null,
        });
        return value.entries;
      } catch (error) {
        if (signal.aborted) return;
        if (
          error.code === "SEARCH_CURSOR_EXPIRED" &&
          firstPage?.indexState === "scanning"
        ) {
          // The scan published another batch while the replacement was loading.
          publish({ ...value, loading: false, indexState: "scanning" });
        } else {
          publish({
            ...value,
            loading: false,
            refreshing: false,
            requestError: error,
          });
        }
      } finally {
        if (firstRequest === controller) firstRequest = null;
        if (!lifetime.signal.aborted) schedule();
      }
    };
    const more = async () => {
      if (
        !value.cursor ||
        firstRequest ||
        moreRequest ||
        lifetime.signal.aborted
      )
        return;
      const cursor = value.cursor;
      const controller = new AbortController();
      moreRequest = controller;
      const signal = AbortSignal.any([controller.signal, lifetime.signal]);
      publish({ ...value, loadingMore: true, pageError: null });
      try {
        const page = await nextPage(cursor, value.revision, seen, signal);
        const entries = [
          ...new Map(
            [...value.entries, ...page.entries].map((item) => [
              item.path,
              item,
            ]),
          ).values(),
        ];
        publish({
          ...page,
          entries,
          pages: value.pages + 1,
          loading: false,
          loadingMore: false,
          refreshing: value.refreshing && page.indexState === "scanning",
          requestError: value.requestError,
          pageError: null,
        });
        return entries;
      } catch (error) {
        if (!signal.aborted)
          publish({ ...value, loadingMore: false, pageError: error });
      } finally {
        if (moreRequest === controller) moreRequest = null;
        if (!lifetime.signal.aborted) schedule();
      }
    };
    owner.more = more;
    owner.refresh = () => {
      if (value.refreshing) return;
      client.images?.expire();
      return first(true, true);
    };
    manager.current = owner;
    const cached = storage.get(path);
    publish({
      ...value,
      loading: !cached,
      loadingMore: false,
      requestError: null,
      pageError: null,
    });
    if (cached && Date.now() - cached.time < 15000) schedule();
    else void first(false, !!cached);
    return () => {
      lifetime.abort();
      clearTimeout(polling);
      if (manager.current === owner) manager.current = null;
    };
  }, [client, path, enabled]);
  const refresh = useCallback(() => manager.current?.refresh(), []);
  const loadMore = useCallback(() => manager.current?.more(), []);
  const current =
    enabled && state && state.client === client && state.path === path
      ? state
      : empty;
  return {
    ...current,
    path,
    refresh,
    loadMore,
    hasMore: !!current.cursor,
    scope: `${connection?.backend.endpoint || ""}\0${path}`,
  };
}
