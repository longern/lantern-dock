export function readRecords(key, suffix, storage) {
  // The backend determines the namespace. No key means it is not known yet,
  // not that this backend has an empty history.
  if (!key) return { status: "pending", items: [], error: null };
  try {
    const raw = (storage || globalThis.localStorage).getItem(key + suffix);
    const items = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(items) || items.some((item) =>
      !item || typeof item.path !== "string" || typeof item.name !== "string"))
      throw new Error("Invalid local records");
    return { status: "ready", items, error: null };
  } catch {
    return {
      status: "error",
      items: [],
      error: new Error("无法读取本机记录，请检查浏览器权限或稍后重试。"),
    };
  }
}
