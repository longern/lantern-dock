import { t } from "../../../shared/i18n.js";
import { useRef, useState } from "preact/hooks";
import { setupSnippet } from "../../lib/setup.js";
import { CertificateWebhook } from "./CertificateWebhook.jsx";

export function SetupExport({ wizard, setup, notify }) {
  const { target, vars, exportSecretKey: key, form } = wizard;
  const [revealed, setRevealed] = useState(false);
  const code = useRef(null);
  const snippet = vars ? setupSnippet(vars, "local", key) : "";
  const wrangler = vars ? setupSnippet(vars, "wrangler") : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      notify(t("account.configurationCopied"));
    } catch {
      setRevealed(true);
      requestAnimationFrame(() => {
        code.current?.focus();
        code.current?.select();
      });
      notify(t("account.configurationCopyManually"));
    }
  };
  const download = (content, name) => {
    const url = URL.createObjectURL(
      new Blob([content], { type: "application/octet-stream" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <div
        class="setup-targets"
        role="group"
        aria-label={t("account.deploymentEnvironment")}
      >
        <button
          aria-pressed={target === "local"}
          class={target === "local" ? "active" : ""}
          onClick={() => wizard.selectTarget("local")}
        >
          {t("account.localDevelopment")}
        </button>
        <button
          aria-pressed={target === "worker"}
          class={target === "worker" ? "active" : ""}
          onClick={() => wizard.selectTarget("worker")}
        >
          Cloudflare Workers
        </button>
      </div>
      {wizard.isLocal && target === "worker" && (
        <div class="setup-deployment-address">
          <label class="form-label" for="deployment-origin">
            {t("account.deploymentAddress")}
          </label>
          <input
            id="deployment-origin"
            type="url"
            value={wizard.origin}
            onInput={(event) => wizard.setOrigin(event.currentTarget.value)}
            placeholder="https://lantern-dock.example.workers.dev"
            spellCheck={false}
          />
          {wizard.origin && !wizard.deploymentUrl && (
            <p class="field-note">{t("account.deploymentAddressInvalid")}</p>
          )}
        </div>
      )}
      <section class="setup-export" aria-label={t("account.siteConfiguration")}>
        <h3>{t("account.lanternDockConfiguration")}</h3>
        <p class="setup-instructions">
          {target === "local"
            ? t("account.localExportInstructions")
            : t("account.workerExportInstructions")}
        </p>
        <div class="setup-code-heading">
          <span>.env</span>
          <div>
            {key && (
              <button
                class="text-button"
                onClick={() => setRevealed((value) => !value)}
              >
                {revealed ? t("account.hideKey") : t("account.showKey")}
              </button>
            )}
            <button
              class="text-button"
              onClick={() => download(snippet, "lantern-dock.env")}
            >
              {t("account.downloadConfiguration")}
            </button>
            <button class="text-button" onClick={copy}>
              {t("account.copyConfiguration")}
            </button>
          </div>
        </div>
        <textarea
          ref={code}
          class="setup-code"
          aria-label={t("account.generatedConfiguration")}
          readOnly
          spellCheck={false}
          value={
            key && !revealed ? snippet.replace(key, "•".repeat(32)) : snippet
          }
          rows={Math.min(8, Math.max(3, snippet.trim().split("\n").length))}
        />
        <p class="field-note">
          {key ? t("account.newKeyHelp") : t("account.existingKeyHelp")}
        </p>
      </section>
      {form.transport === "webtransport" &&
        form.certificateMode === "pinned" && (
          <CertificateWebhook
            secretKey={key}
            notify={notify}
            address={wizard.origin}
            onAddressChange={wizard.setOrigin}
            showAddress={!(wizard.isLocal && target === "worker")}
          />
        )}
      <details class="setup-advanced setup-other">
        <summary>{t("account.otherDeploymentMethods")}</summary>
        <p class="field-note">{t("account.wranglerSecretsHelp")}</p>
        <textarea
          class="setup-code"
          aria-label={t("account.wranglerConfiguration")}
          readOnly
          value={wrangler}
          rows="5"
          spellCheck={false}
        />
        <button
          class="text-button"
          onClick={() => download(wrangler, "lantern-dock.vars.json")}
        >
          {t("account.downloadWranglerJson")}
        </button>
        {!key && setup.hasSecretKey && (
          <button class="text-button" onClick={wizard.newDeployment}>
            {t("account.generateDeploymentKey")}
          </button>
        )}
      </details>
      <details class="setup-checklist">
        <summary>{t("account.connectionTroubleshooting")}</summary>
        <ul>
          {form.transport === "http" ? (
            <li>
              {t("account.webdavRequirements", { origin: location.origin })}
            </li>
          ) : (
            <>
              <li>
                {t("account.gatewayRequirements", { origin: location.origin })}
              </li>
              {form.certificateMode === "pinned" && (
                <li>
                  {target === "local"
                    ? t("account.localCertificateRequirements")
                    : t("account.workerCertificateRequirements")}
                </li>
              )}
            </>
          )}
        </ul>
      </details>
    </>
  );
}
