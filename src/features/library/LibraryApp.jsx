import { t } from "../../../shared/i18n.js";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Sidebar, Topbar, MobileTabs } from "../../components/Navigation.jsx";
import { FileBrowser } from "../../components/FileBrowser.jsx";
import { CategoryCards } from "../../components/CategoryCards.jsx";
import { FilePreview } from "../../components/FilePreview.jsx";
import { AlbumViewer } from "../../components/AlbumViewer.jsx";
import { ConnectionDialog } from "../../components/ConnectionDialog.jsx";
import { TransferCenter } from "../../components/TransferCenter.jsx";
import { Toast } from "../../components/Toast.jsx";
import { SetupWizard } from "../../components/SetupWizard.jsx";
import { MyPage } from "../../components/MyPage.jsx";
import { Favorites } from "../../components/Favorites.jsx";
import { PageDialog } from "../../components/PageDialog.jsx";
import { Icon } from "../../components/Icon.jsx";
import { ListingOptionsMenu } from "../../components/ListingOptionsMenu.jsx";
import { AlbumOptionsMenu } from "../../components/AlbumOptionsMenu.jsx";
import { SelectionActions } from "../../components/SelectionActions.jsx";
import { FileIntakeActions } from "../../components/FileIntakeActions.jsx";
import { listingPreferences } from "../../lib/file-listing.js";
import { useCompactLayout } from "../../hooks/useMediaQuery.js";
import { useLibraryRoute } from "../../hooks/useLibraryRoute.js";
import { useLibrary } from "../../hooks/useLibrary.js";
import { useRecords } from "../../hooks/useRecords.js";
import { useDownload } from "../../hooks/useDownload.js";
import { useAdminNavigationGuard } from "../../hooks/useAdminNavigationGuard.js";
import { useTransferPanel } from "../../hooks/useTransferPanel.js";
import { useRouter } from "../../hooks/useRouter.jsx";
import { filesHref } from "../../../shared/routes.js";

import { useToast } from "../../hooks/useToast.js";
import { useLibrarySelection } from "./useLibrarySelection.js";
import { useLibraryPreview } from "./useLibraryPreview.js";

// The route owner composes header actions from the same preferences as the
// listing. Headers only render their slot; children never mutate a shared header.
function listingActions(library, records, compact) {
  const { recent, album, sort, view } = listingPreferences(library, records);
  return album ? (
    <AlbumOptionsMenu library={library} />
  ) : !recent ? (
    <ListingOptionsMenu
      key={library.mode}
      sort={sort}
      view={view}
      edge="end"
      onSortChange={library.setSort}
      onViewChange={library.setView}
      actions={
        compact || library.mode === "favorites"
          ? [
              {
                key: "refresh",
                label: t("library.refresh"),
                icon: "refresh",
                disabled: library.mode !== "favorites" && library.loading,
                onSelect:
                  library.mode === "favorites"
                    ? records.retry
                    : library.refresh,
              },
            ]
          : []
      }
    />
  ) : null;
}

export function LibraryApp() {
  const router = useRouter();
  const source = useLibrary();
  const mobile = useCompactLayout();
  const navigation = useLibraryRoute();
  const { route } = navigation;
  const favoritesOpen = mobile && route === "favorites";
  const [favoritesMounted, setFavoritesMounted] = useState(favoritesOpen);
  const albumOpen = mobile && route === "album";
  const [albumMounted, setAlbumMounted] = useState(albumOpen);
  const albumPresent = mobile && (albumOpen || albumMounted);
  const [favoritesSort, setFavoritesSort] = useState("name");
  const myPage =
    route === "me" || (mobile && (route === "favorites" || favoritesMounted));
  const library = {
    ...source,
    ...(route === "album" && !mobile ? source.album : {}),
    ...(route === "album" && !mobile
      ? {
          error:
            source.album.error || (!source.connection ? source.error : null),
        }
      : {}),
    mode:
      route === "favorites"
        ? "favorites"
        : myPage
          ? "me"
          : route === "album" && !mobile
            ? "all"
            : source.mode,
    // Routed account/favorite surfaces never inherit a hidden Home search or filter.
    query: route ? "" : source.query,
    kind:
      route === "album"
        ? mobile
          ? source.kind === "album"
            ? ""
            : source.kind
          : "album"
        : route
          ? ""
          : source.kind,
    sort: route === "favorites" ? favoritesSort : source.sort,
    setSort: route === "favorites" ? setFavoritesSort : source.setSort,
  };
  const basePage = !route || (mobile && route === "album");
  const collectionPage =
    basePage &&
    (library.mode === "home" ||
      (library.mode === "all" && !["album", "image"].includes(library.kind)));
  useLayoutEffect(() => {
    if (favoritesOpen) setFavoritesMounted(true);
    else if (!mobile) setFavoritesMounted(false);
    if (albumOpen) setAlbumMounted(true);
    else if (!mobile) setAlbumMounted(false);
    if (!mobile && route === "me") navigation.navigate(null, true);
  }, [mobile, route]);
  const { message, toast, clearToast } = useToast();
  useEffect(() => {
    if (library.error) toast(library.error.message, true);
  }, [library.error, toast]);
  const records = useRecords(library.key, toast);
  const transfer = useDownload(library.connection, records.rememberMany, toast);
  const [intakeWorking, setIntakeWorking] = useState(false);
  useAdminNavigationGuard(!!transfer.progress || intakeWorking);
  const transferPanel = useTransferPanel(transfer, mobile);
  const {
    touchSelections,
    desktopSelections,
    onTouchSelection,
    onDesktopSelection,
  } = useLibrarySelection();
  const headerActions = (listId, options) => {
    const selected = [...desktopSelections.values()].find(
      (value) => value.listId === listId,
    );
    return selected ? (
      <>
        <SelectionActions {...selected.props.current} />
        {options}
      </>
    ) : (
      options
    );
  };
  const [settings, setSettings] = useState(null);
  const {
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
    onPreviewEntered,
  } = useLibraryPreview({
    router,
    source,
    library,
    records,
    route,
    mobile,
    albumPresent,
    toast,
    setSettings,
  });
  useEffect(() => {
    if (library.setup) {
      setSettings(null);
      clearToast();
    }
  }, [library.setup]);
  useLayoutEffect(() => {
    const keyboard = (event) => {
      if (document.querySelector("#account-dialog:modal")) return;
      if (event.key === "Escape" && !settings && !event.defaultPrevented) {
        if (
          selected &&
          !document.querySelector("#preview-dialog:modal, #album-viewer:modal")
        ) {
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
  const copyLink = async (item) => {
    const root = library.connection.client.root.replace(/\/?$/, "/");
    try {
      await navigator.clipboard.writeText(
        new URL(
          filesHref(item.path.slice(root.length), {
            directory: item.isDirectory,
            album: !item.isDirectory && !!gallery,
          }),
          location.origin,
        ).href,
      );
      toast(t("library.linkCopied"));
    } catch {
      toast(t("library.copyLinkFailed"), true);
    }
  };
  library.copyLink = copyLink;
  library.downloadMany = transfer.downloadMany;
  library.downloading = !!transfer.progress;
  library.copyLinks = async (items) => {
    const root = (library.connection?.client.root || "/").replace(/\/?$/, "/");
    const album = ["album", "image"].includes(library.kind) || albumPresent;
    try {
      const links = items.map(
        (item) =>
          new URL(
            filesHref(item.path.slice(root.length), {
              directory: item.isDirectory,
              album: album && !item.isDirectory,
            }),
            location.origin,
          ).href,
      );
      await navigator.clipboard.writeText(links.join("\n"));
      toast(t("library.linksCopied", { count: items.length }));
    } catch {
      toast(t("library.copyLinkFailed"), true);
    }
  };
  const connect = (credentials) => {
    setSettings("closing");
    setSelected(null);
    clearToast();
    transfer.cancel();
    library.setCredentials(credentials);
  };
  const favoritesLibrary = {
    ...library,
    mode: "favorites",
    kind: "",
    query: "",
    sort: favoritesSort,
    setSort: setFavoritesSort,
  };
  const albumLibrary = {
    ...library,
    ...source.album,
    error: source.album.error || (!source.connection ? source.error : null),
    mode: "all",
    kind: "album",
    query: "",
  };
  const openAlbumLibrary = useRef(null);
  useLayoutEffect(() => {
    if (albumOpen) openAlbumLibrary.current = albumLibrary;
    else if (!albumPresent) openAlbumLibrary.current = null;
  }, [albumOpen, albumPresent, albumLibrary]);
  // The route stops the album query before the mobile page finishes sliding out.
  const dialogAlbumLibrary = albumOpen
    ? albumLibrary
    : (openAlbumLibrary.current ?? albumLibrary);
  const topbarActions =
    route === "favorites"
      ? null
      : headerActions(
          albumPresent ? "background-file-list" : "file-list",
          listingActions(library, visibleRecords, mobile),
        );
  const intakeAction = !route &&
    library.mode === "all" &&
    !["album", "image"].includes(library.kind) &&
    library.connection &&
    !library.demoPreview &&
    library.backend?.transport !== "demo" && (
      <FileIntakeActions
        client={library.connection.client}
        mobile={mobile}
        suspended={!!touchSelections.size}
        onWorkingChange={setIntakeWorking}
      />
    );
  const feedback = (
    <>
      <TransferCenter transfer={transfer} mobile={mobile} {...transferPanel} />
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
            clearToast();
            library.startDemo();
          }}
          notify={toast}
        />
        {feedback}
      </>
    );
  return (
    <div
      class={`app-shell${previewOpen && !gallery ? " preview-open" : ""}${touchSelections.size ? " touch-selecting" : ""}`}
    >
      {!mobile && <Sidebar library={library} onSettings={showSettings} />}
      <main
        class={`main-area${collectionPage ? " collection-page" : ""}${basePage && library.mode === "home" ? " home-page" : ""}${myPage ? " my-main" : ""}`}
      >
        {routeError && (
          <div class="route-error" role="alert">
            <p>{routeError}</p>
            <button class="text-button" onClick={closePreview}>
              {t("library.backToFolder")}
            </button>
          </div>
        )}
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
              hideRefresh={["album", "image"].includes(library.kind)}
              transferAction={
                library.mode === "home" && (
                  <button
                    id="transfers-button"
                    class={`icon-button transfer-trigger${topbarActions ? "" : " edge-end"}`}
                    aria-label={t("library.openTransfers")}
                    title={t("library.transfers")}
                    aria-expanded={transferPanel.open}
                    aria-controls={
                      mobile ? "transfer-dialog" : "transfer-window"
                    }
                    aria-haspopup={mobile ? "dialog" : undefined}
                    onClick={
                      transferPanel.open
                        ? transferPanel.onClose
                        : transferPanel.onOpen
                    }
                  >
                    <Icon name="transfers" />
                    {transfer.tasks.some((task) =>
                      ["queued", "preparing", "running"].includes(task.status),
                    ) && (
                      <span class="transfer-badge">
                        {
                          transfer.tasks.filter((task) =>
                            ["queued", "preparing", "running"].includes(
                              task.status,
                            ),
                          ).length
                        }
                      </span>
                    )}
                  </button>
                )
              }
              actions={topbarActions}
              intakeAction={!mobile && intakeAction}
            />
            {library.mode === "home" && (
              <CategoryCards library={library} albumOpen={albumOpen} />
            )}
            {library.demoPreview && (
              <div class="demo-preview-note">
                <span>{t("library.demoPreview")}</span>
                <button class="text-button" onClick={library.endDemo}>
                  {t("library.backToSetup")}
                </button>
              </div>
            )}
            {route === "favorites" ? (
              <Favorites
                mobile={false}
                onClose={() => navigation.closeFavorites(false)}
                actions={headerActions(
                  "file-list",
                  listingActions(favoritesLibrary, records, mobile),
                )}
              >
                <FileBrowser
                  onGalleryItems={onGalleryItems}
                  library={favoritesLibrary}
                  records={records}
                  selected={selected}
                  onTouchSelection={onTouchSelection}
                  onDesktopSelection={onDesktopSelection}
                  onPreview={preview}
                  onSettings={showSettings}
                />
              </Favorites>
            ) : (
              <FileBrowser
                onGalleryItems={onGalleryItems}
                library={library}
                records={visibleRecords}
                selected={selected}
                onTouchSelection={onTouchSelection}
                onDesktopSelection={onDesktopSelection}
                listId={albumPresent ? "background-file-list" : "file-list"}
                onPreview={preview}
                onSettings={showSettings}
              />
            )}
            {mobile && intakeAction}
          </>
        )}
      </main>
      <MobileTabs library={library} />
      {albumPresent && (
        <PageDialog
          id="album-page-dialog"
          className="album-page-dialog"
          title={t("core.category.album")}
          backId="album-back"
          backLabel={t("library.backToHome")}
          open={albumOpen}
          animateEntry={!router.initial}
          onClose={navigation.closeAlbum}
          onExited={() => setAlbumMounted(false)}
          fallbackFocus=".category-album"
          actions={headerActions(
            "file-list",
            <AlbumOptionsMenu library={dialogAlbumLibrary} />,
          )}
        >
          <FileBrowser
            onGalleryItems={onGalleryItems}
            library={dialogAlbumLibrary}
            records={records}
            selected={selected}
            onTouchSelection={onTouchSelection}
            onDesktopSelection={onDesktopSelection}
            pageDialog
            onPreview={preview}
            onSettings={showSettings}
          />
          {!selected && !settings && feedback}
        </PageDialog>
      )}
      {mobile && (favoritesOpen || favoritesMounted) && (
        <Favorites
          mobile
          open={favoritesOpen}
          actions={headerActions(
            "file-list",
            listingActions(favoritesLibrary, records, mobile),
          )}
          onClose={() => navigation.closeFavorites(true)}
          onExited={() => setFavoritesMounted(false)}
        >
          <FileBrowser
            onGalleryItems={onGalleryItems}
            library={favoritesLibrary}
            onTouchSelection={onTouchSelection}
            onDesktopSelection={onDesktopSelection}
            records={records}
            selected={selected}
            onPreview={preview}
            onSettings={showSettings}
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
          returnTarget={previewReturnTarget}
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
          onEntered={onPreviewEntered}
          onExited={finishPreview}
          returnTarget={previewReturnTarget}
          feedback={settings ? null : feedback}
        />
      )}
      {settings && (
        <ConnectionDialog
          open={settings === "open"}
          fallbackFocus={myPage && !favoritesOpen ? "#my-settings" : undefined}
          onExited={() => setSettings(null)}
          backend={library.backend}
          gatewayTokenRequired={library.gatewayTokenRequired}
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
      {!selected &&
        !settings &&
        !albumPresent &&
        !(mobile && (favoritesOpen || favoritesMounted)) &&
        feedback}
    </div>
  );
}
