import { t } from "../../shared/i18n.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { AdminEntry } from "./AdminEntry.jsx";
import { useSession } from "../hooks/useSession.jsx";
import { useRouter } from "../hooks/useRouter.jsx";
import { safeReturnPath } from "../../shared/routes.js";

export function AccountPage() {
  const router = useRouter();
  const [returnTo] = useState(() =>
    safeReturnPath(new URLSearchParams(location.search).get("return"), "/"),
  );
  const returnToMe = returnTo === "/me";
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
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.has("error")) {
      setError(query.get("error"));
      query.delete("error");
    }
    const suffix = query.toString();
    router.navigate(`/account${suffix ? `?${suffix}` : ""}`, {
      replace: true,
      state: router.state,
    });
  }, []);
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
  return (
    <main class="setup-page account-page">
      <a class="setup-brand" href={returnTo}>
        <span class="brand-symbol">
          <Icon name="portal" />
        </span>
        <span>LanternDock</span>
      </a>
      <section class="setup-card" aria-labelledby="account-title">
        <div class="setup-intro">
          <span class="setup-eyebrow">{t("account.myAccount")}</span>
          <h1 id="account-title">
            {session
              ? session.user.name || t("account.signedIn")
              : loading
                ? t("account.checkingAccount")
                : sessionFailure
                  ? t("account.sessionUnavailable")
                  : t("account.signInTitle")}
          </h1>
          {identity.status === "signed-out" && (
            <p>{t("account.signInDescription")}</p>
          )}
        </div>
        {(loading || nas.status === "loading") && (
          <p class="upload-message" role="status">
            {t("account.checkingAccount")}
          </p>
        )}
        {(error || sessionFailure) && (
          <p class="account-notice error" role="alert">
            {error || sessionFailure}
          </p>
        )}
        {session && (
          <>
            <dl class="account-details">
              {session.user.email && (
                <div>
                  <dt>{t("account.email")}</dt>
                  <dd>{session.user.email}</dd>
                </div>
              )}
              <div>
                <dt>{t("account.siteRole")}</dt>
                <dd>
                  {account
                    ? account.user.role === "admin"
                      ? t("account.administrator")
                      : t("account.standardUser")
                    : accountError
                      ? t("account.verificationUnavailable")
                      : t("account.verifying")}
                </dd>
              </div>
            </dl>
            <details
              class="account-advanced"
              open={!account?.administratorConfigured}
            >
              <summary>{t("account.accountDetails")}</summary>
              <dl class="account-details">
                <div>
                  <dt>{t("account.identityIssuer")}</dt>
                  <dd>{session.user.issuer}</dd>
                </div>
              </dl>
              <label class="form-label" for="account-sub">
                {t("account.userSubject")}
              </label>
              <div class="account-copy">
                <input id="account-sub" readOnly value={session.user.sub} />
                <button
                  class="secondary-button"
                  onClick={() =>
                    copy(session.user.sub, t("account.subjectCopied"))
                  }
                >
                  <Icon name="copy" />
                  {t("account.copySubject")}
                </button>
              </div>
            </details>
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
            {account?.user.role === "admin" && (
              <p class="account-notice">{t("account.administratorEnabled")}</p>
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
        {copied && (
          <p class="account-feedback" role="status">
            {copied}
          </p>
        )}
        <div class="account-actions">
          <AdminEntry id="account-admin-entry" className="secondary-button" />
          {identity.status === "signed-out" && (
            <button class="primary-button" disabled={busy} onClick={login}>
              <Icon name="user" />
              {busy ? t("account.redirectingToSignIn") : t("account.signIn")}
            </button>
          )}
          {session && (
            <button class="secondary-button" disabled={busy} onClick={logout}>
              <Icon name="logout" />
              {t("account.signOut")}
            </button>
          )}
          <button
            class="text-button"
            disabled={loading || busy}
            onClick={() => {
              setError("");
              void refreshIdentity();
            }}
          >
            {t("account.checkAgain")}
          </button>
          <a class="upload-back" href={returnTo}>
            {t(
              returnToMe
                ? "library.backToMe"
                : returnTo === "/"
                  ? "account.backToPublicFiles"
                  : "account.backToPrevious",
            )}
          </a>
        </div>
      </section>
    </main>
  );
}
