import { t, locale } from "../../shared/i18n.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { UploadClient, uploadBatchKey } from "../lib/uploads.js";
import { bytes, date } from "../lib/format.js";
import { siteTitle } from "../lib/site-title.js";
import { kindFor } from "../lib/dav.js";
import { dialogHeadingFocus } from "../lib/overlay-focus.js";

function savedBatch(key) {
  try {
    const id = sessionStorage.getItem(key);
    return /^[a-f0-9]{32}$/.test(id || "") ? id : null;
  } catch {
    return null;
  }
}

function saveBatch(key, id) {
  try {
    if (id) sessionStorage.setItem(key, id);
    else sessionStorage.removeItem(key);
  } catch {
    // The active page can still upload if browser storage is unavailable.
  }
}

function restoredRow(task) {
  return {
    id: task.id,
    task,
    file: { name: task.name, size: task.size },
    loaded: task.offset,
    status:
      task.status === "complete"
        ? "complete"
        : task.status === "pending"
          ? "paused"
          : "failed",
    error: task.status === "failed" ? t("account.uploadTaskExpired") : "",
  };
}

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

export function UploadPanel({
  token,
  personalClient,
  onWorking,
  initialFiles,
  direct = false,
  onClose,
  footer,
}) {
  const [link, setLink] = useState(null);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([]);
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState(0);
  const client = useRef(null);
  const active = useRef(null);
  const running = useRef(false);
  const stopQueue = useRef(false);
  const pendingQueue = useRef(null);
  const skipped = useRef(new Set());
  const pendingCancellation = useRef(null);
  const mounted = useRef(false);
  const selection = useRef(initialFiles);
  const batchKey = useRef(null);
  const batchID = useRef(null);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const stop = () => {
      active.current?.controller.abort();
      client.current?.close();
    };
    const reopen = (event) => {
      if (event.persisted) setRevision((value) => value + 1);
    };
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", reopen);
    setLink(null);
    setError("");
    let key;
    (async () => {
      try {
        if (personalClient) {
          const connection = personalClient();
          client.current = connection;
          const info = await connection.info(controller.signal);
          if (!controller.signal.aborted) setLink(info);
          return;
        }
        if (!/^[A-Za-z0-9_-]{43}$/.test(token))
          throw new Error(t("account.invalidUploadLink"));
        if (crypto.subtle) key = await uploadBatchKey(token);
        const response = await fetch("/api/config", {
          cache: "no-store",
          headers: { "Accept-Language": locale },
          signal: controller.signal,
        });
        const config = await response.json();
        if (
          !response.ok ||
          config.setupRequired ||
          !config.backend ||
          config.backend.transport === "demo"
        )
          throw new Error(t("account.uploadServiceUnavailable"));
        if (controller.signal.aborted) return;
        const connection = new UploadClient(config.backend, token);
        client.current = connection;
        const info = await connection.info(controller.signal);
        if (controller.signal.aborted) return;
        batchKey.current = info.resumable ? key : null;
        if (batchKey.current) {
          batchID.current ||= savedBatch(key);
          if (batchID.current) {
            const tasks = await connection.resumableTasks(
              batchID.current,
              controller.signal,
            );
            if (controller.signal.aborted) return;
            setRows(tasks.map(restoredRow));
          }
        }
        setLink(info);
      } catch (err) {
        if (!controller.signal.aborted) {
          if (key && [401, 410].includes(err.status)) {
            saveBatch(key, null);
            batchID.current = null;
          }
          setError(err.message);
        }
      }
    })();
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", reopen);
      controller.abort();
      active.current?.controller.abort();
      client.current?.close();
      client.current = null;
    };
  }, [token, revision, personalClient]);
  const update = (id, patch) => {
    if (mounted.current)
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      );
  };
  const receive = async (files, resumed) => {
    if (!client.current || !link || !files.length) return;
    if (
      running.current &&
      (resumed || !pendingQueue.current || stopQueue.current)
    )
      return;
    const connection = client.current;
    const resumable = !!batchKey.current;
    if (resumable && !batchID.current) {
      batchID.current = crypto.randomUUID().replaceAll("-", "");
      saveBatch(batchKey.current, batchID.current);
    }
    const batch = resumed
      ? [{ ...resumed, file: files[0] }]
      : Array.from(files, (file) => ({
          id: crypto.randomUUID(),
          file,
          status: "queued",
          loaded: 0,
        }));
    if (!resumed) setRows((current) => [...current, ...batch]);
    if (running.current) {
      pendingQueue.current.push(...batch);
      return;
    }
    pendingQueue.current = batch;
    pendingCancellation.current = null;
    setWorking(true);
    onWorking?.(true);
    running.current = true;
    stopQueue.current = false;
    try {
      for (const row of batch) {
        if (
          !mounted.current ||
          client.current !== connection ||
          stopQueue.current
        )
          break;
        if (skipped.current.has(row.id)) continue;
        const controller = new AbortController();
        active.current = { id: row.id, controller };
        update(row.id, { status: "uploading", error: "" });
        let task = row.task;
        let confirmed = row.loaded;
        try {
          const options = {
            signal: controller.signal,
            onProgress: (loaded, checkpoint) => {
              if (checkpoint) confirmed = loaded;
              update(row.id, { loaded });
            },
          };
          if (resumable && row.file.size > link.maxFileBytes)
            throw new Error(t("account.uploadFileTooLarge"));
          if (resumable)
            await connection.uploadResumable(row.file, {
              ...options,
              batch: batchID.current,
              task,
              onTask: (value) => {
                task = value;
                update(row.id, { task });
              },
            });
          else await connection.upload(row.file, options);
          update(row.id, { status: "complete", loaded: row.file.size });
        } catch (err) {
          const aborted = controller.signal.aborted;
          let status = aborted
            ? "cancelled"
            : task && ![401, 403, 404, 410].includes(err.status)
              ? "paused"
              : "failed";
          let message = err.message;
          if (aborted && task && !connection.closed) {
            try {
              status = await connection.cancelResumable(
                batchID.current,
                task.id,
              );
            } catch (error) {
              status = "paused";
              message = error.message;
            }
          }
          update(row.id, {
            status,
            loaded:
              status === "complete"
                ? row.file.size
                : status === "cancelled"
                  ? 0
                  : confirmed,
            error: message,
          });
        }
        active.current = null;
        if (personalClient && !direct) continue;
        try {
          const info = await connection.info(AbortSignal.timeout(5000));
          if (mounted.current && client.current === connection) setLink(info);
        } catch (err) {
          if (mounted.current && client.current === connection)
            setError(err.message);
          for (const pending of batch.slice(batch.indexOf(row) + 1))
            update(pending.id, { status: "cancelled" });
          break;
        }
      }
    } finally {
      active.current = null;
      pendingQueue.current = null;
      if (pendingCancellation.current) {
        await pendingCancellation.current;
        try {
          const info = await connection.info(AbortSignal.timeout(5000));
          if (mounted.current && client.current === connection) setLink(info);
        } catch (err) {
          if (mounted.current && client.current === connection)
            setError(err.message);
        }
        pendingCancellation.current = null;
      }
      skipped.current.clear();
      running.current = false;
      if (mounted.current) {
        setWorking(false);
        setCancelling(false);
        onWorking?.(false);
      }
    }
  };
  const cancelUploads = () => {
    if (!running.current || stopQueue.current) return;
    // Stop the queue synchronously, including cancellation between two requests.
    stopQueue.current = true;
    setCancelling(true);
    setRows((current) =>
      current.map((row) =>
        row.status === "queued"
          ? { ...row, status: "cancelled", loaded: 0, error: "" }
          : row,
      ),
    );
    const connection = client.current;
    const paused = rows.filter((row) => row.status === "paused" && row.task);
    if (paused.length) {
      pendingCancellation.current = Promise.all(
        paused.map(async (row) => {
          try {
            const status = await connection.cancelResumable(
              batchID.current,
              row.task.id,
            );
            update(row.id, {
              status,
              loaded: status === "complete" ? row.file.size : 0,
              error: "",
            });
          } catch (err) {
            update(row.id, { error: err.message });
          }
        }),
      );
    }
    active.current?.controller.abort();
  };
  const cancelRow = (row) => {
    if (active.current?.id === row.id) {
      active.current.controller.abort();
    } else if (row.status === "queued") {
      skipped.current.add(row.id);
      update(row.id, { status: "cancelled", loaded: 0, error: "" });
    } else if (row.status === "paused") {
      void cancelPaused(row);
    }
  };
  const cancelPaused = async (row) => {
    const connection = client.current;
    if (running.current || !connection) return;
    running.current = true;
    setWorking(true);
    setCancelling(true);
    onWorking?.(true);
    try {
      const status = await connection.cancelResumable(
        batchID.current,
        row.task.id,
      );
      update(row.id, {
        status,
        loaded: status === "complete" ? row.file.size : 0,
        error: "",
      });
      const info = await connection.info(AbortSignal.timeout(5000));
      if (mounted.current && client.current === connection) setLink(info);
    } catch (err) {
      if (mounted.current && client.current === connection)
        setError(err.message);
    } finally {
      running.current = false;
      if (mounted.current) {
        setWorking(false);
        setCancelling(false);
        onWorking?.(false);
      }
    }
  };
  const remaining = link ? Math.max(0, link.maxTotalBytes - link.usedBytes) : 0;
  const available =
    link &&
    !error &&
    remaining > 0 &&
    link.usedFiles < link.maxFiles &&
    Date.parse(link.expiresAt) > Date.now();
  useEffect(() => {
    if (!available || !selection.current?.length) return;
    const files = selection.current;
    selection.current = null;
    void receive(files);
  }, [available]);
  const total = rows.reduce((sum, row) => sum + row.file.size, 0);
  const loaded = rows.reduce(
    (sum, row) => sum + Math.max(0, Math.min(row.loaded, row.file.size)),
    0,
  );
  const completed = rows.filter((row) => row.status === "complete").length;
  const percent =
    completed === rows.length
      ? 100
      : total
        ? Math.min(99, Math.floor((loaded / total) * 100))
        : 0;
  const priority = {
    uploading: 0,
    queued: 1,
    paused: 2,
    failed: 2,
    complete: 3,
    cancelled: 4,
  };
  const orderedRows = [...rows].sort(
    (a, b) => priority[a.status] - priority[b.status],
  );
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
        <div class="upload-brand">
          <Icon name="portal" />
          <span>{siteTitle}</span>
        </div>
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
            <button
              class="secondary-button"
              disabled={working}
              onClick={() => setRevision((value) => value + 1)}
            >
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
                <li key={row.id} class={`upload-file ${row.status}`}>
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
                      role={
                        row.status === "uploading" ? "progressbar" : "status"
                      }
                      aria-label={
                        row.status === "uploading"
                          ? t("account.uploadProgress", { name: row.file.name })
                          : undefined
                      }
                      aria-valuemin={row.status === "uploading" ? 0 : undefined}
                      aria-valuemax={
                        row.status === "uploading" ? 100 : undefined
                      }
                      aria-valuenow={
                        row.status === "uploading"
                          ? Math.min(
                              100,
                              Math.floor(
                                (row.loaded / (row.file.size || 1)) * 100,
                              ),
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
                                        (row.loaded / (row.file.size || 1)) *
                                          100,
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
                      disabled={
                        cancelling || (row.status === "paused" && working)
                      }
                      onClick={() => cancelRow(row)}
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
                            if (file) void receive([file], row);
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                    </div>
                  )}
                </li>
              ))}
            </ul>
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
