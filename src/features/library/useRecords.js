import { t } from "../../../shared/i18n.js";
import { useMemo, useState } from "preact/hooks";
import { readRecords } from "../../lib/records.js";

export function useRecords(key, toast) {
  const [revision, setRevision] = useState(0);
  const favoriteState = useMemo(
    () => readRecords(key, "favorites"),
    [key, revision],
  );
  const recentState = useMemo(
    () => readRecords(key, "recent"),
    [key, revision],
  );
  const favorites = favoriteState.items;
  const recent = recentState.items;
  const save = (suffix, items) => {
    if (!key) return false;
    try {
      localStorage.setItem(key + suffix, JSON.stringify(items));
      setRevision((value) => value + 1);
      return true;
    } catch {
      toast(t("core.recordsSaveDenied"), true);
      return false;
    }
  };
  const isFavorite = (item) =>
    favorites.some((entry) => entry.path === item.path);
  const rememberMany = (items) => {
    const current = readRecords(key, "recent");
    if (current.status !== "ready") {
      if (current.error) toast(current.error.message, true);
      return;
    }
    const visitedAt = Date.now();
    const added = [...new Map(items.map((item) => [item.path, item])).values()]
      .slice(-30)
      .reverse();
    const paths = new Set(added.map((item) => item.path));
    save(
      "recent",
      [
        ...added.map((item) => ({ ...item, visitedAt })),
        ...current.items.filter((item) => !paths.has(item.path)),
      ].slice(0, 30),
    );
  };
  const removeRecent = (matches) => {
    const current = readRecords(key, "recent");
    if (current.status !== "ready") return false;
    const kept = current.items.filter((item) => !matches(item));
    return kept.length !== current.items.length && save("recent", kept);
  };
  return {
    favorites,
    favoritesStatus: favoriteState.status,
    favoritesError: favoriteState.error,
    recent,
    recentStatus: recentState.status,
    recentError: recentState.error,
    retry: () => setRevision((value) => value + 1),
    isFavorite,
    setFavorites(items, enabled) {
      const current = readRecords(key, "favorites");
      if (current.status !== "ready") {
        if (current.error) toast(current.error.message, true);
        return;
      }
      const paths = new Set(items.map((item) => item.path));
      const kept = current.items.filter((item) => !paths.has(item.path));
      const saved = save("favorites", enabled ? [...items, ...kept] : kept);
      if (saved)
        toast(
          t(
            enabled
              ? "library.favoritesAddedCount"
              : "library.favoritesRemovedCount",
            { count: items.length },
          ),
        );
      return saved;
    },
    toggleFavorite(item) {
      const current = readRecords(key, "favorites");
      if (current.status !== "ready") {
        if (current.error) toast(current.error.message, true);
        return;
      }
      const exists = current.items.some((entry) => entry.path === item.path);
      const saved = save(
        "favorites",
        exists
          ? current.items.filter((entry) => entry.path !== item.path)
          : [item, ...current.items],
      );
      if (saved)
        toast(exists ? t("core.favoriteRemoved") : t("core.favoriteAdded"));
    },
    rememberMany,
    remember: (item) => rememberMany([item]),
    forgetRecent(paths) {
      const removed = new Set(paths);
      return removeRecent((item) => removed.has(item.path));
    },
    reconcileRecent(directory, entries) {
      const present = new Set(entries.map((item) => item.path));
      return removeRecent((item) => {
        const path = item.path.replace(/\/$/, "");
        return (
          path.slice(0, path.lastIndexOf("/") + 1) === directory &&
          !present.has(item.path)
        );
      });
    },
  };
}
