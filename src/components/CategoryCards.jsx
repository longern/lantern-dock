import { t } from "../../shared/i18n.js";
import { Icon } from "./Icon.jsx";
import { fileCategories } from "../lib/categories.js";

export function CategoryCards({ library }) {
  return (
    <nav class="category-cards" aria-label={t("library.fileCategories")} title={t("library.filterCurrentFolder")}>
      {fileCategories.map(({ kind, label, icon }) => (
        <button
          key={kind}
          type="button"
          class={`category-card${kind === "album" ? " category-album" : ""}`}
          aria-controls="file-list"
          onClick={() => library.selectMode("all", kind)}
        >
          <Icon name={icon} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
