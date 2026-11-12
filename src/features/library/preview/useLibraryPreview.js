import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "preact/hooks";
import { t } from "../../../../shared/i18n.js";
import { albumHref, filesHref } from "../../../../shared/routes.js";
import { groupMediaByDate } from "../../../lib/album.js";

export function useLibraryPreview({
  router,
  source,
  library,
  records,
  route,
  mobile,
  albumPresent,
  toast,
  setSettings,
}) {
  const [selected, setSelected] = useState(null);
  const [gallery, setGallery] = useState(null);
  const galleryItems = useRef(null);
  const selectedRef = useRef(null);
  selectedRef.current = selected;
  const onGalleryItems = useCallback((value) => {
    galleryItems.current = value;
    setGallery((current) => {
      if (
        !current ||
        current.scope !== value.scope ||
        (selectedRef.current &&
          !value.items.some((item) => item.path === selectedRef.current.path))
      )
        return current;
      if (
        current.items === value.items &&
        current.hasMore === value.hasMore &&
        current.loadingMore === value.loadingMore &&
        current.pageError === value.pageError
      )
        return current;
      return { ...current, ...value };
    });
  }, []);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    if (
      !previewOpen ||
      !gallery?.hasMore ||
      gallery.loadingMore ||
      gallery.pageError
    )
      return;
    const index = gallery.items.findIndex(
      (item) => item.path === selected?.path,
    );
    if (index >= 0 && index >= gallery.items.length - 4)
      void gallery.loadMore?.();
  }, [previewOpen, selected?.path, gallery]);
  useEffect(() => {
    if (previewOpen && gallery?.pageError)
      toast(gallery.pageError.message, true);
  }, [previewOpen, gallery?.pageError, toast]);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [recentSnapshot, setRecentSnapshot] = useState(null);
  const [albumBackground, setAlbumBackground] = useState(null);
  useLayoutEffect(() => {
    const client = library.connection?.client;
    if (!client) return;
    const revealRecords = (changed) => {
      if (!changed) return;
      setRecentSnapshot(null);
      setAlbumBackground(null);
    };
    client.onMissing = (path) => {
      source.removeMissing(path);
      revealRecords(records.forgetRecent([path]));
    };
    client.onListing = (path, entries) =>
      revealRecords(records.reconcileRecent(path, entries));
    return () => {
      client.onMissing = null;
      client.onListing = null;
    };
  }, [library.connection, library.key]);
  useLayoutEffect(() => {
    // A visit in the child viewer must not reorder or unmount the covered Home
    // list. Reveal updated recents only after the album page has exited.
    if (albumPresent)
      setAlbumBackground((current) =>
        current?.key === library.key
          ? current
          : {
              key: library.key,
              recent: records.recent,
              recentStatus: records.recentStatus,
              recentError: records.recentError,
            },
      );
    else setAlbumBackground(null);
  }, [albumPresent, library.key]);
  // Persist visits immediately, but keep the clicked list still until the
  // preview has finished entering (or an interrupted preview has exited).
  const visibleRecords =
    albumPresent && albumBackground?.key === library.key
      ? { ...records, ...albumBackground }
      : library.mode === "home" && recentSnapshot?.key === library.key
        ? { ...records, ...recentSnapshot.records }
        : records;
  useLayoutEffect(() => setRecentSnapshot(null), [library.key, library.mode]);
  const previousRoute = useRef(route);
  const previousMobile = useRef(mobile);
  useLayoutEffect(() => {
    if (previousRoute.current !== route) {
      setSettings((current) => (current ? "closing" : null));
      setSelected(null);
      setPreviewOpen(false);
    }
    // A sheet changes into a page at this breakpoint. Close its nested preview
    // before creating a new native top-layer parent, rather than covering it.
    if (
      previousMobile.current !== mobile &&
      ["favorites", "album"].includes(route)
    ) {
      setSettings(null);
      if (router.route.file) closePreview();
      setSelected(null);
      setPreviewOpen(false);
    }
    previousRoute.current = route;
    previousMobile.current = mobile;
  }, [route, mobile]);

  useEffect(() => {
    setSelected(null);
    setPreviewOpen(false);
    setRecentSnapshot(null);
  }, [library.connection]);
  const closePreview = () => {
    setPreviewOpen(false);
    if (router.route.file)
      router.close(
        "previewFrom",
        router.route.album
          ? albumHref(router.route.directory)
          : filesHref(router.route.directory, { directory: true }),
      );
  };
  const [routeError, setRouteError] = useState("");
  useLayoutEffect(() => {
    setRouteError("");
    if (!router.route.file) {
      setPreviewOpen(false);
      return;
    }
    if (!source.connection) return;
    const root = source.connection.client.root.replace(/\/?$/, "/");
    const path = root + router.route.file;
    if (selected && selected.path !== path) {
      setPreviewOpen(false);
      setSelected(null);
      setGallery(null);
    }
    if (source.loading || source.error) return;
    const item = source.entries.find((entry) => entry.path === path);
    if (!item) {
      const folder = source.entries.find(
        (entry) => entry.isDirectory && entry.path === path + "/",
      );
      if (folder)
        router.navigate(filesHref(router.route.file, { directory: true }), {
          replace: true,
        });
      else {
        setPreviewOpen(false);
        setRouteError(t("library.fileNotFound"));
      }
      return;
    }
    if (selected?.path === path && previewOpen) return;
    if (!previewOpen) setPreviewEpoch((value) => value + 1);
    records.remember(item);
    setSelected(item);
    setPreviewOpen(true);
    if (router.route.album && ["image", "video"].includes(item.kind)) {
      const indexedGallery =
        galleryItems.current?.scope === source.album.scope &&
        galleryItems.current.items.some((entry) => entry.path === path)
          ? galleryItems.current
          : null;
      setGallery((existing) =>
        existing?.items.some((entry) => entry.path === path)
          ? existing
          : {
              ...indexedGallery,
              items:
                indexedGallery?.items ||
                groupMediaByDate(source.entries, new Date()).flatMap(
                  (group) => group.items,
                ),
              origins: new Map(),
            },
      );
    } else setGallery(null);
  }, [
    router.route.file,
    router.route.album,
    source.connection,
    source.loading,
    source.error,
    source.entries,
  ]);
  const previewReturnTarget = (scope) =>
    [...scope.querySelectorAll(".file-open")].find(
      (node) => node.dataset.path === selected?.path,
    );
  const finishPreview = () => {
    setRecentSnapshot(null);
    setSelected(null);
    setGallery(null);
  };
  const preview = (item, gallery = null) => {
    if (
      !albumPresent &&
      library.mode === "home" &&
      (!previewOpen || selected?.path !== item.path)
    ) {
      setRecentSnapshot((current) =>
        current?.key === library.key
          ? current
          : {
              key: library.key,
              records: {
                recent: records.recent,
                recentStatus: records.recentStatus,
                recentError: records.recentError,
              },
            },
      );
    }
    records.remember(item);
    setGallery(gallery);
    setSelected(item);
    if (!previewOpen) setPreviewEpoch((value) => value + 1);
    setPreviewOpen(true);
    const root = library.connection.client.root.replace(/\/?$/, "/");
    const href = filesHref(item.path.slice(root.length), { album: !!gallery });
    const alreadyPreview = !!router.route.file;
    router.navigate(href, {
      replace: alreadyPreview,
      state: alreadyPreview
        ? router.state
        : { ...router.state, previewFrom: router.route.href },
    });
  };
  return {
    selected,
    setSelected,
    gallery,
    previewOpen,
    previewEpoch,
    routeError,
    visibleRecords,
    onGalleryItems,
    preview,
    closePreview,
    finishPreview,
    previewReturnTarget,
    onPreviewEntered: () => setRecentSnapshot(null),
  };
}
