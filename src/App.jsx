import { t } from "../shared/i18n.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "preact/hooks";
import { Sidebar, Topbar, MobileTabs } from "./components/Navigation.jsx";
import { FileBrowser } from "./components/FileBrowser.jsx";
import { CategoryCards } from "./components/CategoryCards.jsx";
import { FilePreview } from "./components/FilePreview.jsx";
import { AlbumViewer } from "./components/AlbumViewer.jsx";
import { ConnectionDialog } from "./components/ConnectionDialog.jsx";
import { DownloadPanel } from "./components/DownloadPanel.jsx";
import { Toast } from "./components/Toast.jsx";
import { SetupWizard } from "./components/SetupWizard.jsx";
import { UploadPage } from "./components/UploadPage.jsx";
import { AccountPage } from "./components/AccountPage.jsx";
import { AdminPage } from "./components/AdminPage.jsx";
import { MyPage } from "./components/MyPage.jsx";
import { Favorites } from "./components/Favorites.jsx";
import { PageDialog } from "./components/PageDialog.jsx";
import { Icon } from "./components/Icon.jsx";
import { ListingOptionsMenu } from "./components/ListingOptionsMenu.jsx";
import { listingPreferences } from "./lib/file-listing.js";
import { useMediaQuery } from "./hooks/useMediaQuery.js";
import { useLibraryRoute } from "./hooks/useLibraryRoute.js";
import { useLibrary } from "./hooks/useLibrary.js";
import { useRecords } from "./hooks/useRecords.js";
import { useDownload } from "./hooks/useDownload.js";
import { useRouter } from "./hooks/useRouter.jsx";
import { albumHref, filesHref } from "../shared/routes.js";
import { groupMediaByDate } from "./lib/album.js";

// The route owner composes header actions from the same preferences as the
// listing. Headers only render their slot; children never mutate a shared header.
function listingActions(library, records) {
  const { recent, album, sort, view } = listingPreferences(library, records);
  return !recent && !album ? (
    <ListingOptionsMenu key={library.mode} sort={sort} view={view} edge="end"
      onSortChange={library.setSort} onViewChange={library.setView} />
  ) : null;
}

function LibraryApp() {
  const router = useRouter();
  const source = useLibrary();
  const mobile = useMediaQuery("(max-width: 700px)");
  const navigation = useLibraryRoute();
  const { route } = navigation;
  const favoritesOpen = mobile && route === "favorites";
  const [favoritesMounted, setFavoritesMounted] = useState(favoritesOpen);
  const albumOpen = mobile && route === "album";
  const [albumMounted, setAlbumMounted] = useState(albumOpen);
  const albumPresent = mobile && (albumOpen || albumMounted);
  const [favoritesSort, setFavoritesSort] = useState("name");
  const myPage = route === "me" || (mobile && (route === "favorites" || favoritesMounted));
  const library = {
    ...source,
    mode: route === "favorites" ? "favorites" : myPage ? "me" : route === "album" && !mobile ? "all" : source.mode,
    // Routed account/favorite surfaces never inherit a hidden Home search or filter.
    query: route ? "" : source.query,
    kind: route === "album" ? mobile ? source.kind : "album" : route ? "" : source.kind,
    sort: route === "favorites" ? favoritesSort : source.sort,
    setSort: route === "favorites" ? setFavoritesSort : source.setSort,
  };
  const basePage = !route || (mobile && route === "album");
  const collectionPage = basePage && (library.mode === "home" ||
    (library.mode === "all" && !["album", "image"].includes(library.kind)));
  useLayoutEffect(() => {
    if (favoritesOpen) setFavoritesMounted(true);
    else if (!mobile) setFavoritesMounted(false);
    if (albumOpen) setAlbumMounted(true);
    else if (!mobile) setAlbumMounted(false);
    if (!mobile && route === "me") navigation.navigate(null, true);
  }, [mobile, route]);
  const [message, setMessage] = useState(null);
  const timer = useRef(null);
  const toast = useCallback((text, error = false) => {
    setMessage({ text, error });
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        setMessage((current) => current && { ...current, leaving: true });
        // Keep the node in the popover layer until the fade-out has finished.
        timer.current = setTimeout(() => setMessage(null), 200);
      },
      error ? 6500 : 4500,
    );
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (library.error) toast(library.error.message, true);
  }, [library.error, toast]);
  const records = useRecords(library.key, toast);
  const transfer = useDownload(library.connection, records.remember, toast);
  const [touchSelections, setTouchSelections] = useState(() => new Set());
  const onTouchSelection = useCallback((owner, active) => {
    setTouchSelections(current => {
      if (current.has(owner) === active) return current;
      const next = new Set(current);
      if (active) next.add(owner);
      else next.delete(owner);
      return next;
    });
  }, []);
  const [selected, setSelected] = useState(null);
  const [gallery, setGallery] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [recentSnapshot, setRecentSnapshot] = useState(null);
  const [albumBackground, setAlbumBackground] = useState(null);
  useLayoutEffect(() => {
    // A visit in the child viewer must not reorder or unmount the covered Home
    // list. Reveal updated recents only after the album page has exited.
    if (albumPresent) setAlbumBackground((current) => current?.key === library.key ? current : {
      key: library.key,
      recent: records.recent,
      recentStatus: records.recentStatus,
      recentError: records.recentError,
    });
    else setAlbumBackground(null);
  }, [albumPresent, library.key]);
  // Persist visits immediately, but keep the clicked list still until the
  // preview has finished entering (or an interrupted preview has exited).
  const visibleRecords = albumPresent && albumBackground?.key === library.key
    ? { ...records, ...albumBackground }
    : library.mode === "home" && recentSnapshot?.key === library.key
      ? { ...records, ...recentSnapshot.records }
      : records;
  useLayoutEffect(() => setRecentSnapshot(null), [library.key, library.mode]);
  const [settings, setSettings] = useState(null);
  const previousRoute = useRef(route);
  const previousMobile = useRef(mobile);
  useLayoutEffect(() => {
    if (previousRoute.current !== route) {
      setSettings((current) => current ? "closing" : null);
      setSelected(null);
      setPreviewOpen(false);
    }
    // A sheet changes into a page at this breakpoint. Close its nested preview
    // before creating a new native top-layer parent, rather than covering it.
    if (previousMobile.current !== mobile && ["favorites", "album"].includes(route)) {
      setSettings(null);
      if (router.route.file) closePreview();
      setSelected(null);
      setPreviewOpen(false);
      requestAnimationFrame(() =>
        document.getElementById(route === "album" ? "album-back" : "favorites-back")?.focus({ preventScroll: true }));
    }
    previousRoute.current = route;
    previousMobile.current = mobile;
  }, [route, mobile]);
  useEffect(() => {
    if (library.setup) {
      setSettings(null);
      setMessage(null);
    }
  }, [library.setup]);

  useEffect(() => {
    setSelected(null);
    setPreviewOpen(false);
    setRecentSnapshot(null);
  }, [library.connection]);
  const closePreview = () => {
    setPreviewOpen(false);
    if (router.route.file) router.close("previewFrom", router.route.album ? albumHref(router.route.directory) : filesHref(router.route.directory, { directory: true }));
  };
  const [routeError, setRouteError] = useState("");
  useLayoutEffect(() => {
    setRouteError("");
    if (!router.route.file) { setPreviewOpen(false); return; }
    if (!source.connection) return;
    const root = source.connection.client.root.replace(/\/?$/, "/");
    const path = root + router.route.file;
    if (selected && selected.path !== path) { setPreviewOpen(false); setSelected(null); setGallery(null); }
    if (source.loading || source.error) return;
    const item = source.entries.find((entry) => entry.path === path);
    if (!item) {
      const folder = source.entries.find((entry) => entry.isDirectory && entry.path === path + "/");
      if (folder) router.navigate(filesHref(router.route.file, { directory: true }), { replace: true });
      else { setPreviewOpen(false); setRouteError(t("library.fileNotFound")); }
      return;
    }
    if (selected?.path === path && previewOpen) return;
    if (!previewOpen) setPreviewEpoch((value) => value + 1);
    records.remember(item);
    setSelected(item);
    setPreviewOpen(true);
    if (router.route.album && ["image", "video"].includes(item.kind)) {
      setGallery((existing) => existing?.items.some((entry) => entry.path === path) ? existing : {
        items: groupMediaByDate(source.entries, new Date()).flatMap((group) => group.items), origins: new Map(),
      });
    } else setGallery(null);
  }, [router.route.file, router.route.album, source.connection, source.loading, source.error, source.entries]);
  const finishPreview = () => {
    const path = selected?.path;
    setRecentSnapshot(null);
    setSelected(null);
    setGallery(null);
    requestAnimationFrame(() => {
      const scope = [...document.querySelectorAll("dialog:modal")].at(-1) || document;
      ([...scope.querySelectorAll(".file-open")]
        .find((node) => node.dataset.path === path) ||
        document.getElementById(albumPresent ? "album-back" : "favorites-back"))?.focus();
    });
  };
  useLayoutEffect(() => {
    const keyboard = (event) => {
      if (event.key === "Escape" && !settings && !event.defaultPrevented) {
        if (selected && !document.querySelector("#preview-dialog:modal, #album-viewer:modal")) {
          event.preventDefault();
          closePreview();
        }
      }
      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !document.activeElement?.isContentEditable &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          document.activeElement?.tagName,
        ) &&
        !settings &&
        !selected &&
        !albumPresent &&
        !myPage &&
        library.mode === "home"
      ) {
        event.preventDefault();
        document.getElementById("search")?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [selected, settings, library.mode, myPage, albumPresent]);
  useEffect(() => {
    const stop = () => {
      transfer.cancel();
      library.connection?.transport?.close();
    };
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, [library.connection]);

  const showSettings = () => {
    setSettings("open");
  };
  const preview = (item, gallery = null) => {
    if (!albumPresent && library.mode === "home" && (!previewOpen || selected?.path !== item.path)) {
      setRecentSnapshot((current) => current?.key === library.key ? current : {
        key: library.key,
        records: {
          recent: records.recent,
          recentStatus: records.recentStatus,
          recentError: records.recentError,
        },
      });
    }
    records.remember(item);
    setGallery(gallery);
    setSelected(item);
    if (!previewOpen) setPreviewEpoch((value) => value + 1);
    setPreviewOpen(true);
    const root = library.connection.client.root.replace(/\/?$/, "/");
    const href = filesHref(item.path.slice(root.length), { album: !!gallery });
    const alreadyPreview = !!router.route.file;
    router.navigate(href, { replace: alreadyPreview, state: alreadyPreview ? router.state : { ...router.state, previewFrom: router.route.href } });
  };
  const copyLink = async (item) => {
    const root = library.connection.client.root.replace(/\/?$/, "/");
    try {
      await navigator.clipboard.writeText(new URL(filesHref(item.path.slice(root.length), { directory: item.isDirectory, album: !item.isDirectory && !!gallery }), location.origin).href);
      toast(t("library.linkCopied"));
    } catch { toast(t("library.copyLinkFailed"), true); }
  };
  library.copyLink = copyLink;
  library.copyLinks = async items => {
    const root = (library.connection?.client.root || "/").replace(/\/?$/, "/");
    const album = ["album", "image"].includes(library.kind) || albumPresent;
    try {
      const links = items.map(item => new URL(filesHref(item.path.slice(root.length), {
        directory: item.isDirectory, album: album && !item.isDirectory,
      }), location.origin).href);
      await navigator.clipboard.writeText(links.join("\n"));
      toast(t("library.linksCopied", { count: items.length }));
    } catch { toast(t("library.copyLinkFailed"), true); }
  };
  const connect = (credentials) => {
    setSettings("closing");
    setSelected(null);
    setMessage(null);
    transfer.cancel();
    library.setCredentials(credentials);
  };
  const favoritesLibrary = {
    ...library, mode: "favorites", kind: "", query: "",
    sort: favoritesSort, setSort: setFavoritesSort,
  };
  const albumLibrary = { ...library, mode: "all", kind: "album", query: "" };
  const feedback = (
    <>
      <DownloadPanel progress={transfer.progress} onCancel={transfer.cancel} />
      {message && <Toast message={message} />}
    </>
  );
  if (library.setup && !library.demoPreview)
    return (
      <>
        <SetupWizard
          setup={library.setup}
          checking={library.loading}
          onRetry={library.reconnect}
          onDemo={() => {
            setMessage(null);
            library.startDemo();
          }}
          notify={toast}
        />
        {feedback}
      </>
    );
  return (
    <div class={`app-shell${previewOpen && !gallery ? " preview-open" : ""}${touchSelections.size ? " touch-selecting" : ""}`}>
      {!mobile && <Sidebar
        library={library}
        records={records}
        onSettings={showSettings}
      />}
      <main class={`main-area${collectionPage ? " collection-page" : ""}${basePage && library.mode === "home" ? " home-page" : ""}${myPage ? " my-main" : ""}`}>
        {routeError && <div class="route-error" role="alert"><p>{routeError}</p><button class="text-button" onClick={closePreview}>{t("library.backToFolder")}</button></div>}
        {myPage ? (
          <MyPage
            active={route === "me"}
            onFavorites={() => library.selectMode("favorites")}
            onSettings={showSettings}
          />
        ) : (
          <>
            <Topbar
              library={library}
              actions={route === "favorites" ? null : listingActions(library, visibleRecords)}
            />
            {library.mode === "home" && <CategoryCards library={library} albumOpen={albumOpen} />}
            {library.demoPreview && (
              <div class="demo-preview-note">
                <span>{t("library.demoPreview")}</span>
                <button class="text-button" onClick={library.endDemo}>
                  {t("library.backToSetup")}
                </button>
              </div>
            )}
            {route === "favorites" ? (
              <Favorites mobile={false} onClose={() => navigation.closeFavorites(false)}
                actions={listingActions(favoritesLibrary, records)}>
                <FileBrowser library={favoritesLibrary} records={records} selected={selected} onTouchSelection={onTouchSelection}
                  onPreview={preview} onSettings={showSettings} />
              </Favorites>
            ) : (
              <FileBrowser library={library} records={visibleRecords} selected={selected}
                onTouchSelection={onTouchSelection}
                listId={albumPresent ? "background-file-list" : "file-list"}
                countId={albumPresent ? "background-item-count" : "item-count"}
                onPreview={preview} onSettings={showSettings} />
            )}
          </>
        )}
      </main>
      <MobileTabs library={library} />
      {albumPresent && (
        <PageDialog id="album-page-dialog" className="album-page-dialog"
          title={t("core.category.album")} backId="album-back" backLabel={t("library.backToHome")}
          open={albumOpen} animateEntry={!router.initial}
          onClose={navigation.closeAlbum} onExited={() => setAlbumMounted(false)}
          fallbackFocus=".category-album"
          actions={<button id="album-refresh" class="icon-button edge-end"
            aria-label={t("library.refreshDirectory")} disabled={library.loading} aria-busy={library.loading}
            onClick={library.refresh}><Icon name="refresh" /></button>}>
          <FileBrowser library={albumLibrary} records={records} selected={selected}
            onTouchSelection={onTouchSelection}
            pageDialog onPreview={preview} onSettings={showSettings} />
          {!selected && !settings && feedback}
        </PageDialog>
      )}
      {mobile && (favoritesOpen || favoritesMounted) && (
        <Favorites mobile open={favoritesOpen}
          actions={listingActions(favoritesLibrary, records)}
          onClose={() => navigation.closeFavorites(true)}
          onExited={() => {
            setFavoritesMounted(false);
            requestAnimationFrame(() =>
              (route === "me" ? document.getElementById("my-favorites") : document.querySelector(".mobile-tabs [aria-current='page']"))?.focus({ preventScroll: true }));
          }}>
          <FileBrowser
            library={favoritesLibrary}
            onTouchSelection={onTouchSelection}
            records={records} selected={selected} onPreview={preview} onSettings={showSettings}
          />
          {!selected && !settings && feedback}
        </Favorites>
      )}
      {selected && library.connection && gallery && (
        <AlbumViewer
          key={previewEpoch}
          gallery={gallery}
          item={selected}
          client={library.connection.client}
          open={previewOpen}
          onSelect={(item) => preview(item, gallery)}
          favorite={records.isFavorite(selected)}
          onFavorite={records.toggleFavorite}
          onDownload={transfer.download}
          onCopyLink={copyLink}
          onClose={closePreview}
          onExited={finishPreview}
          feedback={feedback}
        />
      )}
      {selected && library.connection && !gallery && (
        <FilePreview
          key={selected.path}
          item={selected}
          client={library.connection.client}
          favorite={records.isFavorite(selected)}
          onFavorite={records.toggleFavorite}
          onDownload={transfer.download}
          onCopyLink={copyLink}
          onError={(text) => toast(text, true)}
          onClose={closePreview}
          open={previewOpen}
          onEntered={() => setRecentSnapshot(null)}
          onExited={finishPreview}
          feedback={settings ? null : feedback}
        />
      )}
      {settings && (
        <ConnectionDialog
          open={settings === "open"}
          fallbackFocus={albumPresent ? "#album-back" : favoritesOpen ? "#favorites-back" : myPage ? "#my-settings" : undefined}
          onExited={() => setSettings(null)}
          backend={library.backend}
          credentials={library.credentials}
          onConnect={connect}
          onForget={() => {
            setSelected(null);
            transfer.cancel();
            library.setCredentials({ mode: "none" });
            toast(t("library.credentialsCleared"));
          }}
          onClose={() => setSettings("closing")}
          feedback={feedback}
        />
      )}
      {!selected && !settings && !albumPresent && !(mobile && (favoritesOpen || favoritesMounted)) && feedback}
    </div>
  );
}

export function App() {
  const { route } = useRouter();
  return route.page === "account" ? (
    <AccountPage />
  ) : route.page === "admin" ? (
    <AdminPage />
  ) : route.page === "upload" ? (
    <UploadPage key={route.token} token={route.token} />
  ) : route.page === "not-found" ? (
    <main class="setup-page"><h1>{t("library.pageNotFound")}</h1><a href="/">{t("library.backToHome")}</a></main>
  ) : (
    <LibraryApp />
  );
}
