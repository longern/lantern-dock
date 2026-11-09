import { t } from "../../shared/i18n.js";
import { Icon } from "./Icon.jsx";
import { fileCategories } from "../lib/categories.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";

export function CategoryCards({ library, albumOpen = false }) {
  const mobile = useMediaQuery("(max-width: 700px)");
  return (
    <nav class="category-cards" aria-label={t("library.fileCategories")} title={t("library.filterCurrentFolder")}>
      {fileCategories.map(({ kind, label, icon }) => (
        <button
          key={kind}
          type="button"
          class={`category-card${kind === "album" ? " category-album" : ""}`}
          aria-controls={mobile && kind === "album" ? "album-page-dialog" : "file-list"}
          aria-haspopup={mobile && kind === "album" ? "dialog" : undefined}
          aria-expanded={mobile && kind === "album" ? albumOpen : undefined}
          onClick={() => library.selectMode("all", kind)}
        >
          <Icon name={icon} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
