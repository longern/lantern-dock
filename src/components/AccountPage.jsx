import { t } from "../../shared/i18n.js";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { AdminEntry } from "./AdminEntry.jsx";
import { useSession } from "../hooks/useSession.jsx";
import { useRouter } from "../hooks/useRouter.jsx";
import { PageDialog } from "./PageDialog.jsx";
import { PageHeader } from "./PageHeader.jsx";

export function AccountPage({
  mobile,
  open,
  animateEntry,
  returnTo,
  onClose,
  onExited,
}) {
  const router = useRouter();
  const title = t("account.myAccount");
  const backLabel = t(
    returnTo === "/me"
      ? "library.backToMe"
      : returnTo === "/"
        ? "account.backToPublicFiles"
        : "account.backToPrevious",
  );
  const {
    identity,
    nas,
    ensureNAS,
    refreshIdentity,
    refreshNAS,
    login: beginLogin,
    logout: endLogin,
  } = useSession();
  const session = identity.status === "authenticated" ? identity : null;
  const account = nas.status === "ready" ? nas.account : null;
  const loading = identity.status === "loading";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const accountError =
    nas.status === "error"
      ? nas.error.kind === "session-expired"
        ? t("account.sessionExpired")
        : nas.error.kind === "offline"
          ? t("account.nasOffline")
          : nas.error.kind === "unauthorized"
            ? t("account.nasPermissionDenied")
            : nas.error.kind === "unconfigured"
              ? t("account.nasNotConfigured")
              : nas.error.message
      : "";
  const sessionFailure =
    identity.status === "error"
      ? identity.error.kind === "offline"
        ? t("account.sessionOffline")
        : identity.error.message
      : "";
  const loginRequest = useRef(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      if (loginRequest.current) {
        loginRequest.current.abort();
      }
    },
    [],
  );
  useLayoutEffect(() => {
    if (!open && loginRequest.current) {
      loginRequest.current.abort();
      loginRequest.current = null;
      setBusy(false);
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const query = new URLSearchParams(location.search);
    if (!query.has("error")) return;
    setError(query.get("error"));
    query.delete("error");
    const suffix = query.toString();
    router.navigate(`/account${suffix ? `?${suffix}` : ""}`, {
      replace: true,
      state: router.state,
    });
  }, [open, router.route.href]);
  useEffect(() => {
    if (identity.status === "authenticated") void ensureNAS();
  }, [identity.status, identity.user, ensureNAS]);
  const copy = async (value, successMessage) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(successMessage);
    } catch {
      setCopied(t("account.copyFailed"));
    }
  };
  const login = async () => {
    if (busy || loginRequest.current) return;
    const controller = new AbortController();
    loginRequest.current = controller;
    setBusy(true);
    setError("");
    try {
      await beginLogin(controller.signal);
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) {
        loginRequest.current = null;
        setError(err.message);
        setBusy(false);
      }
    }
  };
  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      await endLogin();
      if (mounted.current) setCopied("");
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const content = (
    <section class="account-content" aria-labelledby="account-title">
      <div class="my-account-summary account-profile">
        <span class="my-account-symbol" aria-hidden="true">
          <Icon name="user" />
        </span>
        <div class="my-account-copy">
          <h2>
            {session
              ? session.user.name || session.user.email || t("account.signedIn")
              : loading
                ? t("account.checkingAccount")
                : sessionFailure
                  ? t("account.sessionUnavailable")
                  : t("account.signInTitle")}
          </h2>
          {session?.user.name && session.user.email && (
            <p>{session.user.email}</p>
          )}
          {identity.status === "signed-out" && (
            <p>{t("account.signInDescription")}</p>
          )}
        </div>
      </div>
      {(error || sessionFailure) && (
        <p class="account-notice error" role="alert">
          {error || sessionFailure}
        </p>
      )}
      {session && (
        <>
          <div class="my-action-list">
            <dl class="account-details">
              <div>
                <dt>{t("account.siteRole")}</dt>
                <dd aria-live="polite">
                  {account
                    ? account.user.role === "admin"
                      ? t("account.administrator")
                      : t("account.standardUser")
                    : accountError
                      ? t("account.verificationUnavailable")
                      : t("account.checkingAccount")}
                </dd>
              </div>
            </dl>
            <details class="account-advanced">
              <summary class="my-list-button">
                <span>{t("account.accountDetails")}</span>
                <Icon name="chevron-down" />
              </summary>
              <dl class="account-details">
                <div>
                  <dt>{t("account.identityIssuer")}</dt>
                  <dd>{session.user.issuer}</dd>
                </div>
              </dl>
              <div class="account-identifier">
                <label class="form-label" for="account-sub">
                  {t("account.userSubject")}
                </label>
                <div class="account-copy">
                  <input id="account-sub" readOnly value={session.user.sub} />
                  <button
                    class="icon-button"
                    aria-label={t("account.copySubject")}
                    onClick={() =>
                      copy(session.user.sub, t("account.subjectCopied"))
                    }
                  >
                    <Icon name="copy" />
                  </button>
                </div>
              </div>
            </details>
          </div>
          {account && !account.administratorConfigured && (
            <div class="account-notice">
              <h2>{t("account.administratorMissing")}</h2>
              <p>{t("account.administratorInstructions")}</p>
              <label class="form-label" for="account-admins">
                {t("account.administratorValue")}
              </label>
              <textarea
                id="account-admins"
                readOnly
                rows={2}
                value={session.user.sub}
              />
              <button
                class="secondary-button"
                onClick={() =>
                  copy(session.user.sub, t("account.administratorCopied"))
                }
              >
                <Icon name="copy" />
                {t("account.copyAdministrator")}
              </button>
            </div>
          )}
          {accountError && (
            <div class="account-notice error">
              <p role="alert">{accountError}</p>
              <button
                class="secondary-button"
                disabled={busy}
                onClick={
                  nas.error.kind === "session-expired"
                    ? refreshIdentity
                    : refreshNAS
                }
              >
                {t(
                  nas.error.kind === "session-expired"
                    ? "account.checkAgain"
                    : "account.retryNAS",
                )}
              </button>
            </div>
          )}
        </>
      )}
      <p class="account-feedback" role="status" hidden={!copied}>
        {copied}
      </p>
      {identity.status === "signed-out" && (
        <button class="primary-button" disabled={busy} onClick={login}>
          <Icon name="user" />
          {busy ? t("account.redirectingToSignIn") : t("account.signIn")}
        </button>
      )}
      <div class="my-action-list">
        <AdminEntry id="account-admin-entry" />
        <button
          class="my-list-button"
          disabled={loading || busy}
          onClick={() => {
            setError("");
            void refreshIdentity();
          }}
        >
          <span class="my-list-icon">
            <Icon name="refresh" />
          </span>
          <span>{t("account.checkAgain")}</span>
        </button>
      </div>
      {session && (
        <div class="my-action-list">
          <button
            class="my-list-button account-sign-out"
            disabled={busy}
            onClick={logout}
          >
            <span class="my-list-icon">
              <Icon name="logout" />
            </span>
            <span>{t("account.signOut")}</span>
          </button>
        </div>
      )}
    </section>
  );
  return mobile ? (
    <PageDialog
      id="account-dialog"
      titleId="account-title"
      title={title}
      backId="account-back"
      backLabel={backLabel}
      className="account-page"
      headerClassName="account-dialog-header"
      open={open}
      animateEntry={animateEntry}
      onClose={onClose}
      onExited={onExited}
      fallbackFocus="#my-account-link, #my-guest-button, .admin-account-link, .mobile-tabs [aria-current='page']"
    >
      {content}
    </PageDialog>
  ) : (
    <main class="account-page">
      <div class="account-header">
        <PageHeader
          className="account-bar"
          titleId="account-title"
          title={title}
          back={
            <a
              class="icon-button edge-start"
              href={returnTo}
              aria-label={backLabel}
            >
              <Icon name="chevron-left" />
            </a>
          }
        />
      </div>
      {content}
    </main>
  );
}
