import { t } from "../../../../shared/i18n.js";
import { Fragment } from "preact";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { Icon } from "../../../components/Icon.jsx";
import { artwork } from "../../../lib/demo.js";
import { bytes, date } from "../../../lib/format.js";
import { Thumbnail } from "./Thumbnail.jsx";
import { fileListing } from "../../../lib/file-listing.js";
import { Album } from "../album/Album.jsx";
import { useFileSelection } from "./useFileSelection.js";
import { SelectionActions } from "./SelectionActions.jsx";
import { FileItemMenu } from "./FileItemMenu.jsx";
import { FileDetails } from "../preview/FileDetails.jsx";
import { AlbumPaging, AlbumIndexStatus } from "../album/AlbumPaging.jsx";

const noEntries = [];

function FileItem({
  item,
  demo,
  client,
  side,
  selected,
  recent,
  selection,
  onOpen,
}) {
  const thumbnail = useRef(null);
  return (
    <li
      class={`file-item${item.isDirectory ? " folder-item" : ""}${selected || selection.isSelected(item) ? " selected" : ""}`}
      data-selected={selection.isSelected(item) ? "true" : undefined}
    >
      <button
        class="file-open"
        data-path={item.path}
        aria-label={t(
          item.isDirectory ? "library.openFolderNamed" : "library.previewNamed",
          { name: item.name },
        )}
        aria-pressed={
          selection.isSelected(item) || (!item.isDirectory && selected)
        }
        {...selection.props(item, (entry) => onOpen(entry, thumbnail.current))}
      >
        <span class={`file-art ${item.kind}`}>
          {demo && item.kind === "image" ? (
            <img
              src={`data:image/svg+xml,${encodeURIComponent(artwork(item.name))}`}
              alt=""
            />
          ) : (
            <>
              <Icon name={item.kind} />
              {["image", "video"].includes(item.kind) && (
                <Thumbnail
                  item={item}
                  client={client}
                  side={side}
                  imageRef={thumbnail}
                />
              )}
              {!item.isDirectory && (
                <span class="extension">
                  {item.name.split(".").pop().slice(0, 6).toUpperCase()}
                </span>
              )}
            </>
          )}
        </span>
        <span class="file-info">
          <span class="file-name" title={item.name}>
            {item.name}
          </span>
          <span class="file-meta">
            <span>
              {item.isDirectory ? t("library.folder") : bytes(item.size)}
            </span>
            <span class="file-meta-date">
              <span aria-hidden="true">·</span>
              <span>{date(recent ? item.visitedAt : item.modified)}</span>
            </span>
          </span>
        </span>
        <span class="row-modified">
          {date(recent ? item.visitedAt : item.modified, true)}
        </span>
        <span class="row-size">
          {item.isDirectory ? "—" : bytes(item.size)}
        </span>
      </button>
      {selection.touch && (
        <span
          class={`selection-mark${selection.isSelected(item) ? " checked" : ""}`}
          aria-hidden="true"
        >
          {selection.isSelected(item) && <Icon name="check" />}
        </span>
      )}
    </li>
  );
}

export function FileBrowser({
  library,
  records,
  selected,
  onPreview,
  onSettings,
  onTouchSelection,
  onDesktopSelection,
  onGalleryItems,
  listId = "file-list",
  pageDialog = false,
}) {
  const {
    entries,
    recent,
    album,
    usesDirectory,
    view,
    recordsPending,
    recordsError,
  } = useMemo(
    () => fileListing(library, records),
    [
      library.entries,
      records.favorites,
      records.recent,
      records.recentStatus,
      records.recentError,
      records.favoritesStatus,
      records.favoritesError,
      library.mode,
      library.kind,
      library.query,
      library.sort,
      library.view,
    ],
  );
  const home = library.mode === "home";
  const card = home || (library.mode === "all" && !album);
  const Collection = album ? "div" : "ul";
  const error =
    recordsError || (usesDirectory || recordsPending ? library.error : null);
  const busy = !error && (recordsPending || (library.loading && usesDirectory));
  const [albumOrder, setAlbumOrder] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [details, setDetails] = useState(null);
  useLayoutEffect(() => {
    setContextMenu(null);
    setDetails(null);
  }, [library.key, library.mode, library.path, library.kind, library.query]);
  const openDetails = (item) => setDetails({ item, open: true });
  const onAlbumItems = useCallback(
    (items) =>
      setAlbumOrder((current) =>
        current?.source === entries && current.items === items
          ? current
          : { source: entries, items },
      ),
    [entries],
  );
  const selectable = error
    ? noEntries
    : album
      ? albumOrder?.source === entries
        ? albumOrder.items
        : noEntries
      : entries;
  useLayoutEffect(() => {
    if (!album || !library.scope || albumOrder?.source !== entries) return;
    onGalleryItems?.({
      scope: library.scope,
      items: albumOrder.items,
      hasMore: library.hasMore,
      loadingMore: library.loadingMore,
      pageError: library.pageError,
      loadMore: library.loadMore,
    });
  }, [
    album,
    library.scope,
    albumOrder,
    entries,
    library.hasMore,
    library.loadingMore,
    library.pageError,
    library.loadMore,
    onGalleryItems,
  ]);
  const selection = useFileSelection(
    selectable,
    JSON.stringify([
      library.key,
      library.mode,
      library.path,
      library.kind,
      library.query,
    ]),
    onTouchSelection,
    library.copyLinks,
    setContextMenu,
    { openOnClick: album },
  );
  const actionsOwner = useRef(Symbol("desktop-selection"));
  // Publish meaningful selection changes, while the header reads fresh callbacks
  // from this ref without creating a parent/list render feedback loop.
  const actions = useRef(null);
  actions.current = {
    selection,
    entries: selectable,
    records,
    onCopyLinks: library.copyLinks,
    onDownload: library.downloadMany,
    downloading: library.downloading,
    favoritesPage: library.mode === "favorites",
    onDetails: openDetails,
  };
  useLayoutEffect(() => {
    onDesktopSelection?.(
      actionsOwner.current,
      selection.mode === "desktop" ? { listId, props: actions } : null,
    );
    return () => onDesktopSelection?.(actionsOwner.current, null);
  }, [
    onDesktopSelection,
    listId,
    selection.mode,
    selection.items,
    records.favorites,
    library.downloading,
    library.mode,
  ]);
  return (
    <section
      class={`content${card ? " collection-card" : ""}${home ? " home-content" : ""}${album ? " album-content" : ""}${selection.touch ? " touch-selecting" : ""}`}
      aria-label={t("library.fileBrowser")}
      onKeyDown={selection.keyDown}
      onPointerDown={(event) => {
        if (
          event.pointerType === "mouse" &&
          !event.target.closest(
            "button,.file-item,.selection-actions,[role='menu']",
          )
        )
          selection.clear(false);
      }}
    >
      {album && !pageDialog && (
        <div class="album-heading">
          <h1>{t("library.photos")}</h1>
        </div>
      )}
      {home && recent && (
        <h2 class="file-section-title">{t("library.recentFiles")}</h2>
      )}
      {error && (
        <div class="empty-state">
          <span class="empty-symbol">
            <Icon name="cloud-off" />
          </span>
          <h2>
            {recordsError
              ? t(
                  library.mode === "favorites"
                    ? "library.favoritesUnavailable"
                    : "library.recentFilesUnavailable",
                )
              : t("library.filesUnavailable")}
          </h2>
          <p>
            {recordsError ? recordsError.message : t("library.retryConnection")}
          </p>
          <div class="empty-actions">
            <button
              class="primary-button"
              onClick={recordsError ? records.retry : library.reconnect}
              disabled={!recordsError && library.loading}
            >
              <Icon name="refresh" />
              {t("library.retry")}
            </button>
            <button
              class="secondary-button"
              onClick={
                recordsError ? () => library.selectMode("all") : onSettings
              }
            >
              {recordsError
                ? t("library.viewFiles")
                : t("library.connectionSettings")}
            </button>
          </div>
        </div>
      )}
      <div
        class="list-head"
        hidden={
          album || view !== "list" || !!error || (!busy && !entries.length)
        }
      >
        <span>{t("library.fileName")}</span>
        <span>
          {recent ? t("library.accessedAt") : t("library.modifiedAt")}
        </span>
        <span>{t("library.size")}</span>
      </div>
      {album && <AlbumIndexStatus library={library} />}
      <Collection
        ref={selection.list}
        tabIndex={-1}
        id={listId}
        role={album ? undefined : "list"}
        class={
          album
            ? "album-timeline"
            : `file-grid${view === "list" ? " list-layout" : ""}`
        }
        aria-live="polite"
        aria-busy={busy}
        aria-label={
          album
            ? t("library.album")
            : recent
              ? t("library.recentFileList")
              : t("library.fileList")
        }
      >
        {album ? (
          <Album
            pagination={
              library.scope
                ? {
                    scope: library.scope,
                    hasMore: library.hasMore,
                    loadingMore: library.loadingMore,
                    pageError: library.pageError,
                    loadMore: library.loadMore,
                  }
                : undefined
            }
            view={library.albumView}
            entries={error ? noEntries : entries}
            loading={busy}
            client={library.connection?.client}
            demo={library.backend?.transport === "demo"}
            selected={selected}
            selection={selection}
            onItemsChange={onAlbumItems}
            onPreview={onPreview}
          />
        ) : busy && !entries.length ? (
          Array.from({ length: 8 }, (_, index) => (
            <li class="skeleton" key={index} aria-hidden="true" />
          ))
        ) : (
          entries.map((item, index) => (
            <Fragment key={item.path}>
              {view === "list" && index > 0 && (
                <li class="file-divider" role="presentation" aria-hidden="true">
                  <hr />
                </li>
              )}
              <FileItem
                item={item}
                client={library.connection?.client}
                side={view === "list" ? 128 : 384}
                demo={library.backend?.transport === "demo"}
                selected={selected?.path === item.path}
                selection={selection}
                recent={recent}
                onOpen={(item, thumbnail) =>
                  item.isDirectory
                    ? library.navigate(item.path)
                    : onPreview(item, null, thumbnail)
                }
              />
            </Fragment>
          ))
        )}
      </Collection>
      {album && <AlbumPaging library={library} />}
      {selection.touch && (
        <SelectionActions
          selection={selection}
          entries={selectable}
          records={records}
          onCopyLinks={library.copyLinks}
          onDownload={library.downloadMany}
          downloading={library.downloading}
          favoritesPage={library.mode === "favorites"}
          onDetails={openDetails}
        />
      )}
      {!busy &&
        !entries.length &&
        !error &&
        !(album && ["scanning", "error"].includes(library.indexState)) && (
          <div class="empty-state">
            <span class="empty-symbol">
              <Icon
                name={
                  library.query
                    ? "search"
                    : library.mode === "favorites"
                      ? "star"
                      : recent
                        ? "clock"
                        : "folder"
                }
              />
            </span>
            <h2>
              {library.query
                ? t("library.noMatchingFiles")
                : library.mode === "favorites"
                  ? t("library.noFavorites")
                  : recent
                    ? t("library.noRecentFiles")
                    : t("library.noFiles")}
            </h2>
            <p>
              {library.query
                ? t("library.tryKeywords")
                : library.mode === "favorites"
                  ? t("library.favoritesHint")
                  : recent
                    ? t("library.recentFilesHint")
                    : library.kind
                      ? t("library.noFilesOfType")
                      : t("library.emptyFolderHint")}
            </p>
            {library.query && (
              <button
                class="secondary-button"
                onClick={() => library.setQuery("")}
              >
                {t("library.clearSearch")}
              </button>
            )}
            {!library.query && library.kind && (
              <button
                class="secondary-button"
                onClick={() => library.selectMode("all")}
              >
                {t("library.viewAllFiles")}
              </button>
            )}
            {!library.query && !usesDirectory && (
              <span class="empty-footnote">
                {t("library.localRecordsNote")}
              </span>
            )}
          </div>
        )}
      <FileItemMenu
        request={contextMenu}
        onDismiss={() => setContextMenu(null)}
        selection={selection}
        records={records}
        library={library}
        recent={recent}
        onDetails={openDetails}
      />
      {details && (
        <FileDetails
          item={details.item}
          client={library.connection.client}
          open={details.open}
          onClose={() => setDetails((value) => ({ ...value, open: false }))}
          onExited={() => setDetails(null)}
          fallbackFocus={`#${listId}`}
        />
      )}
    </section>
  );
}
