import { t } from "../../../shared/i18n.js";
import { UploadPanel } from "./UploadPanel.jsx";

export function UploadPage({ token }) {
  return (
    <main class="setup-page upload-page">
      <section class="setup-card" aria-labelledby="upload-title">
        <UploadPanel
          token={token}
          footer={
            <a class="upload-back" href="/">
              {t("account.backToPublicFiles")}
            </a>
          }
        />
      </section>
    </main>
  );
}
