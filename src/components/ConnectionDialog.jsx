import { t } from "../../shared/i18n.js";
import { useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { Dialog } from "./Dialog.jsx";
import { PageDialogHeader } from "./PageDialog.jsx";
import { dialogHeadingFocus } from "../lib/overlay-focus.js";
import { useCompactLayout } from "../hooks/useMediaQuery.js";

export function ConnectionDialog({
  backend,
  gatewayTokenRequired,
  credentials,
  onConnect,
  onForget,
  onClose,
  onExited,
  open,
  feedback,
  fallbackFocus,
}) {
  const mobile = useCompactLayout();
  const [form, setForm] = useState({
    ...credentials,
    mode:
      credentials.mode === "none" ? backend?.auth || "none" : credentials.mode,
  });
  const field = (name, value) =>
    setForm((current) => ({ ...current, [name]: value }));
  const row = (name, label, control) => (
    <li class="connection-field">
      <label class="form-label" for={name}>
        {label}
      </label>
      {control}
    </li>
  );
  const input = (name, label, type = "password", autocomplete = "off") =>
    row(
      name,
      label,
      <input
        id={name}
        type={type}
        autoComplete={autocomplete}
        value={form[name] || ""}
        onInput={(event) => field(name, event.currentTarget.value)}
      />,
    );
  const title = t("library.connectionSettings");
  const closeLabel = t("library.closeSettings");
  const transport =
    backend?.transport === "demo"
      ? t("library.demoSpace")
      : backend?.transport === "webtransport"
        ? "WebTransport"
        : "HTTP / HTTPS";
  const endpoint = backend?.endpoint || t("library.demoFileSpace");
  const help = (
    <details class={mobile ? "connection-page-help" : "connection-help"}>
      <summary class={mobile ? "my-list-button" : undefined}>
        <span>{t("library.connectionHelp")}</span>
        {mobile && <Icon name="chevron-down" />}
      </summary>
      <p class="field-note">
        {backend?.transport === "webtransport"
          ? t("library.webTransportHelp")
          : backend?.transport === "demo"
            ? t("library.demoConnectionHelp")
            : t("library.webDavHelp")}
      </p>
    </details>
  );
  const clear = (
    <button
      type="button"
      class={mobile ? "my-list-button connection-clear" : "text-button"}
      onClick={() => {
        setForm({ mode: "none" });
        onForget();
      }}
    >
      {t("library.clearCredentials")}
    </button>
  );
  const connect = (
    <button type="submit" class="primary-button">
      <Icon name="plug" />
      {t("library.connect")}
    </button>
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      onExited={onExited}
      fallbackFocus={
        !mobile
          ? "#account-menu-trigger"
          : fallbackFocus || ".mobile-tabs button:last-child"
      }
      class={mobile ? "page-dialog connection-page" : "settings-dialog"}
      aria-labelledby="settings-title"
    >
      {mobile ? (
        <PageDialogHeader
          title={title}
          titleId="settings-title"
          backLabel={closeLabel}
          onClose={onClose}
        />
      ) : (
        <div class="dialog-heading" {...dialogHeadingFocus}>
          <h2 id="settings-title">{title}</h2>
          <button
            type="button"
            class="icon-button"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>
      )}
      <form
        class={mobile ? "settings-page-content" : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          onConnect({
            ...form,
            bearer: form.bearer?.trim(),
            gatewayToken: form.gatewayToken?.trim(),
          });
        }}
      >
        {mobile ? (
          <dl class="my-action-list settings-detail-list connection-summary">
            <div>
              <dt>{t("account.connectionMethod")}</dt>
              <dd>{transport}</dd>
            </div>
            {backend?.endpoint && (
              <div>
                <dt>{t("library.serverAddress")}</dt>
                <dd>{endpoint}</dd>
              </div>
            )}
            {backend?.rootPath && (
              <div>
                <dt>{t("library.rootDirectory")}</dt>
                <dd>{backend.rootPath}</dd>
              </div>
            )}
          </dl>
        ) : (
          <div class="endpoint-box">
            <span class="mini-chip">{transport}</span>
            <strong>{endpoint}</strong>
            <span>
              {backend && t("library.rootPath", { path: backend.rootPath })}
            </span>
          </div>
        )}
        <div>
          <ul
            class={`connection-fields${mobile ? " my-action-list" : ""}`}
            role="list"
          >
            {row(
              "auth-mode",
              t("library.authentication"),
              <select
                id="auth-mode"
                value={form.mode}
                onChange={(event) => field("mode", event.currentTarget.value)}
              >
                <option value="none">{t("library.noAuthentication")}</option>
                <option value="basic">
                  {t("library.basicAuthentication")}
                </option>
                <option value="bearer">
                  {t("library.bearerAuthentication")}
                </option>
              </select>,
            )}
            {form.mode === "basic" && (
              <>
                {input("username", t("library.username"), "text", "username")}
                {input(
                  "password",
                  t("library.password"),
                  "password",
                  "current-password",
                )}
              </>
            )}
            {form.mode === "bearer" &&
              input("bearer", t("library.accessToken"))}
            {backend?.transport === "webtransport" &&
              (gatewayTokenRequired || credentials.gatewayToken) &&
              input("gatewayToken", t("library.gatewayToken"))}
          </ul>
          <p class="field-note">{t("library.credentialsNote")}</p>
        </div>
        {mobile ? (
          <>
            <div class="my-action-list connection-utilities">
              {help}
              {clear}
            </div>
            {connect}
          </>
        ) : (
          <>
            {help}
            <div class="dialog-actions">
              {clear}
              {connect}
            </div>
          </>
        )}
      </form>
      {feedback}
    </Dialog>
  );
}
