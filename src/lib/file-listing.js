import { locale } from "../../shared/i18n.js";
import { matchesCategory } from "./categories.js";

export function listingPreferences(library, records) {
  // Choose the source before filtering: an unmatched search must not replace
  // recent files with unrelated directory entries.
  const recent =
    library.mode === "home" &&
    (records.recentStatus !== "ready" || records.recent.length > 0);
  const album = ["album", "image"].includes(library.kind);
  const sort = recent
    ? "recent"
    : library.sort === "recent"
      ? "name"
      : library.sort;
  // Recent files are always a list without overwriting the user's other view.
  const view = !recent && library.view === "grid" ? "grid" : "list";
  return { recent, album, sort, view };
}

export function fileListing(library, records) {
  const { recent, album, sort, view } = listingPreferences(library, records);
  const favorites = library.mode === "favorites";
  const recordsPending =
    (recent && records.recentStatus === "pending") ||
    (favorites && records.favoritesStatus === "pending");
  const recordsError = recent
    ? records.recentError
    : favorites
      ? records.favoritesError
      : null;
  const usesDirectory =
    library.mode === "all" || (library.mode === "home" && !recent);
  const source = recent
    ? records.recentStatus === "ready"
      ? records.recent
      : []
    : library.mode === "favorites"
      ? records.favorites
      : library.entries;
  const entries = source
    .filter(
      (item) =>
        matchesCategory(item, library.kind) &&
        item.name
          .toLocaleLowerCase(locale)
          .includes(library.query.toLocaleLowerCase(locale)),
    )
    .sort((a, b) => {
      if (sort === "recent") return (b.visitedAt || 0) - (a.visitedAt || 0);
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (sort === "size") return (b.size || 0) - (a.size || 0);
      if (sort === "modified")
        return (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0);
      return a.name.localeCompare(b.name, locale, { numeric: true });
    });
  return {
    entries,
    recent,
    album,
    usesDirectory,
    sort,
    view,
    recordsPending,
    recordsError,
  };
}
