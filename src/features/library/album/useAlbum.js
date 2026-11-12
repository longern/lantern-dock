import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { MemoryCache } from "../../../lib/cache.js";
import { searchAlbum } from "../../../lib/search.js";
import { coreError } from "../../../lib/errors.js";

const empty = Object.freeze({
  entries: [],
  loading: true,
  loadingMore: false,
  cursor: "",
  indexState: null,
  revision: "",
  error: null,
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
      if (next.error || next.pageError) storage.delete(path);
      if (!next.error && !next.pageError && !next.loading && !next.loadingMore)
        storage.set(path, next, JSON.stringify(next.entries).length * 2 + 1024);
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
      publish({
        ...(keep ? value : empty),
        loading: true,
        loadingMore: false,
        error: null,
        pageError: null,
      });
      try {
        const page = await searchAlbum(client, path, { refresh }, signal);
        if (signal.aborted) return;
        // A status poll for the same index must not discard already loaded
        // pages, change scroll position or invalidate a selection.
        const same = keep && page.revision && page.revision === value.revision;
        if (!same) seen = new Set();
        publish({
          ...page,
          ...(same
            ? {
                entries: value.entries,
                cursor: value.cursor,
                partial: value.partial,
              }
            : {}),
          loading: false,
          loadingMore: false,
          error: null,
          pageError: null,
        });
        return value.entries;
      } catch (error) {
        if (!signal.aborted) publish({ ...value, loading: false, error });
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
        const page = await searchAlbum(client, path, { cursor }, signal);
        if (signal.aborted) return;
        if (
          (value.revision && page.revision !== value.revision) ||
          page.cursor === cursor ||
          (page.cursor && seen.has(page.cursor))
        )
          throw coreError("SEARCH_INVALID");
        seen.add(cursor);
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
          loading: false,
          loadingMore: false,
          error: null,
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
      client.images?.expire();
      return first(true, true);
    };
    manager.current = owner;
    const cached = storage.get(path);
    publish({
      ...value,
      loading: !cached,
      loadingMore: false,
      error: null,
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
