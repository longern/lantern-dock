import { t } from "../../../../shared/i18n.js";
import { AlbumOptionsMenu } from "../album/AlbumOptionsMenu.jsx";
import { ListingOptionsMenu } from "./ListingOptionsMenu.jsx";
import { listingPreferences } from "../../../lib/file-listing.js";
// The route owner composes header actions from the same preferences as the
// listing. Headers only render their slot; children never mutate a shared header.
export function listingActions(library, records, compact) {
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
