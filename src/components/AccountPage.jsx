import { t } from "../../shared/i18n.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import {
  identitySession,
  accountConnection,
  beginLogin,
  endLogin,
} from "../lib/identity.js";

export function AccountPage() {
  const [returnToMe] = useState(() => {
    const requested = new URLSearchParams(location.hash.split("?")[1] || "").get("return") === "me";
    try {
      // A local, allowlisted destination only. No identity or credentials are
      // persisted; this survives the existing identity-provider redirect.
      const pending = sessionStorage.getItem("lantern-dock:account-return");
      sessionStorage.removeItem("lantern-dock:account-return");
      return requested || pending === "me";
    } catch {
      return requested;
    }
  });
  const [session, setSession] = useState(null);
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [copied, setCopied] = useState("");
  const [revision, setRevision] = useState(0);
  const connection = useRef(null);
  const request = useRef(null);
  const loginRequest = useRef(null);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
    if (loginRequest.current) {
      loginRequest.current.abort();
      try { sessionStorage.removeItem("lantern-dock:account-return"); } catch { /* Optional navigation hint. */ }
    }
  }, []);
  useEffect(() => {
    const query = new URLSearchParams(location.hash.split("?")[1] || "");
    if (query.has("error")) {
      setError(query.get("error"));
      query.delete("error");
    }
    if (returnToMe) query.set("return", "me");
    const suffix = query.toString();
    history.replaceState(null, "", `#/account${suffix ? `?${suffix}` : ""}`);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setSession(null);
    setAccount(null);
    setAccountError("");
    (async () => {
      try {
        const value = await identitySession(controller.signal);
        if (controller.signal.aborted) return;
        setSession(value.authenticated ? value : null);
        if (value.authenticated) {
          try {
            const info = await accountConnection(controller.signal);
            if (controller.signal.aborted) {
              info.transport.close();
              return;
            }
            if (
              info.user.sub !== value.user.sub ||
              info.user.issuer !== value.user.issuer
            ) {
              info.transport.close();
              throw new Error(t("account.identityMismatch"));
            }
            connection.current = info.transport;
            setAccount(info);
          } catch (err) {
            if (!controller.signal.aborted) setAccountError(err.message);
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    const stop = () => connection.current?.close();
    window.addEventListener("pagehide", stop);
    return () => {
      controller.abort();
      stop();
      connection.current = null;
      window.removeEventListener("pagehide", stop);
    };
  }, [revision]);
  const copy = async (value, successMessage) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(successMessage);
    } catch {
      setCopied(t("account.copyFailed"));
    }
  };
  const login = async () => {
    const controller = new AbortController();
    loginRequest.current = controller;
    setBusy(true);
    setError("");
    try {
      try {
        if (returnToMe) sessionStorage.setItem("lantern-dock:account-return", "me");
      } catch { /* Sign-in still works when session storage is unavailable. */ }
      await beginLogin(controller.signal);
    } catch (err) {
      if (mounted.current) {
        try { sessionStorage.removeItem("lantern-dock:account-return"); } catch { /* Optional navigation hint. */ }
      }
      if (mounted.current && !controller.signal.aborted) {
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
      // Logout may finish after a user has returned to My. Refresh that real
      // session rather than leaving the account summary with the old identity.
      window.dispatchEvent(new Event("lantern-dock:session-changed"));
      if (!mounted.current) return;
      // Do not let a pending NAS response put the old identity back after logout.
      request.current?.abort();
      connection.current?.close();
      connection.current = null;
      setSession(null);
      setAccount(null);
      setAccountError("");
      setCopied("");
      setLoading(false);
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <main class="setup-page account-page">
      <a class="setup-brand" href={returnToMe ? "#/me" : "#/"}>
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
              : t("account.signInTitle")}
          </h1>
          {!session && <p>{t("account.signInDescription")}</p>}
        </div>
        {loading && (
          <p class="upload-message" role="status">
            {t("account.checkingAccount")}
          </p>
        )}
        {error && (
          <p class="account-notice error" role="alert">
            {error}
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
                  value={JSON.stringify([session.user.sub])}
                />
                <button
                  class="secondary-button"
                  onClick={() =>
                    copy(
                      JSON.stringify([session.user.sub]),
                      t("account.administratorCopied"),
                    )
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
              <p class="account-notice error" role="alert">
                {accountError}
              </p>
            )}
          </>
        )}
        {copied && (
          <p class="account-feedback" role="status">
            {copied}
          </p>
        )}
        <div class="account-actions">
          {!session && !loading && (
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
              setRevision((value) => value + 1);
            }}
          >
            {t("account.checkAgain")}
          </button>
          <a class="upload-back" href={returnToMe ? "#/me" : "#/"}>
            {t(returnToMe ? "library.backToMe" : "account.backToPublicFiles")}
          </a>
        </div>
      </section>
    </main>
  );
}
