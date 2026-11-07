import { useMemo, useState } from "preact/hooks";
import { readRecords } from "../lib/records.js";

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
      toast("浏览器未允许保存本机记录。", true);
      return false;
    }
  };
  const isFavorite = (item) =>
    favorites.some((entry) => entry.path === item.path);
  return {
    favorites,
    recent,
    recentStatus: recentState.status,
    recentError: recentState.error,
    retry: () => setRevision((value) => value + 1),
    isFavorite,
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
      if (saved) toast(exists ? "已取消收藏" : "已收藏");
    },
    remember(item) {
      const current = readRecords(key, "recent");
      if (current.status !== "ready") {
        if (current.error) toast(current.error.message, true);
        return;
      }
      save(
        "recent",
        [
          { ...item, visitedAt: Date.now() },
          ...current.items.filter((entry) => entry.path !== item.path),
        ].slice(0, 30),
      );
    },
  };
}
