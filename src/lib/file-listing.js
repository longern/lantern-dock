import { matchesCategory } from "./categories.js";

export function fileListing(library, records) {
  // Choose the source before filtering: an unmatched search must not replace
  // recent files with unrelated directory entries.
  const recent = library.mode === "home" &&
    (records.recentStatus !== "ready" || records.recent.length > 0);
  const recordsPending = recent && records.recentStatus === "pending";
  const recordsError = recent ? records.recentError : null;
  const usesDirectory = library.mode === "all" ||
    (library.mode === "home" && !recent);
  const source = recent
    ? records.recentStatus === "ready"
      ? records.recent
      : []
    : library.mode === "favorites"
      ? records.favorites
      : library.entries;
  const sort = recent ? "recent" : library.sort === "recent" ? "name" : library.sort;
  const entries = source
    .filter((item) => matchesCategory(item, library.kind) &&
      item.name.toLocaleLowerCase().includes(library.query.toLocaleLowerCase()))
    .sort((a, b) => {
      if (sort === "recent") return (b.visitedAt || 0) - (a.visitedAt || 0);
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (sort === "size") return (b.size || 0) - (a.size || 0);
      if (sort === "modified")
        return (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0);
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    });
  return { entries, recent, usesDirectory, sort, recordsPending, recordsError };
}
