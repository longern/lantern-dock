export const fileCategories = [
  { kind: "image", label: "相册", icon: "album" },
  { kind: "video", label: "视频", icon: "camera" },
  { kind: "text", label: "文档", icon: "text" },
  { kind: "book", label: "图书", icon: "book" },
  { kind: "audio", label: "音频", icon: "music" },
];

const documentExtensions = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
]);
const bookExtensions = new Set([
  "epub", "mobi", "azw", "azw3", "fb2", "djvu", "djv", "cbz", "cbr",
]);

// Categories filter the current directory, without changing preview support.
export function matchesCategory(item, kind) {
  if (!kind) return true;
  if (item.isDirectory) return false;
  const extension = item.name.split(".").pop().toLowerCase();
  if (kind === "text")
    return ["text", "pdf"].includes(item.kind) || documentExtensions.has(extension);
  if (kind === "book") return bookExtensions.has(extension);
  return item.kind === kind;
}
