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
import { ConnectionDialog } from "./components/ConnectionDialog.jsx";
import { DownloadPanel } from "./components/DownloadPanel.jsx";
import { Toast } from "./components/Toast.jsx";
import { SetupWizard } from "./components/SetupWizard.jsx";
import { UploadPage } from "./components/UploadPage.jsx";
import { AccountPage } from "./components/AccountPage.jsx";
import { MyPage } from "./components/MyPage.jsx";
import { Favorites } from "./components/Favorites.jsx";
import { ListingOptionsMenu } from "./components/ListingOptionsMenu.jsx";
import { listingPreferences } from "./lib/file-listing.js";
import { useMediaQuery } from "./hooks/useMediaQuery.js";
import { useLibraryRoute } from "./hooks/useLibraryRoute.js";
import { useLibrary } from "./hooks/useLibrary.js";
import { useRecords } from "./hooks/useRecords.js";
import { useDownload } from "./hooks/useDownload.js";

// The route owner composes header actions from the same preferences as the
// listing. Headers only render their slot; children never mutate a shared header.
function listingActions(library, records) {
  const { recent, album, sort, view } = listingPreferences(library, records);
  return !recent && !album ? (
    <ListingOptionsMenu key={library.mode} sort={sort} view={view}
      onSortChange={library.setSort} onViewChange={library.setView} />
  ) : null;
}

function LibraryApp() {
  const source = useLibrary();
  const mobile = useMediaQuery("(max-width: 700px)");
  const navigation = useLibraryRoute();
  const { route } = navigation;
  const favoritesOpen = mobile && route === "favorites";
  const [favoritesMounted, setFavoritesMounted] = useState(favoritesOpen);
  const [favoritesSort, setFavoritesSort] = useState("name");
  const myPage = mobile && (route === "me" || route === "favorites" || favoritesMounted);
  const library = {
    ...source,
    mode: route === "favorites" ? "favorites" : myPage ? "me" : source.mode,
    // Routed account/favorite surfaces never inherit a hidden Home search or filter.
    query: route ? "" : source.query,
    kind: route ? "" : source.kind,
    sort: route === "favorites" ? favoritesSort : source.sort,
    setSort: route === "favorites" ? setFavoritesSort : source.setSort,
    selectMode: (mode, kind) => {
      if (mode === "me" || mode === "favorites") {
        source.selectMode(source.mode);
        navigation.navigate(mode);
      } else {
        source.selectMode(mode, kind);
        navigation.navigate(null);
      }
    },
    navigate: (path) => {
      source.navigate(path);
      navigation.navigate(null);
    },
  };
  useLayoutEffect(() => {
    if (favoritesOpen) setFavoritesMounted(true);
    else if (!mobile) setFavoritesMounted(false);
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
  const [selected, setSelected] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [recentSnapshot, setRecentSnapshot] = useState(null);
  // Persist visits immediately, but keep the clicked list still until the
  // preview has finished entering (or an interrupted preview has exited).
  const visibleRecords = library.mode === "home" && recentSnapshot?.key === library.key
    ? { ...records, ...recentSnapshot.records }
    : records;
  useLayoutEffect(() => setRecentSnapshot(null), [library.key, library.mode]);
  const [settings, setSettings] = useState(null);
  const [menu, setMenu] = useState(false);
  const previousRoute = useRef(route);
  const previousMobile = useRef(mobile);
  useLayoutEffect(() => {
    if (previousRoute.current !== route) {
      setMenu(false);
      setSettings((current) => current ? "closing" : null);
      setSelected(null);
      setPreviewOpen(false);
    }
    // A sheet changes into a page at this breakpoint. Close its nested preview
    // before creating a new native top-layer parent, rather than covering it.
    if (previousMobile.current !== mobile && route === "favorites") {
      setSettings(null);
      setSelected(null);
      setPreviewOpen(false);
      requestAnimationFrame(() =>
        document.getElementById("favorites-back")?.focus({ preventScroll: true }));
    }
    previousRoute.current = route;
    previousMobile.current = mobile;
  }, [route, mobile]);
  useEffect(() => {
    if (library.setup) {
      setSettings(null);
      setMenu(false);
      setMessage(null);
    }
  }, [library.setup]);

  useEffect(() => {
    setSelected(null);
    setPreviewOpen(false);
    setRecentSnapshot(null);
  }, [library.connection]);
  const closePreview = () => setPreviewOpen(false);
  const finishPreview = () => {
    const path = selected?.path;
    setRecentSnapshot(null);
    setSelected(null);
    requestAnimationFrame(() =>
      ([...document.querySelectorAll(".file-open")]
        .find((node) => node.dataset.path === path) ||
        document.getElementById("favorites-back"))?.focus(),
    );
  };
  useLayoutEffect(() => {
    const keyboard = (event) => {
      if (event.key === "Escape" && !settings && !event.defaultPrevented) {
        if (menu) setMenu(false);
        else if (selected && !document.getElementById("preview-dialog")?.matches(":modal")) {
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
        !menu &&
        !myPage &&
        library.mode === "home"
      ) {
        event.preventDefault();
        document.getElementById("search")?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [selected, settings, menu, library.mode, myPage]);
  useEffect(() => {
    const stop = () => {
      transfer.cancel();
      library.connection?.transport?.close();
    };
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, [library.connection]);

  const showSettings = () => {
    setMenu(false);
    setSettings("open");
  };
  const preview = (item) => {
    if (library.mode === "home" && (!previewOpen || selected?.path !== item.path)) {
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
    setSelected(item);
    setPreviewOpen(true);
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
    <div class={`app-shell${previewOpen ? " preview-open" : ""}`}>
      <Sidebar
        library={library}
        records={records}
        open={menu}
        onClose={() => setMenu(false)}
        onSettings={showSettings}
      />
      <main class={`main-area${!route && library.mode === "home" ? " home-page" : ""}${myPage ? " my-main" : ""}`}>
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
              menuOpen={menu}
              onMenu={() => setMenu((value) => !value)}
            />
            {library.mode === "home" && <CategoryCards library={library} />}
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
                <FileBrowser library={favoritesLibrary} records={records} selected={selected}
                  onPreview={preview} onSettings={showSettings} />
              </Favorites>
            ) : (
              <FileBrowser library={library} records={visibleRecords} selected={selected}
                onPreview={preview} onSettings={showSettings} />
            )}
          </>
        )}
      </main>
      <MobileTabs library={library} onCloseMenu={() => setMenu(false)} />
      {mobile && (favoritesOpen || favoritesMounted) && (
        <Favorites mobile open={favoritesOpen}
          actions={listingActions(favoritesLibrary, records)}
          onClose={() => navigation.closeFavorites(true)}
          onExited={() => {
            setFavoritesMounted(false);
            if (route !== "me") requestAnimationFrame(() =>
              document.querySelector(".mobile-tabs [aria-current='page']")?.focus({ preventScroll: true }));
          }}>
          <FileBrowser
            library={favoritesLibrary}
            records={records} selected={selected} onPreview={preview} onSettings={showSettings}
          />
          {!selected && !settings && feedback}
        </Favorites>
      )}
      {selected && library.connection && (
        <FilePreview
          key={selected.path}
          item={selected}
          client={library.connection.client}
          favorite={records.isFavorite(selected)}
          onFavorite={records.toggleFavorite}
          onDownload={transfer.download}
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
          fallbackFocus={favoritesOpen ? "#favorites-back" : myPage ? "#my-settings" : undefined}
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
      {!selected && !settings && !(mobile && (favoritesOpen || favoritesMounted)) && feedback}
    </div>
  );
}

const currentRoute = () =>
  location.hash.startsWith("#/account")
    ? "account"
    : (location.hash.match(/^#\/upload\/(.*)$/)?.[1] ?? null);

export function App() {
  const [token, setToken] = useState(currentRoute);
  useEffect(() => {
    const changed = () => setToken(currentRoute());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return token === "account" ? (
    <AccountPage />
  ) : token === null ? (
    <LibraryApp />
  ) : (
    <UploadPage key={token} token={token} />
  );
}
