import { lazy, Suspense } from "preact/compat";
import { useErrorBoundary } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { useCompactLayout } from "../hooks/useMediaQuery.js";
import { PageHeader } from "./PageHeader.jsx";
import { Icon } from "./Icon.jsx";
import { PageLoading } from "./PageLoading.jsx";

const AdminPage = lazy(() =>
  import("../features/admin/AdminPage.jsx").then((module) => ({
    default: module.AdminPage,
  })),
);

function AdminLoadError() {
  const compact = useCompactLayout();
  return (
    <main class="route-status-page">
      <PageHeader
        title={t("admin.title")}
        back={
          <a
            class="icon-button edge-start"
            href={compact ? "/me" : "/"}
            aria-label={t(
              compact ? "library.backToMe" : "account.backToPublicFiles",
            )}
          >
            <Icon name="chevron-left" />
          </a>
        }
      />
      <div class="route-status-content">
        <p role="alert">{t("admin.loadFailed")}</p>
        <button class="primary-button" onClick={() => location.reload()}>
          {t("library.retry")}
        </button>
      </div>
    </main>
  );
}

export function AdminRoute() {
  const [error] = useErrorBoundary();
  return error ? (
    <AdminLoadError />
  ) : (
    <Suspense fallback={<PageLoading label={t("admin.loading")} />}>
      <AdminPage />
    </Suspense>
  );
}
