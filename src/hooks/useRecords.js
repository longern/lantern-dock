import { useMemo, useState } from "preact/hooks";

function read(key, suffix) {
  try {
    const records = JSON.parse(localStorage.getItem(key + suffix) || "[]");
    return Array.isArray(records)
      ? records.filter(
          (item) =>
            item &&
            typeof item.path === "string" &&
            typeof item.name === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function useRecords(key, toast) {
  const [revision, setRevision] = useState(0);
  const favorites = useMemo(
    () => (key ? read(key, "favorites") : []),
    [key, revision],
  );
  const recent = useMemo(
    () => (key ? read(key, "recent") : []),
    [key, revision],
  );
  const save = (suffix, items) => {
    if (!key) return;
    try {
      localStorage.setItem(key + suffix, JSON.stringify(items));
      setRevision((value) => value + 1);
    } catch {
      toast("浏览器未允许保存本机记录。", true);
    }
  };
  const isFavorite = (item) =>
    favorites.some((entry) => entry.path === item.path);
  return {
    favorites,
    recent,
    isFavorite,
    toggleFavorite(item) {
      const exists = isFavorite(item);
      save(
        "favorites",
        exists
          ? favorites.filter((entry) => entry.path !== item.path)
          : [item, ...favorites],
      );
      toast(exists ? "已取消收藏" : "已加入本机收藏");
    },
    remember(item) {
      save(
        "recent",
        [
          { ...item, visitedAt: Date.now() },
          ...read(key, "recent").filter((entry) => entry.path !== item.path),
        ].slice(0, 30),
      );
    },
  };
}
