import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { createLinkInput, localDateTime } from "../lib/admin.js";
import { date } from "../lib/format.js";
import { Dialog } from "./Dialog.jsx";
import { dialogHeadingFocus } from "../lib/overlay-focus.js";
import { Icon } from "./Icon.jsx";

function UploadQR({ url }) {
  const canvas = useRef(null);
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    let active = true;
    import("qrcode")
      .then(({ default: encoder }) => {
        if (!active) return;
        return encoder.toCanvas(canvas.current, url, { width: 384, margin: 4 });
      })
      .then(
        () => {
          if (active) setStatus("ready");
        },
        () => {
          if (active) setStatus("error");
        },
      );
    return () => {
      active = false;
    };
  }, [url]);
  return (
    <div class="invite-qr">
      <canvas
        ref={canvas}
        role="img"
        aria-label={t("admin.scanCode")}
        hidden={status !== "ready"}
      />
      {status !== "ready" && (
        <p role="status">
          {t(status === "loading" ? "admin.loading" : "admin.qrFailed")}
        </p>
      )}
    </div>
  );
}

export function CreateLinkDialog({
  client,
  onExit,
  onCreated = () => {},
  onError,
  quick = false,
  preset = "",
}) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState("");
  const request = useRef(null);
  const mode = useRef("");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      request.current?.abort();
    },
    [],
  );
  const close = () => {
    if (request.current) return;
    // Clear the capability URL immediately, including during the exit animation.
    setResult((value) => value && { ...value, url: "" });
    setCopied("");
    setOpen(false);
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!open || request.current || result) return;
    setError("");
    setUncertain(false);
    let input;
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (quick) {
        mode.current =
          preset || (event.submitter?.value === "scan" ? "scan" : "share");
        const scan = mode.current === "scan";
        Object.assign(values, {
          title:
            values.title.trim() ||
            t(scan ? "admin.scanDrop" : "admin.shareDrop"),
          expiresAt: new Date(
            Date.now() + (scan ? 30 * 60000 : 72 * 3600000),
          ).toISOString(),
          maxFileMiB: 100,
          maxTotalMiB: 1024,
          maxFiles: 100,
        });
      }
      input = createLinkInput(values);
    } catch (err) {
      setError(err.message);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const value = await client.create(input, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setResult(value);
      onCreated();
      requestAnimationFrame(() =>
        document.getElementById("admin-copy-link")?.focus(),
      );
    } catch (err) {
      if (!alive.current || controller.signal.aborted) return;
      setError(err.message || t("admin.requestFailed"));
      // Never retry a potentially committed POST automatically.
      if (!err.status || err.status >= 500) {
        setUncertain(true);
        onCreated();
      }
      onError(err);
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const copy = async () => {
    if (!result?.url || !open) return;
    try {
      await navigator.clipboard.writeText(result.url);
      if (alive.current) setCopied(t("admin.linkCopied"));
    } catch {
      if (alive.current) setCopied(t("admin.copyFailed"));
    }
  };
  return (
    <Dialog
      class="settings-dialog admin-dialog"
      id="admin-create-dialog"
      open={open}
      onClose={close}
      onExited={onExit}
      fallbackFocus={quick ? "#file-intake-trigger" : "#admin-create-link"}
      aria-labelledby="admin-create-title"
    >
      <div class="dialog-heading" {...dialogHeadingFocus}>
        <h2 id="admin-create-title">
          {t(
            result
              ? "admin.linkCreated"
              : quick
                ? "admin.inviteUpload"
                : "admin.createLink",
          )}
        </h2>
        <button
          class="icon-button"
          disabled={busy}
          aria-label={t("admin.close")}
          onClick={close}
        >
          <Icon name="x" />
        </button>
      </div>
      {result ? (
        <div class="admin-created">
          {mode.current === "scan" && result.url && (
            <UploadQR url={result.url} />
          )}
          {quick && (
            <p>
              {t("admin.expires")}{" "}
              <time dateTime={result.link.expiresAt}>
                {date(result.link.expiresAt, true)}
              </time>
            </p>
          )}
          <p class="admin-once-warning">
            <Icon name="lock" />
            <span>{t("admin.oneTimeWarning")}</span>
          </p>
          <label class="form-label" for="admin-created-url">
            {t("admin.shareableLink")}
          </label>
          <textarea
            id="admin-created-url"
            readOnly
            rows={3}
            value={result.url}
            autoComplete="off"
            spellcheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
          <p>{t("admin.linkPrivacy")}</p>
          <div class="dialog-actions">
            <button id="admin-copy-link" class="primary-button" onClick={copy}>
              <Icon name="copy" />
              {t("admin.copyLink")}
            </button>
            <button class="secondary-button" onClick={close}>
              {t(quick ? "admin.done" : "admin.savedLink")}
            </button>
          </div>
          {copied && (
            <p class="account-feedback" role="status">
              {copied}
            </p>
          )}
        </div>
      ) : (
        <form onSubmit={submit}>
          <p class="dialog-intro">{t("admin.createDescription")}</p>
          <fieldset disabled={busy} class="admin-form-fields">
            <label class="form-label" for="admin-link-title">
              {t(quick ? "admin.optionalTitle" : "admin.linkTitle")}
            </label>
            <input
              id="admin-link-title"
              name="title"
              required={!quick}
              maxLength={200}
              autoComplete="off"
              placeholder={t("admin.titlePlaceholder")}
            />
            {!quick && (
              <>
                <label class="form-label" for="admin-link-expiry">
                  {t("admin.expiryLocal")}
                </label>
                <input
                  id="admin-link-expiry"
                  type="datetime-local"
                  name="expiresAt"
                  required
                  min={localDateTime()}
                  defaultValue={localDateTime(
                    new Date(Date.now() + 7 * 86400000),
                  )}
                />
                <div class="admin-form-grid">
                  <div>
                    <label class="form-label" for="admin-link-file-limit">
                      {t("admin.fileLimitMiB")}
                    </label>
                    <input
                      id="admin-link-file-limit"
                      type="number"
                      name="maxFileMiB"
                      min="0.01"
                      step="0.01"
                      required
                      defaultValue="100"
                    />
                  </div>
                  <div>
                    <label class="form-label" for="admin-link-total-limit">
                      {t("admin.totalLimitMiB")}
                    </label>
                    <input
                      id="admin-link-total-limit"
                      type="number"
                      name="maxTotalMiB"
                      min="0.01"
                      step="0.01"
                      required
                      defaultValue="1024"
                    />
                  </div>
                </div>
                <label class="form-label" for="admin-link-file-count">
                  {t("admin.maxFiles")}
                </label>
                <input
                  id="admin-link-file-count"
                  type="number"
                  name="maxFiles"
                  min="1"
                  max={Number.MAX_SAFE_INTEGER}
                  step="1"
                  required
                  defaultValue="100"
                />
                <p class="admin-form-hint">{t("admin.quotaNote")}</p>
              </>
            )}
            {quick && <p class="admin-form-hint">{t("admin.quickLimits")}</p>}
            {preset && (
              <p class="admin-form-hint">
                {t(
                  preset === "scan" ? "admin.scanExpiry" : "admin.shareExpiry",
                )}
              </p>
            )}
          </fieldset>
          {error && (
            <p class="admin-form-error" role="alert">
              {error}
            </p>
          )}
          {uncertain && (
            <p class="admin-form-error" role="alert">
              {t("admin.createUncertain")}
            </p>
          )}
          {busy && (
            <p role="status" class="admin-form-hint">
              {t("admin.creating")}
            </p>
          )}
          {quick && !preset ? (
            <div class="invite-choices">
              <button
                class="secondary-button"
                type="submit"
                value="scan"
                disabled={busy || uncertain}
              >
                <Icon name="qr-code" />
                <span>
                  {t("admin.scanDrop")}
                  <small>{t("admin.scanExpiry")}</small>
                </span>
              </button>
              <button
                class="secondary-button"
                type="submit"
                value="share"
                disabled={busy || uncertain}
              >
                <Icon name="copy" />
                <span>
                  {t("admin.shareDrop")}
                  <small>{t("admin.shareExpiry")}</small>
                </span>
              </button>
            </div>
          ) : (
            <div class="dialog-actions">
              <button
                class="primary-button"
                type="submit"
                disabled={busy || uncertain}
              >
                {t(busy ? "admin.creating" : "admin.createLink")}
              </button>
              <button
                class="secondary-button"
                type="button"
                disabled={busy}
                onClick={close}
              >
                {t("admin.cancel")}
              </button>
            </div>
          )}
        </form>
      )}
    </Dialog>
  );
}
