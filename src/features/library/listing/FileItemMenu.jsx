import { useRef } from "preact/hooks";
import { t } from "../../../../shared/i18n.js";
import { Menu } from "../../../components/Menu.jsx";

export function FileItemMenu({
  request,
  onDismiss,
  selection,
  records,
  library,
  recent,
  onDetails,
}) {
  const previous = useRef(null);
  if (request) previous.current = request;
  const context = request || previous.current;
  const items = context
    ? selection.items.some((item) => item.path === context.item.path)
      ? selection.items
      : [context.item]
    : [];
  const favorite = items.length > 0 && items.every(records.isFavorite);
  return (
    <Menu
      contextMenu={request}
      onDismiss={onDismiss}
      label={t("library.fileActions")}
      actions={[
        ...(items.length === 1
          ? [
              {
                key: "open",
                icon: "arrow-up-right",
                label: t("library.openFile"),
                // Reuse the item's activation, including its album/gallery context.
                onSelect: () => context.target.click(),
              },
            ]
          : []),
        {
          key: "download",
          icon: "download",
          label: t("library.download"),
          disabled:
            library.downloading || items.some((item) => item.isDirectory),
          onSelect: () => library.downloadMany(items),
        },
        {
          key: "favorite",
          icon: favorite ? "heart-filled" : "heart",
          label: t(
            favorite ? "library.removeFavorites" : "library.addFavorites",
          ),
          onSelect: () => {
            const saved = records.setFavorites(items, !favorite);
            if (saved && favorite && library.mode === "favorites")
              selection.list.current?.focus({ preventScroll: true });
          },
        },
        {
          key: "copy",
          icon: "copy",
          label: t("library.copyLink"),
          onSelect: () => library.copyLinks(items),
        },
        ...(items.length === 1
          ? [
              {
                key: "details",
                icon: "info",
                label: t("library.mediaDetails"),
                onSelect: () => onDetails(items[0]),
              },
            ]
          : []),
        ...(recent
          ? [
              {
                key: "forget",
                icon: "x",
                label: t("library.removeFromRecent"),
                onSelect: () => {
                  if (records.forgetRecent(items.map((item) => item.path)))
                    selection.list.current?.focus({ preventScroll: true });
                },
              },
            ]
          : []),
      ]}
    />
  );
}
