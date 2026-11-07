import { Icon } from "./Icon.jsx";
import { fileCategories } from "../lib/categories.js";

export function CategoryCards({ library }) {
  return (
    <nav class="category-cards" aria-label="文件分类" title="筛选当前文件夹">
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
