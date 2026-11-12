import { t, locale } from "../../../shared/i18n.js";
import { Icon } from "../../components/Icon.jsx";
import { bytes, date } from "../../lib/format.js";
import { Brand } from "../../components/Brand.jsx";
import { dialogHeadingFocus } from "../../lib/overlay-focus.js";
import { useUploadQueue } from "./useUploadQueue.js";
import { UploadFileRow } from "./UploadFileRow.jsx";

export function UploadPanel({
  token,
  personalClient,
  onWorking,
  initialFiles,
  direct = false,
  onClose,
  footer,
}) {
  const {
    link,
    error,
    rows,
    working,
    cancelling,
    available,
    remaining,
    total,
    loaded,
    completed,
    percent,
    orderedRows,
    nextTasks,
    loadingTasks,
    tasksError,
    loadMoreTasks,
    receive,
    cancelRow,
    cancelUploads,
    retry,
  } = useUploadQueue({
    token,
    personalClient,
    onWorking,
    initialFiles,
    direct,
  });
  const Heading = personalClient ? "h2" : "h1";
  const chooseFiles = (event) => {
    const files = event.currentTarget.files;
    if (files?.length) void receive(files);
    event.currentTarget.value = "";
  };
  return (
    <div
      class="upload-panel"
      data-working={working ? "" : undefined}
      data-has-files={rows.length ? "" : undefined}
    >
      <header class="upload-header">
        <Brand className="upload-brand" />
        <div
          class="upload-heading"
          {...(personalClient ? dialogHeadingFocus : {})}
        >
          <Heading
            id={personalClient ? "personal-upload-title" : "upload-title"}
          >
            {t("admin.uploadFiles")}
          </Heading>
          {onClose && (
            <button
              class="icon-button"
              aria-label={t("admin.close")}
              disabled={working}
              onClick={onClose}
            >
              <Icon name="x" />
            </button>
          )}
        </div>
        <p class="upload-subtitle">
          {rows.length
            ? t("account.uploadFileSummary", {
                count: rows.length,
                size: bytes(total),
              })
            : personalClient
              ? t(
                  direct
                    ? "admin.directUploadDescription"
                    : "admin.personalUploadDescription",
                )
              : link?.title || t("account.uploadPrivacy")}
        </p>
      </header>
      {!!rows.length && (
        <section
          class="upload-summary"
          aria-label={t("account.totalUploadProgress")}
        >
          <div class="upload-summary-values">
            <span>
              {t("account.uploadBytes", {
                loaded: bytes(loaded),
                total: bytes(total),
              })}
            </span>
            <strong>{percent}%</strong>
          </div>
          <progress
            value={percent}
            max="100"
            aria-label={t("account.totalUploadProgress")}
          />
          <p>
            {t("account.uploadCompletedCount", {
              completed,
              total: rows.length,
            })}
          </p>
        </section>
      )}
      {working && (
        <aside class="upload-foreground-note">
          <Icon name="info" />
          <p>
            <span>{t("account.keepUploadForeground")}</span>
            <span>{t("account.uploadBackgroundWarning")}</span>
          </p>
        </aside>
      )}
      <div class="upload-content">
        {error && (
          <div class="upload-message" role="alert">
            <p>{error}</p>
            <button class="secondary-button" disabled={working} onClick={retry}>
              {t("account.checkAgain")}
            </button>
          </div>
        )}
        {!!rows.length ? (
          <>
            <div class="upload-queue-heading">
              <h3>{t("account.uploadFileList")}</h3>
              {available && !cancelling && (
                <label class="upload-add text-button">
                  <Icon name="plus" />
                  {t("account.addUploadFiles")}
                  <input
                    type="file"
                    multiple
                    aria-label={t("account.chooseUploadFiles")}
                    onChange={chooseFiles}
                  />
                </label>
              )}
            </div>
            <ul
              class="upload-results"
              aria-label={t("account.currentUploads")}
              tabIndex="0"
            >
              {orderedRows.map((row) => (
                <UploadFileRow
                  key={row.id}
                  row={row}
                  working={working}
                  cancelling={cancelling}
                  error={error}
                  onCancel={cancelRow}
                  onReceive={receive}
                />
              ))}
            </ul>
            {tasksError && <p role="alert">{tasksError}</p>}
            {nextTasks && (
              <button
                type="button"
                class="secondary-button"
                disabled={loadingTasks}
                onClick={loadMoreTasks}
              >
                {t(loadingTasks ? "library.loadingMore" : "library.loadMore")}
              </button>
            )}
          </>
        ) : (
          <div class="upload-empty">
            {!link && !error && (
              <p class="upload-message" role="status">
                {t("account.connectingInbox")}
              </p>
            )}
            {link && !error && (
              <>
                <label
                  class={`upload-drop${!available ? " disabled" : ""}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (available) void receive(event.dataTransfer.files);
                  }}
                >
                  <Icon name="upload" />
                  <strong>
                    {available
                      ? t("admin.selectUploadFiles")
                      : t("account.inboxUnavailable")}
                  </strong>
                  <span>{t("account.multipleFilesHelp")}</span>
                  <input
                    type="file"
                    multiple
                    disabled={!available}
                    aria-label={t("account.chooseUploadFiles")}
                    onChange={chooseFiles}
                  />
                </label>
                <p class="upload-selection-note">
                  {t("account.uploadStartsImmediately")}
                </p>
                {!personalClient && (
                  <dl class="upload-limits">
                    <div>
                      <dt>{t("account.fileSizeLimit")}</dt>
                      <dd>{bytes(link.maxFileBytes)}</dd>
                    </div>
                    <div>
                      <dt>{t("account.remainingCapacity")}</dt>
                      <dd>{bytes(remaining)}</dd>
                    </div>
                    <div>
                      <dt>{t("account.remainingFiles")}</dt>
                      <dd>
                        {Math.max(
                          0,
                          link.maxFiles - link.usedFiles,
                        ).toLocaleString(locale)}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("account.expiresAt")}</dt>
                      <dd>{date(link.expiresAt, true)}</dd>
                    </div>
                  </dl>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <footer class="upload-actions">
        {working ? (
          <button
            class="secondary-button upload-cancel"
            disabled={cancelling}
            onClick={cancelUploads}
          >
            {t(
              cancelling
                ? "account.cancellingUpload"
                : rows.length > 1
                  ? "account.cancelAllUploads"
                  : "account.cancelUpload",
            )}
          </button>
        ) : (
          footer
        )}
      </footer>
    </div>
  );
}
