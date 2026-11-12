import { t } from "../../../shared/i18n.js";
import { Icon } from "../../components/Icon.jsx";
import { bytes } from "../../lib/format.js";
import { kindFor } from "../../lib/dav.js";

export function UploadFileRow({
  row,
  working,
  cancelling,
  error,
  onCancel,
  onReceive,
}) {
  return (
    <li class={`upload-file ${row.status}`}>
      <span class="upload-file-icon">
        <Icon name={kindFor(row.file.name, false)} />
      </span>
      <div class="upload-file-info">
        <strong title={row.file.name}>{row.file.name}</strong>
        <span>
          {["uploading", "paused"].includes(row.status)
            ? t("account.uploadBytes", {
                loaded: bytes(row.loaded),
                total: bytes(row.file.size),
              })
            : bytes(row.file.size)}
        </span>
        <span
          class={`upload-result ${row.status}`}
          role={row.status === "uploading" ? "progressbar" : "status"}
          aria-label={
            row.status === "uploading"
              ? t("account.uploadProgress", { name: row.file.name })
              : undefined
          }
          aria-valuemin={row.status === "uploading" ? 0 : undefined}
          aria-valuemax={row.status === "uploading" ? 100 : undefined}
          aria-valuenow={
            row.status === "uploading"
              ? Math.min(
                  100,
                  Math.floor((row.loaded / (row.file.size || 1)) * 100),
                )
              : undefined
          }
        >
          {row.status === "complete"
            ? t("account.received")
            : row.status === "queued"
              ? t("account.queuedUpload")
              : row.status === "cancelled"
                ? t("account.cancelledUpload")
                : row.status === "failed"
                  ? t("account.uploadFailed")
                  : row.status === "paused"
                    ? t("account.uploadPaused")
                    : row.loaded >= row.file.size
                      ? t("account.confirmingReceipt")
                      : t("account.uploadingPercent", {
                          percent: Math.floor(
                            (row.loaded / (row.file.size || 1)) * 100,
                          ),
                        })}
        </span>
      </div>
      {["uploading", "queued", "paused"].includes(row.status) && (
        <button
          class="icon-button upload-file-cancel"
          aria-label={t("account.cancelUploadNamed", {
            name: row.file.name,
          })}
          title={t("account.cancelUpload")}
          disabled={cancelling || (row.status === "paused" && working)}
          onClick={() => onCancel(row)}
        >
          <Icon name="x" />
        </button>
      )}
      {["failed", "paused"].includes(row.status) && row.error && (
        <p class="upload-file-error">{row.error}</p>
      )}
      {row.status === "paused" && (
        <div class="upload-resume-actions">
          <label class="text-button upload-resume-picker">
            {t("account.resumeUpload")}
            <input
              type="file"
              disabled={working || !!error}
              aria-label={t("account.resumeUpload")}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void onReceive([file], row);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      )}
    </li>
  );
}
