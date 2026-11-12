import { t } from "../../../shared/i18n.js";
import { Icon } from "../../components/Icon.jsx";
import { useEffect, useRef, useState } from "preact/hooks";
import { Dialog } from "../../components/Dialog.jsx";

export function RevokeDialog({ client, link, onExit, onRevoked, onError }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      request.current?.abort();
    },
    [],
  );
  const close = () => {
    if (!request.current) setOpen(false);
  };
  const revoke = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      await client.revoke(link.id, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      onRevoked();
      setOpen(false);
    } catch (err) {
      if (!alive.current || controller.signal.aborted) return;
      setError(err.message || t("admin.requestFailed"));
      onError(err);
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Dialog
      class="settings-dialog action-dialog"
      id="admin-revoke-dialog"
      open={open}
      onClose={close}
      onExited={onExit}
      fallbackFocus="#admin-create-link"
      aria-labelledby="admin-revoke-title"
      aria-describedby="admin-revoke-description"
    >
      <div class="dialog-heading">
        <h2 id="admin-revoke-title">{t("admin.revokeTitle")}</h2>
        <button
          class="icon-button"
          disabled={busy}
          onClick={close}
          aria-label={t("admin.close")}
        >
          <Icon name="x" />
        </button>
      </div>
      <p class="admin-revoke-name">{link.title}</p>
      <p class="dialog-intro" id="admin-revoke-description">
        {t("admin.revokeDescription")}
      </p>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" class="admin-form-hint">
          {t("admin.revoking")}
        </p>
      )}
      <div class="dialog-actions">
        <button
          autofocus
          class="secondary-button"
          disabled={busy}
          onClick={close}
        >
          {t("admin.cancel")}
        </button>
        <button
          class="primary-button admin-revoke-submit"
          disabled={busy}
          onClick={revoke}
        >
          {t(busy ? "admin.revoking" : "admin.confirmRevoke")}
        </button>
      </div>
    </Dialog>
  );
}
