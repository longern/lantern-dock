import { t } from "../../shared/i18n.js";
import { useLayoutEffect, useRef } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { useSetupWizard } from "../hooks/useSetupWizard.js";
import { SetupConnection } from "./SetupConnection.jsx";
import { SetupExport } from "./SetupExport.jsx";
import { SetupCertificates } from "./SetupCertificates.jsx";

const reasons = {
  "missing-backend": "account.missingBackendReason",
  "invalid-configuration": "account.invalidConfigurationReason",
  "conflicting-backends": "account.conflictingBackendsReason",
};

export function SetupWizard({ setup, checking, onRetry, onDemo, notify }) {
  const wizard = useSetupWizard(setup, notify);
  const { stage } = wizard;
  const connection = stage === "connection";
  const certificates = stage === "certificates";
  const heading = useRef(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [stage]);
  const steps = [
    { id: "connection", label: t("account.connectBackend") },
    {
      id: certificates ? "certificates" : "export",
      label: certificates
        ? t("account.connectCertificates")
        : t("account.saveAndDeploy"),
    },
  ];
  const description = connection
    ? t(reasons[setup.reason] || reasons["missing-backend"])
    : certificates
      ? t("account.waitingForCertificate")
      : t("account.saveDeploymentDescription");
  return (
    <main class="setup-page">
      <header class="setup-brand">
        <span class="brand-symbol">
          <Icon name="portal" />
        </span>
        <span>LanternDock</span>
      </header>
      <section class="setup-card" aria-labelledby="setup-title">
        <div class="setup-intro">
          <span class="setup-eyebrow">{t("account.setupEyebrow")}</span>
          <h1 id="setup-title">{t("account.setupTitle")}</h1>
          <p>{description}</p>
        </div>
        <ol class="setup-steps" aria-label={t("account.setupSteps")}>
          {steps.map((step, index) => (
            <li
              key={step.id}
              class={
                connection
                  ? index === 0
                    ? "current"
                    : ""
                  : index === 0
                    ? "complete"
                    : "current"
              }
              aria-current={
                (connection ? index === 0 : index === 1) ? "step" : undefined
              }
            >
              <span>{index + 1}</span>
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
        <h2 ref={heading} tabIndex="-1">
          {connection
            ? t("account.connectBackend")
            : certificates
              ? t("account.configureGatewayCertificates")
              : t("account.saveAndDeploy")}
        </h2>
        {connection ? (
          <SetupConnection wizard={wizard} />
        ) : (
          <>
            {certificates ? (
              <SetupCertificates
                wizard={wizard}
                notify={notify}
                hasKV={setup.hasKV}
              />
            ) : (
              <SetupExport wizard={wizard} setup={setup} notify={notify} />
            )}
            {setup.checked && !checking && (
              <p class="setup-hint" role="status">
                {setup.reason === "missing-certificates"
                  ? t("account.missingCertificates")
                  : t("account.missingBackendConfiguration")}
              </p>
            )}
            <div class="setup-actions">
              <button class="secondary-button" onClick={wizard.edit}>
                {certificates
                  ? t("account.editConnection")
                  : t("account.previousStep")}
              </button>
              {!certificates && wizard.externalDeployment ? (
                wizard.deploymentUrl ? (
                  <a
                    class="primary-button"
                    href={wizard.deploymentUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("account.openDeployedSite")}
                    <Icon name="arrow-up-right" />
                  </a>
                ) : (
                  <button class="primary-button" disabled>
                    {t("account.openDeployedSite")}
                  </button>
                )
              ) : (
                <button
                  class="primary-button"
                  disabled={checking}
                  onClick={onRetry}
                >
                  <Icon name="refresh" />
                  {checking ? t("account.checking") : t("account.checkAgain")}
                </button>
              )}
            </div>
          </>
        )}
      </section>
      <footer class="setup-footer">
        <a
          href="https://github.com/longern/lantern-dock/blob/main/docs/configuration.md"
          target="_blank"
          rel="noreferrer"
        >
          {t("account.configurationDocumentation")}
        </a>
        <button class="text-button" onClick={onDemo}>
          {t("account.tryDemo")}
        </button>
      </footer>
    </main>
  );
}
