import { t } from "../../../shared/i18n.js";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { Sidebar, MobileTabs } from "./Navigation.jsx";
import { ConnectionDialog } from "../../components/ConnectionDialog.jsx";
import { TransferCenter } from "../../components/TransferCenter.jsx";
import { Toast } from "../../components/Toast.jsx";
import { SetupWizard } from "../setup/SetupWizard.jsx";
import { SelectionActions } from "./listing/SelectionActions.jsx";
import { FileIntakeActions } from "../uploads/FileIntakeActions.jsx";
import { useCompactLayout } from "../../hooks/useMediaQuery.js";
import { useLibrary } from "./useLibrary.js";
import { useRecords } from "./useRecords.js";
import { useDownload } from "../../hooks/useDownload.js";
import { useAdminNavigationGuard } from "../../hooks/useAdminNavigationGuard.js";
import { useTransferPanel } from "../../hooks/useTransferPanel.js";
import { useRouter } from "../../hooks/useRouter.jsx";
import { filesHref } from "../../../shared/routes.js";

import { useToast } from "../../hooks/useToast.js";
import { useLibrarySelection } from "./useLibrarySelection.js";
import { useLibraryPreview } from "./preview/useLibraryPreview.js";

import { listingActions } from "./listing/listingActions.jsx";
import { LibraryMain } from "./LibraryMain.jsx";
import { LibraryAlbumPage } from "./album/LibraryAlbumPage.jsx";
import { LibraryFavoritesPage } from "./LibraryFavoritesPage.jsx";
import { LibraryPreview } from "./preview/LibraryPreview.jsx";
import { useLibrarySurfaces } from "./useLibrarySurfaces.js";

export function LibraryApp() {
  const router = useRouter();
  const source = useLibrary();
  const mobile = useCompactLayout();
  const {
    navigation,
    route,
    library: listing,
    basePage,
    collectionPage,
    myPage,
    albumOpen,
    albumPresent,
    finishAlbum,
    favoritesOpen,
    favoritesPresent,
    finishFavorites,
    favoritesSort,
    setFavoritesSort,
  } = useLibrarySurfaces(source, mobile);
  const { message, toast, clearToast } = useToast();
  useEffect(() => {
    if (listing.error) toast(listing.error.message, true);
  }, [listing.error, toast]);
  const records = useRecords(listing.key, toast);
  const transfer = useDownload(listing.connection, records.rememberMany, toast);
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
  const previewState = useLibraryPreview({
    router,
    source,
    library: listing,
    records,
    route,
    mobile,
    albumPresent,
    toast,
    setSettings,
  });
  const {
    selected,
    setSelected,
    gallery,
    previewOpen,
    routeError,
    visibleRecords,
    onGalleryItems,
    preview,
    closePreview,
  } = previewState;
  useEffect(() => {
    if (listing.setup) {
      setSettings(null);
      clearToast();
    }
  }, [listing.setup]);
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
        listing.mode === "home"
      ) {
        event.preventDefault();
        document.getElementById("search")?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [selected, settings, listing.mode, myPage, albumPresent]);
  useEffect(() => {
    const stop = () => {
      transfer.cancel();
      listing.connection?.transport?.close();
    };
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, [listing.connection]);

  const showSettings = () => {
    setSettings("open");
  };
  const fileURL = (item, album) => {
    const root = (listing.connection?.client.root || "/").replace(/\/?$/, "/");
    return new URL(
      filesHref(item.path.slice(root.length), {
        directory: item.isDirectory,
        album: album && !item.isDirectory,
      }),
      location.origin,
    ).href;
  };
  const copyFileURLs = async (items, album, messageKey) => {
    try {
      const links = items.map((item) => fileURL(item, album));
      await navigator.clipboard.writeText(links.join("\n"));
      toast(t(messageKey, { count: items.length }));
    } catch {
      toast(t("library.copyLinkFailed"), true);
    }
  };
  const copyLink = (item) =>
    copyFileURLs([item], !!gallery, "library.linkCopied");
  const library = {
    ...listing,
    downloadMany: transfer.downloadMany,
    downloading: !!transfer.progress,
    copyLinks: (items) =>
      copyFileURLs(
        items,
        ["album", "image"].includes(listing.kind) || albumPresent,
        "library.linksCopied",
      ),
  };
  const listProps = {
    selected,
    onGalleryItems,
    onTouchSelection,
    onDesktopSelection,
    onPreview: preview,
    onSettings: showSettings,
  };
  const connect = (credentials) => {
    setSettings("closing");
    setSelected(null);
    clearToast();
    transfer.cancel();
    library.setCredentials(credentials);
  };
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
      <LibraryMain
        {...{
          library,
          basePage,
          collectionPage,
          route,
          myPage,
          mobile,
          albumOpen,
          albumPresent,
          routeError,
          closePreview,
          showSettings,
          topbarActions,
          intakeAction,
          transfer,
          transferPanel,
          listProps,
          visibleRecords,
        }}
        favorites={
          route === "favorites" &&
          !mobile && (
            <LibraryFavoritesPage
              library={library}
              records={records}
              headerActions={headerActions}
              listProps={listProps}
              sort={favoritesSort}
              setSort={setFavoritesSort}
              onClose={() => navigation.closeFavorites(false)}
            />
          )
        }
      />
      <MobileTabs library={library} />
      {albumPresent && (
        <LibraryAlbumPage
          library={library}
          source={source}
          open={albumOpen}
          animateEntry={!router.initial}
          onClose={navigation.closeAlbum}
          onExited={finishAlbum}
          headerActions={headerActions}
          listProps={listProps}
          records={records}
          feedback={!selected && !settings && feedback}
        />
      )}
      {favoritesPresent && (
        <LibraryFavoritesPage
          mobile
          open={favoritesOpen}
          library={library}
          records={records}
          headerActions={headerActions}
          listProps={listProps}
          sort={favoritesSort}
          setSort={setFavoritesSort}
          onClose={() => navigation.closeFavorites(true)}
          onExited={finishFavorites}
          feedback={!selected && !settings && feedback}
        />
      )}
      <LibraryPreview
        client={library.connection?.client}
        state={previewState}
        {...{ records, transfer, copyLink, fileURL, toast, feedback }}
        fileFeedback={settings ? null : feedback}
      />
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
      {!selected && !settings && !albumPresent && !favoritesPresent && feedback}
    </div>
  );
}
