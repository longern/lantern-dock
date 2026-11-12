import { useEffect, useRef, useState } from "preact/hooks";
import { t, locale } from "../../shared/i18n.js";
import { createLinkInput, localDateTime } from "../lib/admin.js";
import { bytes, date } from "../lib/format.js";
import { Dialog } from "./Dialog.jsx";
import { dialogHeadingFocus } from "../lib/overlay-focus.js";
import { Icon } from "./Icon.jsx";
import { Toast } from "./Toast.jsx";
import { PageHeader } from "./PageHeader.jsx";

const MiB = 1024 * 1024;
const capacityOptions = (values) =>
  values.map((value) => ({ value, label: bytes(value * MiB) }));

function InvitationSelect({
  id,
  name,
  label,
  initial,
  options,
  dateTime = false,
}) {
  const [selected, setSelected] = useState(String(initial));
  return (
    <>
      <label class="invite-row invite-select-row" for={id}>
        <span>{label}</span>
        <select
          id={id}
          name={selected === "custom" ? undefined : name}
          value={selected}
          onChange={(event) => setSelected(event.currentTarget.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <option value="custom">{t("admin.invitationCustom")}</option>
        </select>
        <Icon name="chevron-down" />
      </label>
      {selected === "custom" && (
        <label class="invite-custom-field" for={id + "-custom"}>
          <span>
            {t(dateTime ? "admin.expiryLocal" : "admin.invitationCustomValue", {
              label,
            })}
          </span>
          <input
            id={id + "-custom"}
            name={dateTime ? "expiresAt" : name}
            type={dateTime ? "datetime-local" : "number"}
            inputMode={
              dateTime ? undefined : name === "maxFiles" ? "numeric" : "decimal"
            }
            required
            min={dateTime ? localDateTime() : name === "maxFiles" ? 1 : 0.01}
            step={dateTime ? 60 : name === "maxFiles" ? 1 : 0.01}
            max={
              dateTime
                ? undefined
                : name === "maxFiles"
                  ? Number.MAX_SAFE_INTEGER
                  : Number.MAX_SAFE_INTEGER / MiB
            }
            defaultValue={
              dateTime
                ? localDateTime(new Date(Date.now() + 7 * 86400000))
                : initial
            }
          />
          {!dateTime && name !== "maxFiles" && (
            <small>{t("admin.invitationCustomSizeUnit")}</small>
          )}
        </label>
      )}
    </>
  );
}

function UploadQR({ url }) {
  const canvas = useRef(null);
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    let active = true;
    import("qrcode")
      .then(({ default: encoder }) => {
        if (!active) return;
        const node = canvas.current;
        return encoder
          .toCanvas(node, url, { width: 384, margin: 4 })
          .then(() => {
            if (!active) return;
            // Keep a sharp bitmap while CSS controls its responsive display size.
            node.style.removeProperty("width");
            node.style.removeProperty("height");
          });
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
  invitation = null,
  onExit,
  onCreated = () => {},
  onError,
  fallbackFocus = "#admin-create-link",
}) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(!!invitation);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState(null);
  const [showQR, setShowQR] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [defaultTitle] = useState(() =>
    t("admin.invitationDefaultTitle", {
      date: new Intl.DateTimeFormat(locale, {
        month: "long",
        day: "numeric",
      }).format(new Date()),
    }),
  );
  const request = useRef(null);
  const shareRequest = useRef(false);
  const toastTimer = useRef(null);
  const alive = useRef(true);
  const current = useRef(true);
  const loadExisting = async () => {
    if (!invitation || !current.current || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const value = await client.share(invitation.id, controller.signal);
      if (!alive.current || !current.current || controller.signal.aborted)
        return;
      setResult(value);
      requestAnimationFrame(() => {
        if (current.current)
          document.getElementById("admin-copy-link")?.focus();
      });
    } catch (err) {
      if (!alive.current || !current.current || controller.signal.aborted)
        return;
      setError(err.message || t("admin.requestFailed"));
      if (err.status === 409 || err.status === 410) onCreated();
      onError?.(err);
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current && current.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (invitation) void loadExisting();
  }, [client, invitation?.id]);
  useEffect(
    () => () => {
      alive.current = false;
      current.current = false;
      request.current?.abort();
      clearTimeout(toastTimer.current);
    },
    [],
  );
  const notify = (text, error = false) => {
    if (!alive.current || !current.current) return;
    clearTimeout(toastTimer.current);
    setFeedback({ text, error });
    toastTimer.current = setTimeout(
      () => {
        setFeedback((value) => value && { ...value, leaving: true });
        toastTimer.current = setTimeout(() => setFeedback(null), 200);
      },
      error ? 4000 : 2000,
    );
  };
  const close = () => {
    if (!current.current || (request.current && !invitation)) return;
    current.current = false;
    request.current?.abort();
    // Keep the last frame through the exit animation. Unmounting in onExited
    // releases the link and presentation state without a visible reset.
    clearTimeout(toastTimer.current);
    setOpen(false);
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!current.current || request.current || result || uncertain) return;
    setError("");
    let input;
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (values.expiryHours) {
        const hours = Number(values.expiryHours);
        values.expiresAt =
          Number.isFinite(hours) && hours > 0
            ? new Date(Date.now() + hours * 3600000).toISOString()
            : "";
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
      requestAnimationFrame(() => {
        if (current.current)
          document.getElementById("admin-copy-link")?.focus();
      });
    } catch (err) {
      if (!alive.current || controller.signal.aborted) return;
      setError(err.message || t("admin.requestFailed"));
      // A lost acknowledgement may have committed the POST; never retry it automatically.
      if (!err.status || err.status >= 500) {
        setUncertain(true);
        onCreated();
      }
      onError?.(err);
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const copy = async (message = t("admin.linkCopied")) => {
    if (!result?.url || !current.current) return;
    try {
      await navigator.clipboard.writeText(result.url);
      notify(message);
    } catch {
      if (!alive.current || !current.current) return;
      setShowQR(false);
      notify(t("admin.copyFailed"), true);
      requestAnimationFrame(() => {
        if (current.current)
          document.getElementById("admin-created-url")?.focus();
      });
    }
  };
  const share = async () => {
    if (!result?.url || !current.current || shareRequest.current) return;
    clearTimeout(toastTimer.current);
    setFeedback(null);
    const data = { title: result.link.title, url: result.url };
    shareRequest.current = true;
    setSharing(true);
    try {
      if (
        typeof navigator.share !== "function" ||
        (typeof navigator.canShare === "function" && !navigator.canShare(data))
      ) {
        await copy(t("admin.invitationShareFallback"));
        return;
      }
      await navigator.share(data);
    } catch (err) {
      if (err?.name !== "AbortError")
        notify(t("admin.invitationShareFailed"), true);
    } finally {
      shareRequest.current = false;
      if (alive.current && current.current) setSharing(false);
    }
  };
  return (
    <Dialog
      class="settings-dialog action-dialog invite-dialog"
      id="admin-create-dialog"
      open={open}
      inert={!open}
      onClose={close}
      onExited={onExit}
      fallbackFocus={fallbackFocus}
      aria-labelledby="admin-create-title"
    >
      <PageHeader
        className="invite-topbar"
        titleId="admin-create-title"
        titleTag="h2"
        title={t(
          result || invitation ? "admin.invitationLink" : "admin.inviteUpload",
        )}
        back={
          <button
            type="button"
            class="icon-button edge-start"
            disabled={busy && !invitation}
            aria-label={t(
              result || invitation ? "admin.close" : "admin.cancel",
            )}
            onClick={close}
          >
            <Icon name="chevron-left" />
          </button>
        }
        {...dialogHeadingFocus}
      />
      {result ? (
        <div class="invite-result" data-reopened={invitation ? "" : undefined}>
          <div class="invite-result-content">
            {!showQR && !invitation && (
              <div class="invite-success">
                <span>
                  <Icon name="check" />
                </span>
                <h3>{t("admin.invitationCreated")}</h3>
              </div>
            )}
            <section class="invite-result-info">
              <h3>{result.link.title}</h3>
              <p>
                {t("admin.expires")}{" "}
                <time dateTime={result.link.expiresAt}>
                  {date(result.link.expiresAt, true)}
                </time>
              </p>
              {!showQR && (
                <p>
                  {t("admin.invitationSummary", {
                    file: bytes(result.link.maxFileBytes),
                    total: bytes(result.link.maxTotalBytes),
                    count: result.link.maxFiles,
                  })}
                </p>
              )}
            </section>
            <div id="invite-presentation" class="invite-presentation">
              {showQR ? (
                result.url && (
                  <>
                    <UploadQR url={result.url} />
                    <p class="invite-scan-caption">
                      {t("admin.invitationScanHint")}
                    </p>
                  </>
                )
              ) : (
                <>
                  <label class="invite-url-label" for="admin-created-url">
                    {t("admin.invitationLink")}
                  </label>
                  <textarea
                    id="admin-created-url"
                    readOnly
                    rows={2}
                    value={result.url}
                    autoComplete="off"
                    spellcheck={false}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </>
              )}
            </div>
            <p class="invite-save-note">
              <Icon name="info" />
              <span>
                {t(
                  result.link.shareable === true
                    ? "admin.invitationSaveHint"
                    : "admin.invitationLegacySaveHint",
                )}
              </span>
            </p>
          </div>
          <div class="invite-share-actions">
            <button id="admin-copy-link" onClick={() => void copy()}>
              <Icon name="copy" />
              <span>{t("admin.copyLink")}</span>
            </button>
            <button
              disabled={sharing}
              aria-busy={sharing}
              onClick={() => void share()}
            >
              <Icon name="share" />
              <span>{t("admin.invitationShare")}</span>
            </button>
            <button
              aria-expanded={showQR}
              aria-controls="invite-presentation"
              data-active={showQR ? "" : undefined}
              onClick={() => setShowQR((value) => !value)}
            >
              <Icon name="qr-code" />
              <span>
                {t(
                  showQR ? "admin.invitationHideQR" : "admin.invitationShowQR",
                )}
              </span>
            </button>
          </div>
          <footer class="invite-footer">
            <button class="invite-done" onClick={close}>
              {t("admin.done")}
            </button>
          </footer>
        </div>
      ) : invitation ? (
        <div class="invite-result">
          <div class="invite-result-content invite-load-state" aria-busy={busy}>
            <h3>{invitation.title}</h3>
            {busy ? (
              <p role="status">{t("admin.loading")}</p>
            ) : (
              <>
                <p class="form-error" role="alert">
                  {error}
                </p>
                <button
                  class="secondary-button"
                  onClick={() => void loadExisting()}
                >
                  {t("library.retry")}
                </button>
              </>
            )}
          </div>
          <footer class="invite-footer">
            <button class="invite-done" onClick={close}>
              {t("admin.done")}
            </button>
          </footer>
        </div>
      ) : (
        <form class="invite-form" onSubmit={submit}>
          <div class="invite-form-content">
            <p class="invite-intro">{t("admin.invitationDescription")}</p>
            <fieldset disabled={busy || uncertain} class="invite-fields">
              <div class="invite-group">
                <label
                  class="invite-row invite-title-row"
                  for="admin-link-title"
                >
                  <span>{t("admin.invitationNote")}</span>
                  <input
                    id="admin-link-title"
                    name="title"
                    required
                    maxLength={200}
                    autoComplete="off"
                    defaultValue={defaultTitle}
                  />
                </label>
              </div>
              <h3 class="invite-group-title">{t("admin.invitationRules")}</h3>
              <div class="invite-group">
                <InvitationSelect
                  id="admin-link-expiry"
                  name="expiryHours"
                  label={t("admin.invitationValidity")}
                  initial={168}
                  dateTime
                  options={[
                    { value: 1, label: t("admin.invitationOneHour") },
                    {
                      value: 24,
                      label: t("admin.invitationDays", { count: 1 }),
                    },
                    {
                      value: 72,
                      label: t("admin.invitationDays", { count: 3 }),
                    },
                    {
                      value: 168,
                      label: t("admin.invitationDays", { count: 7 }),
                    },
                    {
                      value: 720,
                      label: t("admin.invitationDays", { count: 30 }),
                    },
                  ]}
                />
                <InvitationSelect
                  id="admin-link-file-limit"
                  name="maxFileMiB"
                  label={t("admin.fileLimit")}
                  initial={1024}
                  options={capacityOptions([100, 500, 1024, 2048, 5120])}
                />
                <InvitationSelect
                  id="admin-link-total-limit"
                  name="maxTotalMiB"
                  label={t("admin.invitationTotalLimit")}
                  initial={10240}
                  options={capacityOptions([1024, 5120, 10240, 51200, 102400])}
                />
                <InvitationSelect
                  id="admin-link-file-count"
                  name="maxFiles"
                  label={t("admin.maxFiles")}
                  initial={1000}
                  options={[100, 500, 1000, 5000, 10000].map((value) => ({
                    value,
                    label: `${value.toLocaleString(locale)} ${t("admin.fileUnit")}`,
                  }))}
                />
              </div>
              <p class="invite-rule-hint">{t("admin.invitationLimitsHint")}</p>
            </fieldset>
            {error && (
              <p class="form-error" role="alert">
                {error}
              </p>
            )}
            {uncertain && (
              <p class="form-error" role="alert">
                {t("admin.createUncertain")}
              </p>
            )}
            {busy && (
              <p class="invite-rule-hint" role="status">
                {t("admin.creating")}
              </p>
            )}
          </div>
          <footer class="invite-footer">
            <button
              class="primary-button"
              type="submit"
              disabled={busy || uncertain}
            >
              {t(busy ? "admin.creating" : "admin.createInvitation")}
            </button>
          </footer>
        </form>
      )}
      {feedback && <Toast message={feedback} position="center" />}
    </Dialog>
  );
}
