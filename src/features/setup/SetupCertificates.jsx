import { t } from "../../../shared/i18n.js";
import { CertificateWebhook } from "./CertificateWebhook.jsx";

export function SetupCertificates({ wizard, notify, hasKV }) {
  return (
    <>
      <div class="setup-connection-summary">
        <span>{t("account.savedConnectionAddress")}</span>
        <strong>{wizard.form.endpoint}</strong>
      </div>
      <ol class="setup-certificate-tasks">
        <li>
          {hasKV
            ? t("account.kvConnected")
            : t("account.kvBindingInstructions")}
        </li>
        <li>{t("account.certificateBridgeInstructions")}</li>
        <li>{t("account.checkCertificateInstructions")}</li>
      </ol>
      {!hasKV && !wizard.isLocal && (
        <p class="setup-hint" role="status">
          {t("account.missingKvInstructions")}
        </p>
      )}
      {wizard.isLocal && (
        <p class="field-note">{t("account.localCertificateInstructions")}</p>
      )}
      <CertificateWebhook
        secretKey=""
        notify={notify}
        address={wizard.origin}
        onAddressChange={wizard.setOrigin}
      />
    </>
  );
}
