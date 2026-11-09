import { t } from "../../shared/i18n.js";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useSession } from "../hooks/useSession.jsx";
import { Dialog } from "./Dialog.jsx";
import { Icon } from "./Icon.jsx";

export function SignInDialog({ open, onClose }) {
  const { login: beginLogin } = useSession();
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(open);
  const [error, setError] = useState("");
  const request = useRef(null);
  const redirecting = useRef(false);
  const current = useRef(null);
  current.current = { open, onClose };
  const cancel = () => {
    const controller = request.current;
    if (!controller) return;
    request.current = null;
    controller.abort();
  };
  const dismiss = () => {
    // Abort before the shared Dialog starts its exit animation.
    cancel();
    current.current.open = false;
    current.current.onClose();
  };
  useLayoutEffect(() => {
    if (!open) {
      cancel();
      return;
    }
    redirecting.current = false;
    setMounted(true);
    setBusy(false);
    setError("");
    // These also cover navigation which keeps MyPage mounted under Favorites.
    const events = ["lantern-dock:navigate", "popstate", "pagehide", "resize"];
    events.forEach((event) => window.addEventListener(event, dismiss));
    return () => {
      cancel();
      events.forEach((event) => window.removeEventListener(event, dismiss));
    };
  }, [open]);
  const login = async () => {
    if (!current.current.open || request.current || redirecting.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      await beginLogin(controller.signal);
      if (request.current === controller) {
        redirecting.current = true;
        request.current = null;
      }
    } catch (err) {
      if (controller.signal.aborted || request.current !== controller) return;
      cancel();
      setError(err?.message || t("account.signInFailed"));
      setBusy(false);
    }
  };
  if (!open && !mounted) return null;
  return (
    <Dialog
      id="sign-in-dialog"
      class="settings-dialog sign-in-dialog"
      open={open}
      onClose={dismiss}
      onExited={() => setMounted(false)}
      fallbackFocus="#my-guest-button"
      aria-labelledby="sign-in-title"
      aria-describedby="sign-in-description"
    >
      <div class="dialog-heading">
        <h2 id="sign-in-title">{t("account.signInTitle")}</h2>
        <button
          id="sign-in-close"
          type="button"
          class="icon-button"
          aria-label={t("account.closeSignIn")}
          onClick={dismiss}
        >
          <Icon name="x" />
        </button>
      </div>
      <p id="sign-in-description" class="dialog-intro">
        {t("account.signInDescription")}
      </p>
      {error && (
        <p class="account-notice error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p class="dialog-intro" role="status">
          {t("account.redirectingToSignIn")}
        </p>
      )}
      <div class="dialog-actions">
        <button
          id="sign-in-submit"
          type="button"
          class="primary-button"
          disabled={busy}
          onClick={login}
        >
          <Icon name="user" />
          {busy
            ? t("account.redirectingToSignIn")
            : error
              ? t("library.retry")
              : t("account.signIn")}
        </button>
      </div>
    </Dialog>
  );
}
