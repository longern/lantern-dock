import { t } from "../../../shared/i18n.js";
import { Icon } from "../../components/Icon.jsx";

export function CollectionStatus({
  collection,
  onRetry,
  emptyTitle,
  emptyDescription,
}) {
  if (collection.status === "loading")
    return (
      <p class="admin-empty" role="status">
        {t("admin.loading")}
      </p>
    );
  if (collection.status === "error")
    return (
      <div class="admin-empty error" role="alert">
        <p>{collection.error.message || t("admin.requestFailed")}</p>
        <button class="secondary-button" onClick={onRetry}>
          <Icon name="refresh" />
          {t("library.retry")}
        </button>
      </div>
    );
  if (!collection.items.length)
    return (
      <div class="admin-empty">
        <h3>{emptyTitle}</h3>
        <p>{emptyDescription}</p>
      </div>
    );
  return null;
}
export function Pagination({ collection }) {
  if (!collection.offset && collection.nextOffset === null) return null;
  return (
    <nav class="admin-pagination" aria-label={t("admin.pagination")}>
      <button
        class="secondary-button"
        disabled={collection.status === "loading" || !collection.offset}
        onClick={() =>
          collection.setOffset(Math.max(0, collection.offset - 100))
        }
      >
        <Icon name="chevron-left" />
        {t("admin.previous")}
      </button>
      <span>
        {t("admin.page", { page: Math.floor(collection.offset / 100) + 1 })}
      </span>
      <button
        class="secondary-button"
        disabled={
          collection.status !== "ready" ||
          collection.nextOffset === null ||
          collection.nextOffset <= collection.offset
        }
        onClick={() => collection.setOffset(collection.nextOffset)}
      >
        {t("admin.next")}
        <Icon name="chevron-right" />
      </button>
    </nav>
  );
}
