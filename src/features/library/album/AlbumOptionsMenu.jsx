import { t } from "../../../../shared/i18n.js";
import { ListingOptionsMenu } from "../listing/ListingOptionsMenu.jsx";

export function AlbumOptionsMenu({ library }) {
  return (
    <ListingOptionsMenu
      edge="end"
      label={t("library.albumOptions")}
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
          label: t("library.refresh"),
          icon: "refresh",
          disabled: library.loading,
          onSelect: library.refresh,
        },
      ]}
    />
  );
}
