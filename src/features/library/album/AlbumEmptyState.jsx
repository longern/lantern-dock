import { t } from "../../../../shared/i18n.js";
import { Icon } from "../../../components/Icon.jsx";

export function AlbumEmptyState({ library }) {
  const finding =
    library.loading || library.refreshing || library.indexState === "scanning";
  const failed =
    !library.refreshing &&
    (library.requestError || library.indexState === "error");
  const [title, description] = failed
    ? ["library.albumUnavailable", "library.albumRetryHint"]
    : finding
      ? ["library.albumFinding", "library.albumFindingHint"]
      : ["library.albumEmpty", "library.albumEmptyHint"];
  return (
    <div class="empty-state">
      <span class="empty-symbol" aria-hidden="true">
        {finding && !failed ? (
          <span class="page-loading-spinner" />
        ) : (
          <Icon name={failed ? "cloud-off" : "album"} />
        )}
      </span>
      <div role="status">
        <h2>{t(title)}</h2>
        <p>{t(description)}</p>
      </div>
      {failed && (
        <button class="secondary-button" onClick={library.refresh}>
          {t("library.retry")}
        </button>
      )}
    </div>
  );
}
