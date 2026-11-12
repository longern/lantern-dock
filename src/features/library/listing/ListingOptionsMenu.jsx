import { t } from "../../../../shared/i18n.js";
import { Menu } from "../../../components/Menu.jsx";

export function ListingOptionsMenu({
  sort,
  view,
  onSortChange,
  onViewChange,
  groups: customGroups,
  label = t("library.listingOptions"),
  ...props
}) {
  const groups = customGroups || [
    {
      key: "sort",
      label: t("library.sort"),
      selected: sort,
      change: onSortChange,
      options: [
        ["name", t("library.name")],
        ["modified", t("library.modifiedAt")],
        ["size", t("library.size")],
      ],
    },
    {
      key: "view",
      label: t("library.viewMode"),
      selected: view,
      change: onViewChange,
      options: [
        ["list", t("library.listView"), "list"],
        ["grid", t("library.gridView"), "grid"],
      ],
    },
  ];
  return <Menu {...props} label={label} groups={groups} />;
}
