import { t, locale } from "../../shared/i18n.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { UploadClient, uploadBatchKey } from "../lib/uploads.js";
import { bytes, date } from "../lib/format.js";
import { siteTitle } from "../lib/site-title.js";

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
      <a class="setup-brand" href="/">
        <span class="brand-symbol">
          <Icon name="portal" />
        </span>
        <span>{siteTitle}</span>
      </a>
      <section class="setup-card" aria-labelledby="upload-title">
        <UploadPanel token={token} />
        <a class="upload-back" href="/">
          {t("account.backToPublicFiles")}
        </a>
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
}) {
  const [link, setLink] = useState(null);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([]);
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  const client = useRef(null);
  const active = useRef(null);
  const running = useRef(false);
  const mounted = useRef(false);
  const selection = useRef(initialFiles);
  const batchKey = useRef(null);
  const batchID = useRef(null);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const stop = () => {
      active.current?.abort();
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
      active.current?.abort();
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
    if (running.current || !client.current || !link || !files.length) return;
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
    setWorking(true);
    onWorking?.(true);
    running.current = true;
    try {
      for (const row of batch) {
        if (!mounted.current || client.current !== connection) break;
        const controller = new AbortController();
        active.current = controller;
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
            loaded: status === "complete" ? row.file.size : confirmed,
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
      running.current = false;
      if (mounted.current) {
        setWorking(false);
        onWorking?.(false);
      }
    }
  };
  const cancelPaused = async (row) => {
    const connection = client.current;
    if (running.current || !connection) return;
    running.current = true;
    setWorking(true);
    try {
      const status = await connection.cancelResumable(
        batchID.current,
        row.task.id,
      );
      update(row.id, { status, error: "" });
      const info = await connection.info(AbortSignal.timeout(5000));
      if (mounted.current && client.current === connection) setLink(info);
    } catch (err) {
      if (mounted.current && client.current === connection)
        setError(err.message);
    } finally {
      running.current = false;
      if (mounted.current) setWorking(false);
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
  return (
    <>
      {personalClient ? (
        <p class="dialog-intro">
          {t(
            direct
              ? "admin.directUploadDescription"
              : "admin.personalUploadDescription",
          )}
        </p>
      ) : (
        <div class="setup-intro">
          <span class="setup-eyebrow">{t("account.temporaryInbox")}</span>
          <h1 id="upload-title">{link?.title || t("account.receiveFiles")}</h1>
          <p>{t("account.uploadPrivacy")}</p>
        </div>
      )}
      {!link && !error && (
        <p class="upload-message" role="status">
          {t("account.connectingInbox")}
        </p>
      )}
      {link && !personalClient && (
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
              {Math.max(0, link.maxFiles - link.usedFiles).toLocaleString(
                locale,
              )}
            </dd>
          </div>
          <div>
            <dt>{t("account.expiresAt")}</dt>
            <dd>{date(link.expiresAt, true)}</dd>
          </div>
        </dl>
      )}
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
      {link && !error && (
        <label
          class={`upload-drop${working || !available ? " disabled" : ""}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (available) void receive(event.dataTransfer.files);
          }}
        >
          <Icon name="upload" />
          <strong>
            {working
              ? t("account.uploadingFiles")
              : available
                ? t("account.chooseOrDropFiles")
                : t("account.inboxUnavailable")}
          </strong>
          <span>
            {working
              ? t("account.keepPageOpen")
              : t("account.multipleFilesHelp")}
          </span>
          <input
            type="file"
            multiple
            disabled={working || !available}
            aria-label={t("account.chooseUploadFiles")}
            onChange={(event) => {
              const files = event.currentTarget.files;
              if (files?.length) void receive(files);
              event.currentTarget.value = "";
            }}
          />
        </label>
      )}
      {!!rows.length && (
        <ul class="upload-results" aria-label={t("account.currentUploads")}>
          {rows.map((row) => (
            <li key={row.id}>
              <div class="upload-file-heading">
                <strong>{row.file.name}</strong>
                <span>{bytes(row.file.size)}</span>
              </div>
              {row.status === "uploading" && (
                <>
                  <progress
                    value={row.loaded}
                    max={row.file.size || 1}
                    aria-label={t("account.uploadProgress", {
                      name: row.file.name,
                    })}
                  />
                  <div class="upload-file-status">
                    <span>
                      {row.loaded >= row.file.size
                        ? t("account.confirmingReceipt")
                        : t("account.uploadBytes", {
                            loaded: bytes(row.loaded),
                            total: bytes(row.file.size),
                          })}
                    </span>
                    <button
                      class="text-button"
                      onClick={() => active.current?.abort()}
                    >
                      {t("account.cancelUpload")}
                    </button>
                  </div>
                </>
              )}
              {row.status === "paused" && (
                <div class="upload-file-status upload-resume-actions">
                  <span>
                    {t("account.uploadBytes", {
                      loaded: bytes(row.loaded),
                      total: bytes(row.file.size),
                    })}
                  </span>
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
                  <button
                    class="text-button"
                    disabled={working}
                    onClick={() => void cancelPaused(row)}
                  >
                    {t("account.cancelUpload")}
                  </button>
                </div>
              )}
              <span class={`upload-result ${row.status}`} role="status">
                {row.status === "complete"
                  ? t("account.received")
                  : row.status === "queued"
                    ? t("account.queuedUpload")
                    : row.status === "cancelled"
                      ? t("account.cancelledUpload")
                      : row.status === "failed"
                        ? row.error
                        : row.status === "paused"
                          ? row.error || t("account.uploadPaused")
                          : t("account.uploading")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
