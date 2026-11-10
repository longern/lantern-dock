import { t } from "../../shared/i18n.js";
import { Icon } from "./Icon.jsx";

export function SetupConnection({ wizard }) {
  const { form, update, chooseTransport } = wizard;
  const webtransport = form.transport === "webtransport";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        wizard.generate();
      }}
    >
      <div
        class="setup-choices"
        role="group"
        aria-label={t("account.connectionMethod")}
      >
        <button
          type="button"
          class={`setup-choice${!webtransport ? " selected" : ""}`}
          aria-pressed={!webtransport}
          onClick={() => chooseTransport("http")}
        >
          <Icon name="folder" />
          <strong>HTTPS / WebDAV</strong>
          <span>{t("account.directConnection")}</span>
        </button>
        <button
          type="button"
          class={`setup-choice${webtransport ? " selected" : ""}`}
          aria-pressed={webtransport}
          onClick={() => chooseTransport("webtransport")}
        >
          <Icon name="plug" />
          <strong>WebTransport</strong>
          <span>{t("account.bridgeConnection")}</span>
        </button>
      </div>
      <label class="form-label" for="setup-endpoint">
        {webtransport
          ? t("account.webtransportAddress")
          : t("account.webdavAddress")}
      </label>
      <input
        id="setup-endpoint"
        type="url"
        required
        value={form.endpoint}
        autoComplete="url"
        placeholder={
          webtransport
            ? "https://bridge.example.com:4433/webtransport"
            : "https://files.example.com/dav/public/"
        }
        onInput={(event) => update("endpoint", event.currentTarget.value)}
        aria-describedby="setup-endpoint-help"
      />
      <p id="setup-endpoint-help" class="field-note">
        {webtransport
          ? t("account.webtransportAddressHelp")
          : t("account.webdavAddressHelp")}
      </p>
      <details class="setup-advanced">
        <summary>{t("account.advancedSettings")}</summary>
        <label class="form-label" for="setup-name">
          {t("account.resourceName")}
        </label>
        <input
          id="setup-name"
          value={form.name}
          maxLength="100"
          onInput={(event) => update("name", event.currentTarget.value)}
        />
        <div class="setup-fields">
          <div>
            <label class="form-label" for="setup-root">
              {t("account.webdavRoot")}
            </label>
            <input
              id="setup-root"
              value={form.rootPath}
              placeholder={
                webtransport
                  ? t("account.webtransportRootPlaceholder")
                  : t("account.webdavRootPlaceholder")
              }
              onInput={(event) => update("rootPath", event.currentTarget.value)}
            />
          </div>
          <div>
            <label class="form-label" for="setup-auth">
              {t("account.backendAuthentication")}
            </label>
            <select
              id="setup-auth"
              value={form.auth}
              onChange={(event) => update("auth", event.currentTarget.value)}
            >
              <option value="none">{t("account.noAuthentication")}</option>
              <option value="basic">{t("account.basicAuthentication")}</option>
              <option value="bearer">
                {t("account.bearerAuthentication")}
              </option>
            </select>
          </div>
        </div>
        {webtransport && (
          <>
            <label class="form-label" for="setup-certificate">
              {t("account.gatewayCertificate")}
            </label>
            <select
              id="setup-certificate"
              value={form.certificateMode}
              onChange={(event) =>
                update("certificateMode", event.currentTarget.value)
              }
            >
              <option value="pinned">{t("account.pinnedCertificate")}</option>
              <option value="webpki">{t("account.trustedCertificate")}</option>
            </select>
          </>
        )}
        <p class="field-note">{t("account.credentialsHelp")}</p>
      </details>
      <div class="setup-actions setup-actions-end">
        <button type="submit" class="primary-button">
          {t("account.generateConfiguration")}
          <Icon name="chevron-right" />
        </button>
      </div>
    </form>
  );
}
