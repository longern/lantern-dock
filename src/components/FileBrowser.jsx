import { t } from "../../shared/i18n.js";
import { useMemo } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { artwork } from "../lib/demo.js";
import { bytes, date } from "../lib/format.js";
import { Thumbnail } from "./Thumbnail.jsx";
import { categoryLabel } from "../lib/categories.js";
import { fileListing } from "../lib/file-listing.js";
import { Album } from "./Album.jsx";

function FileCard({
  item,
  demo,
  client,
  side,
  selected,
  favorite,
  recent,
  onOpen,
  onFavorite,
}) {
  return (
    <article
      class={`file-card${item.isDirectory ? " folder-card" : ""}${selected ? " selected" : ""}`}
    >
      <button
        class="file-open"
        data-path={item.path}
        aria-label={t(item.isDirectory ? "library.openFolderNamed" : "library.previewNamed", { name: item.name })}
        aria-pressed={item.isDirectory ? undefined : selected}
        onClick={() => onOpen(item)}
      >
        <div class={`file-art ${item.kind}`}>
          {demo && item.kind === "image" ? (
            <img
              src={`data:image/svg+xml,${encodeURIComponent(artwork(item.name))}`}
              alt=""
            />
          ) : (
            <>
              <Icon name={item.kind} />
              {["image", "video"].includes(item.kind) && (
                <Thumbnail item={item} client={client} side={side} />
              )}
              {!item.isDirectory && (
                <span class="extension">
                  {item.name.split(".").pop().slice(0, 6).toUpperCase()}
                </span>
              )}
            </>
          )}
        </div>
        <div class="file-info">
          <div class="file-name" title={item.name}>
            {item.name}
          </div>
          <div class="file-meta">
            <span>{item.isDirectory ? t("library.folder") : bytes(item.size)}</span>
            <span class="separator">·</span>
            <span>{date(recent ? item.visitedAt : item.modified)}</span>
          </div>
        </div>
        <span class="row-modified">
          {date(recent ? item.visitedAt : item.modified, true)}
        </span>
        <span class="row-size">
          {item.isDirectory ? "—" : bytes(item.size)}
        </span>
      </button>
      <button
        class={`favorite-button${favorite ? " selected" : ""}`}
        aria-label={t(favorite ? "library.unfavoriteNamed" : "library.favoriteNamed", { name: item.name })}
        aria-pressed={favorite}
        onClick={() => onFavorite(item)}
      >
        <Icon name="star" />
      </button>
    </article>
  );
}

export function FileBrowser({
  library,
  records,
  selected,
  onPreview,
  onSettings,
}) {
  const {
    entries, recent, album, usesDirectory, view, recordsPending, recordsError,
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
  const error = recordsError ||
    ((usesDirectory || recordsPending) ? library.error : null);
  const busy = !error && (recordsPending || (library.loading && usesDirectory));
  const status = recordsError
    ? t("library.recordsError")
    : library.error
      ? t("library.connectionError")
      : library.loading
        ? t("library.connecting")
        : library.backend?.transport === "demo"
          ? t("library.demoSpace")
          : t("library.connected");
  return (
    <section
      class={`content${home ? " home-content" : ""}${album ? " album-content" : ""}`}
      aria-label={t("library.fileBrowser")}
    >
      {album && (
        <div class="album-heading">
          <h1>{t("library.photos")}</h1>
        </div>
      )}
      <div class="file-toolbar">
        <div class="file-stats">
          {home && (
            <h2 class="file-section-title">{recent ? t("library.recentFiles") : t("library.files")}</h2>
          )}
          <strong id="item-count">
            {busy
              ? t("library.loading")
              : error
                ? t("library.readFailed")
                : t("library.itemCount", { count: entries.length })}
          </strong>
          {(recordsError ||
            library.error ||
            library.loading ||
            library.backend?.transport === "demo") && (
            <span
              class={`status-pill${recordsError || library.error ? " error" : library.loading ? " loading" : ""}`}
              role="status"
            >
              <i />
              <span>{status}</span>
            </span>
          )}
          {library.kind && (
            <button
              class="filter-chip"
              onClick={() => library.selectMode("all")}
              aria-label={t("library.clearTypeFilter")}
            >
              {categoryLabel(library.kind)}
              <Icon name="x" />
            </button>
          )}
        </div>
        {!recent && (
          <div class="view-tools">
            <button
              class="icon-button mobile-refresh"
              aria-label={t("library.refreshDirectory")}
              disabled={library.loading}
              aria-busy={library.loading}
              onClick={library.refresh}
            >
              <Icon name="refresh" />
            </button>
          </div>
        )}
      </div>
      {error && (
        <div class="empty-state">
          <span class="empty-symbol">
            <Icon name="cloud-off" />
          </span>
          <h2>{recordsError ? t(library.mode === "favorites" ? "library.favoritesUnavailable" : "library.recentFilesUnavailable") : t("library.filesUnavailable")}</h2>
          <p>{recordsError ? recordsError.message : t("library.retryConnection")}</p>
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
              onClick={recordsError ? () => library.selectMode("all") : onSettings}
            >
              {recordsError ? t("library.viewFiles") : t("library.connectionSettings")}
            </button>
          </div>
        </div>
      )}
      <div
        class="list-head"
        hidden={
          album ||
          view !== "list" ||
          !!error ||
          (!busy && !entries.length)
        }
      >
        <span>{t("library.fileName")}</span>
        <span>{recent ? t("library.accessedAt") : t("library.modifiedAt")}</span>
        <span>{t("library.size")}</span>
        <span />
      </div>
      <div
        id="file-list"
        class={album ? "album-timeline" : `file-grid${view === "list" ? " list-layout" : ""}`}
        aria-live="polite"
        aria-busy={busy}
        aria-label={album ? t("library.album") : recent ? t("library.recentFileList") : t("library.fileList")}
      >
        {album ? (
          <Album
            entries={error ? [] : entries}
            loading={busy}
            client={library.connection?.client}
            demo={library.backend?.transport === "demo"}
            selected={selected}
            onPreview={onPreview}
          />
        ) : busy && !entries.length
          ? Array.from({ length: 8 }, (_, index) => (
              <div class="skeleton" key={index} />
            ))
          : entries.map((item) => (
              <FileCard
                key={item.path}
                item={item}
                client={library.connection?.client}
                side={view === "list" ? 128 : 384}
                demo={library.backend?.transport === "demo"}
                selected={selected?.path === item.path}
                favorite={records.isFavorite(item)}
                recent={recent}
                onFavorite={records.toggleFavorite}
                onOpen={(item) =>
                  item.isDirectory
                    ? library.navigate(item.path)
                    : onPreview(item)
                }
              />
            ))}
      </div>
      {!busy && !entries.length && !error && (
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
            <span class="empty-footnote">{t("library.localRecordsNote")}</span>
          )}
        </div>
      )}
    </section>
  );
}
