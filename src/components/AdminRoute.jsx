import { lazy, Suspense } from "preact/compat";
import { useErrorBoundary } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { useCompactLayout } from "../hooks/useMediaQuery.js";
import { PageHeader } from "./PageHeader.jsx";
import { Icon } from "./Icon.jsx";

const AdminPage = lazy(() =>
  import("./AdminPage.jsx").then((module) => ({ default: module.AdminPage })),
);

function AdminStatus({ failed = false }) {
  const compact = useCompactLayout();
  return (
    <main class="route-status-page" aria-busy={!failed}>
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
        <p role={failed ? "alert" : "status"}>
          {t(failed ? "admin.loadFailed" : "admin.loading")}
        </p>
        {failed && (
          <button class="primary-button" onClick={() => location.reload()}>
            {t("library.retry")}
          </button>
        )}
      </div>
    </main>
  );
}

export function AdminRoute() {
  const [error] = useErrorBoundary();
  return error ? (
    <AdminStatus failed />
  ) : (
    <Suspense fallback={<AdminStatus />}>
      <AdminPage />
    </Suspense>
  );
}
