import { t } from "../../shared/i18n.js";
import { useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { Dialog } from "./Dialog.jsx";
import { useMediaQuery } from "../hooks/useMediaQuery.js";

export function ConnectionDialog({
  backend,
  credentials,
  onConnect,
  onForget,
  onClose,
  onExited,
  open,
  feedback,
}) {
  const mobile = useMediaQuery("(max-width: 700px)");
  const [form, setForm] = useState({
    ...credentials,
    mode:
      credentials.mode === "none" ? backend?.auth || "none" : credentials.mode,
  });
  const field = (name, value) =>
    setForm((current) => ({ ...current, [name]: value }));
  const input = (name, label, type = "password", autocomplete = "off") => (
    <>
      <label class="form-label" for={name}>
        {label}
      </label>
      <input
        id={name}
        type={type}
        autoComplete={autocomplete}
        value={form[name] || ""}
        onInput={(event) => field(name, event.currentTarget.value)}
      />
    </>
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      onExited={onExited}
      fallbackFocus={mobile ? "#navigation-toggle" : "#connection-settings"}
      class="settings-dialog"
      aria-labelledby="settings-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConnect({
            ...form,
            bearer: form.bearer?.trim(),
            gatewayToken: form.gatewayToken?.trim(),
          });
        }}
      >
        <div class="dialog-heading">
          <h2 id="settings-title">{t("library.connectionSettings")}</h2>
          <button
            type="button"
            class="icon-button"
            aria-label={t("library.closeSettings")}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <div class="endpoint-box">
          <span class="mini-chip">
            {backend?.transport === "demo"
              ? t("library.demoSpace")
              : backend?.transport === "webtransport"
                ? "WebTransport"
                : "HTTP / HTTPS"}
          </span>
          <strong>{backend?.endpoint || t("library.demoFileSpace")}</strong>
          <span>{backend && t("library.rootPath", { path: backend.rootPath })}</span>
        </div>
        <label class="form-label" for="auth-mode">
          {t("library.authentication")}
        </label>
        <select
          id="auth-mode"
          value={form.mode}
          onChange={(event) => field("mode", event.currentTarget.value)}
        >
          <option value="none">{t("library.noAuthentication")}</option>
          <option value="basic">{t("library.basicAuthentication")}</option>
          <option value="bearer">{t("library.bearerAuthentication")}</option>
        </select>
        {form.mode === "basic" && (
          <>
            {input("username", t("library.username"), "text", "username")}
            {input("password", t("library.password"), "password", "current-password")}
          </>
        )}
        {form.mode === "bearer" && input("bearer", t("library.accessToken"))}
        {backend?.gatewayAuth && input("gatewayToken", t("library.gatewayToken"))}
        <p class="field-note">{t("library.credentialsNote")}</p>
        <details class="connection-help">
          <summary>{t("library.connectionHelp")}</summary>
          <p class="field-note">
            {backend?.transport === "webtransport"
              ? t("library.webTransportHelp")
              : backend?.transport === "demo"
                ? t("library.demoConnectionHelp")
                : t("library.webDavHelp")}
          </p>
        </details>
        <div class="dialog-actions">
          <button
            type="button"
            class="text-button"
            onClick={() => {
              setForm({ mode: "none" });
              onForget();
            }}
          >
            {t("library.clearCredentials")}
          </button>
          <button type="submit" class="primary-button">
            <Icon name="plug" />
            {t("library.connect")}
          </button>
        </div>
      </form>
      {feedback}
    </Dialog>
  );
}
