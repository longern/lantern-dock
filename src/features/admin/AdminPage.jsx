import { useEffect } from "preact/hooks";
import { t } from "../../../shared/i18n.js";
import { useSession } from "../../hooks/useSession.jsx";
import { useCompactLayout } from "../../hooks/useMediaQuery.js";
import { useRouter } from "../../hooks/useRouter.jsx";
import { adminAccess } from "../../lib/admin.js";
import { accountHref } from "../../../shared/routes.js";
import { siteTitle } from "../../lib/site-title.js";
import { Icon } from "../../components/Icon.jsx";
import { PageHeader } from "../../components/PageHeader.jsx";
import { PageLoading } from "../../components/PageLoading.jsx";
import { AdminWorkspace } from "./AdminWorkspace.jsx";
import "../../styles/admin.css";

export function AdminPage() {
  const { identity, nas, ensureNAS, refreshIdentity, refreshNAS } =
    useSession();
  const mobile = useCompactLayout();
  const { route } = useRouter();
  useEffect(() => {
    if (identity.status === "authenticated") void ensureNAS();
  }, [identity.status, ensureNAS]);
  const access = adminAccess(identity, nas);
  if (access === "checking")
    return <PageLoading label={t("admin.gate.checking.title")} />;
  const ready = access === "ready";
  const capabilities = nas.account?.capabilities;
  const detail = ready && capabilities.adminUsers && route.member;
  const backLabel = t(
    detail
      ? "admin.users"
      : mobile
        ? "library.backToMe"
        : "account.backToPublicFiles",
  );
  const heading =
    !mobile || !capabilities?.adminUsers
      ? "admin.title"
      : detail
        ? "admin.uploadPermission"
        : route.tab === "users" && capabilities?.adminUsers
          ? "admin.users"
          : route.tab === "links"
            ? "admin.links"
            : "admin.title";
  return (
    <main
      class={`admin-page${ready ? " admin-ready" : ""}${detail ? " admin-detail" : ""}`}
    >
      <PageHeader
        className="admin-header"
        title={ready ? t(heading) : null}
        back={
          <a
            class="icon-button edge-start admin-back"
            aria-label={backLabel}
            href={detail ? "/admin/users" : mobile ? "/me" : "/"}
          >
            <Icon name="chevron-left" />
          </a>
        }
        actions={
          <a
            class="icon-button edge-end admin-account-link"
            aria-label={t("account.myAccount")}
            href={accountHref(location.pathname + location.search)}
          >
            <Icon name="user" />
          </a>
        }
      />
      {!ready && (
        <div class="admin-heading">
          <span class="admin-eyebrow">
            <Icon name="shield" />
            {siteTitle}
          </span>
          <h1>{t("admin.title")}</h1>
          <p>{t("admin.description")}</p>
        </div>
      )}
      {ready ? (
        <AdminWorkspace
          key={identity.user.issuer + ":" + identity.user.sub}
          account={nas.account}
          refreshNAS={refreshNAS}
          refreshIdentity={refreshIdentity}
        />
      ) : (
        <section class="admin-gate" aria-live="polite">
          <span class="admin-gate-icon">
            <Icon name={access === "nas-error" ? "cloud-off" : "lock"} />
          </span>
          <h2>{t(`admin.gate.${access}.title`)}</h2>
          <p>{t(`admin.gate.${access}.description`)}</p>
          {access === "signed-out" ? (
            <a
              class="primary-button"
              href={accountHref(location.pathname + location.search)}
            >
              {t("account.signIn")}
            </a>
          ) : (
            <button
              class="secondary-button"
              onClick={() =>
                void (access === "identity-error"
                  ? refreshIdentity()
                  : refreshNAS())
              }
            >
              <Icon name="refresh" />
              {t("account.checkAgain")}
            </button>
          )}
        </section>
      )}
    </main>
  );
}
