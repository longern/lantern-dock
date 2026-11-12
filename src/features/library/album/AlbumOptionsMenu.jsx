import { t } from "../../../../shared/i18n.js";
import { ListingOptionsMenu } from "../listing/ListingOptionsMenu.jsx";

export function AlbumOptionsMenu({ library }) {
  const refreshing = library.refreshing;
  const refreshLabel = t(
    refreshing ? "library.albumRefreshing" : "library.refresh",
  );
  return (
    <>
      <ListingOptionsMenu
        edge="end"
        label={t("library.albumOptions")}
        triggerIcon={refreshing ? "refresh" : "ellipsis"}
        triggerClassName={
          refreshing
            ? "icon-button listing-options-trigger album-refreshing"
            : undefined
        }
        groups={[
          {
            key: "view",
            label: t("library.albumView"),
            selected: library.albumView,
            change: library.setAlbumView,
            options: [
              ["date", t("library.albumDateView"), "clock"],
              ["continuous", t("library.albumContinuousView"), "grid"],
            ],
          },
        ]}
        actions={[
          {
            key: "refresh",
            label: refreshLabel,
            icon: "refresh",
            disabled:
              refreshing ||
              (library.loading && (!library.scope || !library.entries.length)),
            onSelect: library.refresh,
          },
        ]}
      />
      <span class="visually-hidden" role="status">
        {refreshing ? refreshLabel : ""}
      </span>
    </>
  );
}
