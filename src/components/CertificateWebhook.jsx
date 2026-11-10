import { t } from "../../shared/i18n.js";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  certificateWebhookUrl,
  webhookOrigin,
} from "../../shared/site-secret.js";

export function CertificateWebhook({
  secretKey,
  notify,
  address,
  onAddressChange,
  showAddress = true,
}) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState(false);
  const output = useRef(null);
  const key = secretKey;
  let origin = "";
  try {
    origin = webhookOrigin(address);
  } catch {}

  useEffect(() => {
    let active = true;
    setError("");
    setResult(null);
    if (origin && key) {
      certificateWebhookUrl(key, origin)
        .then((url) => {
          if (active) setResult({ key, origin, url });
        })
        .catch(() => {
          if (active) setError(t("account.webhookGenerationFailed"));
        });
    }
    return () => {
      active = false;
    };
  }, [key, origin]);
  // Never copy a result derived from a previous key or deployment address.
  const url =
    result?.key === key && result?.origin === origin ? result.url : "";
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      notify(t("account.webhookCopied"));
    } catch {
      setRevealed(true);
      requestAnimationFrame(() => {
        output.current?.focus();
        output.current?.select();
      });
      notify(t("account.webhookCopyManually"));
    }
  };
  const download = () => {
    if (!url) return;
    const objectUrl = URL.createObjectURL(
      new Blob([`CERT_WEBHOOK_URL=${JSON.stringify(url)}\n`], {
        type: "application/octet-stream",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "bridge.env";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };
  if (!key)
    return (
      <section
        class="setup-webhook"
        aria-label={t("account.certificateWebhook")}
      >
        <p>{t("account.webhookSavedInstructions")}</p>
        <details class="setup-webhook-existing">
          <summary>{t("account.recalculateWebhook")}</summary>
          <p>{t("account.webhookExistingInstructions")}</p>
          <code>
            npm run webhook --{" "}
            {location.protocol === "https:"
              ? location.origin
              : "https://lantern-dock.example.workers.dev"}
          </code>
        </details>
      </section>
    );
  return (
    <section class="setup-webhook" aria-label={t("account.certificateWebhook")}>
      <h3>{t("account.bridgeConfiguration")}</h3>
      <p>{t("account.webhookBridgeInstructions")}</p>
      {showAddress && (
        <>
          <label class="form-label" for="webhook-origin">
            {t("account.deploymentAddress")}
          </label>
          <input
            id="webhook-origin"
            type="url"
            placeholder="https://lantern-dock.example.workers.dev"
            value={address}
            onInput={(event) => onAddressChange(event.currentTarget.value)}
            aria-describedby="webhook-origin-help"
            autoComplete="off"
            spellCheck={false}
          />
          <p id="webhook-origin-help">
            {address && !origin
              ? t("account.webhookAddressInvalid")
              : t("account.webhookAddressHelp")}
          </p>
        </>
      )}
      <label class="form-label" for="certificate-webhook-url">
        {t("account.certificateWebhookUrl")}
      </label>
      <input
        ref={output}
        id="certificate-webhook-url"
        type={revealed ? "text" : "password"}
        value={url}
        readOnly
        placeholder={t("account.webhookUrlPlaceholder")}
        autoComplete="off"
        spellCheck={false}
      />
      <div class="setup-webhook-actions">
        <button
          class="text-button"
          disabled={!url}
          onClick={() => setRevealed((value) => !value)}
        >
          {revealed ? t("account.hideWebhookUrl") : t("account.showWebhookUrl")}
        </button>
        <button class="secondary-button" disabled={!url} onClick={copy}>
          {t("account.copyWebhookUrl")}
        </button>
        <button class="text-button" disabled={!url} onClick={download}>
          {t("account.downloadBridgeEnv")}
        </button>
      </div>
      <p class="field-note">{t("account.webhookSaveInstructions")}</p>
      {error && <p role="status">{error}</p>}
    </section>
  );
}
