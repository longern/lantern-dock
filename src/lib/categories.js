import { t } from "../../shared/i18n.js";

export const fileCategories = [
  {
    kind: "album",
    get label() {
      return t("core.category.album");
    },
    icon: "album",
  },
  {
    kind: "video",
    get label() {
      return t("core.category.video");
    },
    icon: "camera",
  },
  {
    kind: "text",
    get label() {
      return t("core.category.text");
    },
    icon: "text",
  },
  {
    kind: "book",
    get label() {
      return t("core.category.book");
    },
    icon: "book",
  },
  {
    kind: "audio",
    get label() {
      return t("core.category.audio");
    },
    icon: "music",
  },
];

export function categoryLabel(kind) {
  return kind === "image"
    ? t("core.category.image")
    : fileCategories.find((category) => category.kind === kind)?.label;
}

const documentExtensions = new Set([
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
]);
const bookExtensions = new Set([
  "epub",
  "mobi",
  "azw",
  "azw3",
  "fb2",
  "djvu",
  "djv",
  "cbz",
  "cbr",
]);

// Categories filter the current directory, without changing preview support.
export function matchesCategory(item, kind) {
  if (!kind) return true;
  if (item.isDirectory) return false;
  if (kind === "album") return ["image", "video"].includes(item.kind);
  const extension = item.name.split(".").pop().toLowerCase();
  if (kind === "text")
    return (
      ["text", "pdf"].includes(item.kind) || documentExtensions.has(extension)
    );
  if (kind === "book") return bookExtensions.has(extension);
  return item.kind === kind;
}
