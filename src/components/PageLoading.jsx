import { t } from "../../shared/i18n.js";

export function PageLoading({ label = t("library.loading") }) {
  return (
    <main class="route-status-page page-loading" aria-busy="true">
      <div role="status">
        <span class="page-loading-spinner" aria-hidden="true" />
        <span class="visually-hidden">{label}</span>
      </div>
    </main>
  );
}
