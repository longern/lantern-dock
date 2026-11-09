import { useLayoutEffect, useRef } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { Icon } from "./Icon.jsx";

export function SelectionActions({
  selection,
  entries,
  records,
  onCopyLinks,
  onDownload,
  downloading,
  favoritesPage,
}) {
  const panel = useRef(null);
  const floating = selection.touch;
  const all = entries.length > 0 && selection.items.length === entries.length;
  const favorites =
    selection.items.length > 0 && selection.items.every(records.isFavorite);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!floating || !node) return;
    node.showPopover?.();
    return () => node.hidePopover?.();
  }, [floating]);
  return (
    <div
      ref={panel}
      popover={floating ? "manual" : undefined}
      class={`selection-actions${floating ? " selection-panel" : ""}`}
      role="toolbar"
      aria-label={t("library.selectionActions")}
    >
      {floating && (
        <div class="selection-panel-heading">
          <button
            class="icon-button"
            aria-label={t("library.cancelSelection")}
            onClick={() => selection.clear()}
          >
            <Icon name="x" />
          </button>
          <strong role="status">
            {t("library.selectedCount", { count: selection.items.length })}
          </strong>
          <button
            class="text-button"
            onClick={all ? selection.deselectAll : selection.selectAll}
          >
            {t(all ? "library.deselectAll" : "library.selectAll")}
          </button>
        </div>
      )}
      <div class="selection-commands">
        <button
          class={floating ? "selection-command" : "icon-button"}
          aria-label={t("library.downloadSelectedFiles")}
          title={
            selection.items.some((item) => item.isDirectory)
              ? t("library.downloadFilesOnly")
              : undefined
          }
          disabled={
            !selection.items.length ||
            downloading ||
            selection.items.some((item) => item.isDirectory)
          }
          onClick={() => {
            onDownload(selection.items);
            if (floating) selection.clear();
          }}
        >
          <Icon name="download" />
          {floating && <span>{t("library.download")}</span>}
        </button>
        <button
          class={floating ? "selection-command" : "icon-button"}
          aria-label={t(
            favorites
              ? "library.unfavoriteSelected"
              : "library.favoriteSelected",
          )}
          disabled={!selection.items.length}
          onClick={() => {
            const saved = records.setFavorites(selection.items, !favorites);
            // The selected rows and this toolbar disappear when unfavorited
            // here. Keep focus on the surviving list instead of the body.
            if (saved && favoritesPage && favorites)
              selection.list.current?.focus({ preventScroll: true });
          }}
        >
          <Icon name="star" />
          {floating && (
            <span>
              {t(
                favorites ? "library.removeFavorites" : "library.addFavorites",
              )}
            </span>
          )}
        </button>
        <button
          class={floating ? "selection-command" : "icon-button"}
          aria-label={t("library.copySelectedLinks")}
          disabled={!selection.items.length}
          onClick={() => onCopyLinks(selection.items)}
        >
          <Icon name="copy" />
          {floating && <span>{t("library.copyLinks")}</span>}
        </button>
        {!floating && (
          <button
            class="icon-button"
            aria-label={t("library.cancelSelection")}
            onClick={() => selection.clear()}
          >
            <Icon name="x" />
          </button>
        )}
      </div>
    </div>
  );
}
