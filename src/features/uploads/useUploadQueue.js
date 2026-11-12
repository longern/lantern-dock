import { t } from "../../../shared/i18n.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { UploadClient, uploadBatchKey } from "../../lib/uploads.js";
import { fetchConfiguration } from "../../lib/configuration.js";

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

export function useUploadQueue({
  token,
  personalClient,
  onWorking,
  initialFiles,
  direct,
}) {
  const [link, setLink] = useState(null);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([]);
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState(0);
  const [nextTasks, setNextTasks] = useState(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [tasksError, setTasksError] = useState("");
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
  const tasksRequest = useRef(null);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const stop = () => {
      active.current?.controller.abort();
      tasksRequest.current?.abort();
      client.current?.close();
    };
    const reopen = (event) => {
      if (event.persisted) setRevision((value) => value + 1);
    };
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", reopen);
    setLink(null);
    setError("");
    setNextTasks(null);
    setLoadingTasks(false);
    setTasksError("");
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
        const response = await fetchConfiguration(controller.signal);
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
            const { tasks, next } = await connection.resumableTasks(
              batchID.current,
              controller.signal,
            );
            if (controller.signal.aborted) return;
            setRows(tasks.map(restoredRow));
            setNextTasks(next);
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
      tasksRequest.current?.abort();
      tasksRequest.current = null;
      active.current?.controller.abort();
      client.current?.close();
      client.current = null;
    };
  }, [token, revision, personalClient]);
  const loadMoreTasks = async () => {
    const connection = client.current;
    if (!connection || !nextTasks || tasksRequest.current) return;
    const request = new AbortController();
    tasksRequest.current = request;
    setLoadingTasks(true);
    setTasksError("");
    try {
      const { tasks, next } = await connection.resumableTasks(
        batchID.current,
        request.signal,
        nextTasks,
      );
      if (request.signal.aborted) return;
      setRows((current) => {
        const seen = new Set(current.map((row) => row.task?.id || row.id));
        return [
          ...current,
          ...tasks.filter((task) => !seen.has(task.id)).map(restoredRow),
        ];
      });
      setNextTasks(next);
    } catch (err) {
      if (!request.signal.aborted) setTasksError(err.message);
    } finally {
      if (tasksRequest.current === request) {
        tasksRequest.current = null;
        if (!request.signal.aborted) setLoadingTasks(false);
      }
    }
  };
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
  return {
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
    retry: () => setRevision((value) => value + 1),
  };
}
