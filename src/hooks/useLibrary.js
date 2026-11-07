import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DirectTransport } from "../lib/transport.js";
import { DAVClient } from "../lib/dav.js";
import { DemoClient } from "../lib/demo.js";

export function useLibrary() {
  const [credentials, setCredentials] = useState({ mode: "none" });
  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState(null);
  const [connecting, setConnecting] = useState(true);
  const [configError, setConfigError] = useState(null);
  const [setup, setSetup] = useState(null);
  const [demoPreview, setDemoPreview] = useState(false);
  const [listingError, setListingError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState([]);
  const [path, setPath] = useState("/");
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const [mode, setMode] = useState("home");
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("name");
  const [homeSort, setHomeSort] = useState("recent");
  const [view, setView] = useState("list");
  const forceListing = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let transport, client;
    setConnecting(true);
    setConfigError(null);
    setListingError(null);
    setConnection(null);
    setEntries([]);
    const connect = (backend) => {
      transport =
        backend.transport === "demo"
          ? null
          : new DirectTransport(backend, credentials);
      client = transport ? new DAVClient(transport, backend) : new DemoClient();
      setPath(client.root);
      setMode("home");
      setKind("");
      setQuery("");
      setConnection({ backend, client, transport });
    };
    (async () => {
      try {
        if (demoPreview) {
          connect({
            name: "公开资源库",
            transport: "demo",
            endpoint: "",
            rootPath: "/",
            auth: "none",
            gatewayAuth: false,
            certificates: [],
          });
          return;
        }
        const response = await fetch("/api/config", {
          cache: "no-store",
          signal: controller.signal,
        });
        const config = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(config.error || "服务配置暂不可用");
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
    const controller = new AbortController();
    const cached = connection.client.cached?.(path);
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
  }, [connection, path, directoryRevision]);

  const navigate = (next, nextMode = "all") => {
    // Clear the old directory before the listing effect starts for the new path.
    const cached = connection?.client.cached?.(next);
    setEntries(cached || []);
    setLoading(!cached);
    setListingError(null);
    setPath(next);
    setMode(nextMode);
    setKind("");
    setQuery("");
    setDirectoryRevision((value) => value + 1);
  };
  const selectMode = (next, filter = "") => {
    const root = connection?.client.root || "/";
    if (next === "home" && path !== root) {
      navigate(root, "home");
      return;
    }
    setMode(next);
    setKind(filter);
    setQuery("");
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
    backend,
    credentials,
    setCredentials,
    key,
    entries,
    path,
    mode,
    kind,
    query,
    setQuery,
    sort: mode === "home" ? homeSort : sort,
    setSort: mode === "home" ? setHomeSort : setSort,
    view,
    setView,
    navigate,
    selectMode,
    loading: connecting || (!!connection && loading),
    error: configError || listingError,
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
