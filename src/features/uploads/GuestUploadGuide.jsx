import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../../shared/i18n.js";
import { useSession } from "../../hooks/useSession.jsx";
import { clipboardUploadHref } from "../../lib/upload-link.js";
import { Toast } from "../../components/Toast.jsx";

export function GuestUploadGuide({ open, signedIn = false, onUploadLink }) {
  const { login } = useSession();
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [spinning, setSpinning] = useState(false);
  const toastTimer = useRef(null);
  const request = useRef(null);
  const current = useRef(open);
  current.current = open;
  useLayoutEffect(() => {
    if (!open) {
      request.current?.abort();
      setFeedback(null);
    }
    return () => {
      request.current?.abort();
      clearTimeout(toastTimer.current);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (busy !== "clipboard" || !open) {
      setSpinning(false);
      return;
    }
    const timer = setTimeout(() => setSpinning(true), 200);
    return () => clearTimeout(timer);
  }, [busy, open]);

  const notify = (text, error = false) => {
    clearTimeout(toastTimer.current);
    setFeedback({ text, error });
    toastTimer.current = setTimeout(
      () => {
        setFeedback((value) => value && { ...value, leaving: true });
        toastTimer.current = setTimeout(() => setFeedback(null), 200);
      },
      error ? 3000 : 2000,
    );
  };

  const act = async (action) => {
    if (!current.current || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(action);
    clearTimeout(toastTimer.current);
    setFeedback(null);
    try {
      if (action === "login") {
        await login(controller.signal);
        return;
      }
      const text = await navigator.clipboard.readText();
      if (controller.signal.aborted || !current.current) return;
      const href = clipboardUploadHref(text, location.origin);
      if (href) {
        onUploadLink(href);
        return;
      }
      notify(t("admin.uploadLinkNotFound"));
    } catch (err) {
      if (controller.signal.aborted || !current.current) return;
      notify(
        action === "login"
          ? err?.message || t("account.signInFailed")
          : t("admin.uploadClipboardUnavailable"),
        true,
      );
    }
    if (controller.signal.aborted || !current.current) return;
    request.current = null;
    setBusy("");
  };

  return (
    <div class="intake-guest-guide">
      <p id="intake-guest-status" class="intake-guest-status">
        {t(signedIn ? "admin.uploadMemberStatus" : "admin.uploadGuestStatus")}
      </p>
      <p id="intake-guest-description" class="intake-guest-description">
        {t(signedIn ? "admin.uploadMemberHelp" : "admin.uploadGuestHelp")}
      </p>
      <p class="intake-guest-hint">{t("admin.uploadClipboardHint")}</p>
      <div
        class="intake-guest-actions"
        data-single={signedIn ? "" : undefined}
        data-checking={busy === "clipboard" ? "" : undefined}
      >
        {!signedIn && (
          <button
            type="button"
            class="primary-button"
            disabled={!open || !!busy}
            onClick={() => act("login")}
          >
            {busy === "login"
              ? t("account.redirectingToSignIn")
              : t("admin.uploadSignIn")}
          </button>
        )}
        <button
          type="button"
          class={`${signedIn ? "primary-button" : "secondary-button"} intake-clipboard-button`}
          disabled={!open || !!busy}
          aria-busy={busy === "clipboard"}
          onClick={() => act("clipboard")}
        >
          {t("admin.uploadCheckClipboard")}
          <span
            class="intake-clipboard-spinner"
            data-visible={spinning ? "" : undefined}
            aria-hidden="true"
          />
        </button>
      </div>
      {feedback && <Toast message={feedback} position="center" />}
    </div>
  );
}
