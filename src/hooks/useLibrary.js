import { t, locale } from "../../shared/i18n.js";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DirectTransport } from "../lib/transport.js";
import { DAVClient } from "../lib/dav.js";
import { DemoClient } from "../lib/demo.js";
import { useRouter } from "./useRouter.jsx";
import {
  albumHref,
  filesHref,
  libraryLocation,
  parseRoute,
} from "../../shared/routes.js";
import { normalizePath, withinRoot } from "../lib/dav.js";
import { clearPersistentImages } from "../lib/image-cache.js";
import { useAlbum } from "./useAlbum.js";

export function useLibrary() {
  const router = useRouter();
  const current = libraryLocation(router.route, router.state);
  const [credentials, setCredentials] = useState({ mode: "none" });
  const previousCredentials = useRef(credentials);
  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState(null);
  const [challengedBackend, setChallengedBackend] = useState(null);
  const [connecting, setConnecting] = useState(true);
  const [configError, setConfigError] = useState(null);
  const [setup, setSetup] = useState(null);
  const [demoPreview, setDemoPreview] = useState(false);
  const [listingError, setListingError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState([]);
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const { mode, kind, query } = current;
  const root = (connection?.client.root || "/").replace(/\/?$/, "/");
  const path = normalizePath(root + current.directory);
  const albumOrigin = parseRoute(router.state.previewFrom || "");
  const albumPath = normalizePath(
    root +
      (albumOrigin.surface === "album"
        ? albumOrigin.directory
        : router.route.directory || ""),
  );
  const albumEnabled =
    router.route.surface === "album" ||
    (router.route.album === true &&
      (!router.state.previewFrom || albumOrigin.surface === "album"));
  const directoryRequired =
    !albumEnabled || !!router.route.file || current.mode === "home";
  const album = useAlbum(connection, albumPath, albumEnabled);
  const [sort, setSort] = useState("name");
  const [homeSort, setHomeSort] = useState("name");
  const [view, setView] = useState("list");
  const [albumView, setAlbumView] = useState("date");
  const forceListing = useRef(false);
  const listingPath = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    let transport, client;
    setConnecting(true);
    setConfigError(null);
    setListingError(null);
    setConnection(null);
    setEntries([]);
    setLoading(true);
    const connect = (backend) => {
      transport =
        backend.transport === "demo"
          ? null
          : new DirectTransport(backend, credentials, {
              onGatewayChallenge: () => {
                if (!controller.signal.aborted) setChallengedBackend(backend);
              },
            });
      client = transport ? new DAVClient(transport, backend) : new DemoClient();
      setConnection({ backend, client, transport });
    };
    (async () => {
      try {
        if (previousCredentials.current !== credentials) {
          previousCredentials.current = credentials;
          await clearPersistentImages();
          if (controller.signal.aborted) return;
        }
        if (demoPreview) {
          connect({
            name: t("core.publicLibraryName"),
            transport: "demo",
            endpoint: "",
            rootPath: "/",
            auth: "none",
            certificates: [],
          });
          return;
        }
        const response = await fetch("/api/config", {
          cache: "no-store",
          headers: { "Accept-Language": locale },
          signal: controller.signal,
        });
        const config = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok)
          throw new Error(config.error || t("core.configurationUnavailable"));
        if (config.setupRequired) {
          setSetup({ ...config.setup, checked: revision > 0 });
          return;
        }
        connect(config.backend);
        setSetup(null);
      } catch (error) {
        if (!controller.signal.aborted) setConfigError(error);
      } finally {
        if (!controller.signal.aborted) setConnecting(false);
      }
    })();
    return () => {
      controller.abort();
      client?.dispose?.();
      transport?.close();
    };
  }, [credentials, revision, demoPreview]);

  useEffect(() => {
    if (!connection) return;
    listingPath.current = path;
    const controller = new AbortController();
    const cached = connection.client.cached?.(path);
    if (!directoryRequired) {
      setLoading(false);
      setListingError(null);
      setEntries(cached || []);
      return;
    }
    const force = forceListing.current;
    setLoading(!cached || force);
    setListingError(null);
    setEntries(cached || []);
    forceListing.current = false;
    connection.client
      .list(path, controller.signal, { force })
      .then(
        (result) => {
          if (!controller.signal.aborted) setEntries(result);
        },
        (error) => {
          if (!controller.signal.aborted) {
            setEntries([]);
            setListingError(error);
          }
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [connection, path, directoryRevision, directoryRequired]);

  const navigate = (next, nextMode = "all") => {
    next = normalizePath(next);
    if (!withinRoot(next, root)) return;
    router.navigate(
      nextMode === "home"
        ? "/"
        : filesHref(next.slice(root.length), { directory: true }),
    );
  };
  const selectMode = (next, filter = "") => {
    let parent = router.route.href;
    if (filter === "album" && query) {
      const url = new URL(parent, location.origin);
      url.searchParams.delete("q");
      parent = url.pathname + url.search;
      router.navigate(parent, { replace: true, state: router.state });
    }
    const href =
      next === "home"
        ? "/"
        : next === "favorites" || next === "me"
          ? `/${next}`
          : filter === "album"
            ? albumHref(current.directory)
            : filesHref(current.directory, { directory: true, type: filter });
    router.navigate(href, {
      state:
        ["favorites", "me"].includes(next) || filter === "album"
          ? { surfaceFrom: parent }
          : {},
    });
  };
  const setQuery = (query) => {
    const url = new URL(router.route.href, location.origin);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    router.navigate(url.pathname + url.search, {
      replace: true,
      state: router.state,
    });
  };
  const backend = connection?.backend;
  const key = useMemo(
    () =>
      backend
        ? `lantern-dock:${backend.transport}:${backend.endpoint}:${backend.rootPath}:`
        : "",
    [backend],
  );
  return {
    connection,
    album,
    backend,
    gatewayTokenRequired: !!backend && challengedBackend === backend,
    credentials,
    setCredentials,
    key,
    // Do not display the preceding directory while a routed listing loads.
    entries:
      listingPath.current === path
        ? entries
        : connection?.client.cached?.(path) || [],
    path,
    mode,
    kind,
    query,
    setQuery,
    sort: mode === "home" ? homeSort : sort,
    setSort: mode === "home" ? setHomeSort : setSort,
    view,
    setView,
    albumView,
    setAlbumView,
    navigate,
    selectMode,
    loading:
      connecting ||
      (!!connection &&
        directoryRequired &&
        (loading || listingPath.current !== path)),
    error: configError || listingError,
    removeMissing: (path) =>
      setEntries((current) =>
        current.some((item) => item.path === path)
          ? current.filter((item) => item.path !== path)
          : current,
      ),
    setup,
    demoPreview,
    startDemo: () => setDemoPreview(true),
    endDemo: () => setDemoPreview(false),
    reconnect: () => setRevision((value) => value + 1),
    refresh: () => {
      forceListing.current = true;
      setDirectoryRevision((value) => value + 1);
    },
  };
}
