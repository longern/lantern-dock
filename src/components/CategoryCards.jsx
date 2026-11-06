import { Icon } from "./Icon.jsx";
import { fileCategories } from "../lib/categories.js";

export function CategoryCards({ library }) {
  return (
    <nav class="category-cards" aria-label="文件分类" title="筛选当前文件夹">
      {fileCategories.map(({ kind, label, icon }) => {
        const active = library.kind === kind;
        return (
          <button
            key={kind}
            type="button"
            class={`category-card${kind === "image" ? " category-album" : ""}`}
            aria-pressed={active}
            aria-controls="file-list"
            onClick={() => library.selectMode("all", active ? "" : kind)}
          >
            <Icon name={icon} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
