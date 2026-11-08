import { t } from "../../shared/i18n.js";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { identitySession } from "../lib/identity.js";
import { SignInDialog } from "./SignInDialog.jsx";
import { Icon } from "./Icon.jsx";

export function MyPage({ active = true, onFavorites, onSettings }) {
  const [state, setState] = useState({ status: "loading" });
  const [signInOpen, setSignInOpen] = useState(false);
  useLayoutEffect(() => {
    if (!active || state.status !== "signed-out") setSignInOpen(false);
  }, [active, state.status]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("lantern-dock:session-changed", refresh);
    return () => window.removeEventListener("lantern-dock:session-changed", refresh);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    identitySession(controller.signal).then((session) => {
      if (controller.signal.aborted) return;
      if (session.authenticated === true && session.user) {
        setState({ status: "authenticated", user: session.user });
      } else if (session.authenticated === false) {
        setState({ status: "signed-out" });
      } else {
        setState({ status: "error" });
      }
    }, () => {
      if (!controller.signal.aborted) setState({ status: "error" });
    });
    return () => controller.abort();
  }, [revision]);
  const signedIn = state.status === "authenticated";
  const title = state.status === "loading"
    ? t("account.checkingAccount")
    : state.status === "error"
      ? t("account.sessionUnavailable")
      : signedIn
        ? state.user.name || state.user.email || t("account.myAccount")
        : t("account.guest");
  return (
    <section id="my-page" class="my-page" aria-label={t("library.me")}>
      <section id="my-account" class="my-account" aria-label={t("account.myAccount")}
        aria-busy={state.status === "loading"} data-status={state.status}>
        {state.status === "signed-out" ? (
          <button id="my-guest-button" type="button" class="my-account-summary my-identity-control my-guest-button"
            aria-haspopup="dialog" aria-controls="sign-in-dialog" aria-expanded={signInOpen && active}
            onClick={() => setSignInOpen(true)}>
            <span class="my-account-symbol" aria-hidden="true"><Icon name="user" /></span>
            <span class="my-guest-title">{t("account.guest")}</span>
          </button>
        ) : signedIn ? (
          <a id="my-account-link" class="my-account-summary my-identity-control" href="#/account?return=me">
            <span class="my-account-symbol" aria-hidden="true"><Icon name="user" /></span>
            <div class="my-account-copy" aria-live="polite">
              <h2>{title}</h2>
              {state.user.name && state.user.email && <p>{state.user.email}</p>}
            </div>
          </a>
        ) : <div class="my-account-summary">
          <span class="my-account-symbol" aria-hidden="true"><Icon name="user" /></span>
          <div class="my-account-copy" aria-live="polite">
            <h2>{title}</h2>
            {state.status === "error" && <p>{t("account.sessionRetryHint")}</p>}
          </div>
        </div>}
        <div class="my-account-actions">
          {state.status === "error" && (
            <button id="my-account-retry" class="secondary-button" onClick={() => setRevision((value) => value + 1)}>
              <Icon name="refresh" />{t("library.retry")}
            </button>
          )}
        </div>
      </section>
      {active && state.status === "signed-out" && (
        <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} />
      )}
      <div class="my-action-list" aria-label={t("library.meActions")}>
        <button id="my-favorites" class="my-list-button" onClick={onFavorites} aria-haspopup="dialog">
          <span class="my-list-icon"><Icon name="star" /></span>
          <span>{t("library.myFavorites")}</span><Icon name="chevron-right" />
        </button>
        <button id="my-settings" class="my-list-button" onClick={onSettings} aria-haspopup="dialog">
          <span class="my-list-icon"><Icon name="settings" /></span>
          <span>{t("library.settings")}</span><Icon name="chevron-right" />
        </button>
      </div>
    </section>
  );
}
