import { t } from "../../shared/i18n.js";
import { coreError } from "../lib/errors.js";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  createDownloadFile,
  downloadMemoryLimit,
  receiveFile,
} from "../lib/download.js";

export function useDownload(connection, remember, toast) {
  const active = useRef(null);
  const sequence = useRef(0);
  const [progress, setProgress] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [batch, setBatch] = useState(0);
  useLayoutEffect(() => {
    setTasks([]);
    setProgress(null);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [connection]);
  const cancel = () => active.current?.abort();
  const downloadMany = async (selection) => {
    if (active.current) {
      toast(t("core.downloadInProgress"));
      return false;
    }
    const items = [...selection];
    if (!items.length) return false;
    if (items.some((item) => item.isDirectory)) {
      toast(t("library.downloadFilesOnly"), true);
      return false;
    }
    const controller = new AbortController();
    active.current = controller;
    const entries = items.map((item) => ({
      id: ++sequence.current,
      item,
      status: "queued",
      received: 0,
      total: item.size || 0,
    }));
    const update = (id, value) => {
      if (active.current !== controller) return;
      setTasks((current) =>
        current.map((task) => (task.id === id ? { ...task, ...value } : task)),
      );
    };
    setTasks((current) => [
      ...current
        .filter(
          (task) => !["queued", "preparing", "running"].includes(task.status),
        )
        .slice(Math.max(0, current.length + items.length - 100)),
      ...entries,
    ]);
    setBatch(entries[0].id);
    update(entries[0].id, { status: "preparing" });
    setProgress({
      id: entries[0].id,
      name: items[0].name,
      index: 1,
      count: items.length,
      received: 0,
      total: 0,
    });
    const signal = controller.signal;
    const completed = [];
    let currentIndex = 0,
      lastProgress = { received: 0, total: 0 };
    let directory,
      sink,
      created,
      nativeDestination = false,
      buffered = 0;
    try {
      // Request a destination within the original click's user activation.
      if (
        items.length > 1 &&
        typeof window.showDirectoryPicker === "function"
      ) {
        directory = await window.showDirectoryPicker({ mode: "readwrite" });
        nativeDestination = true;
      } else if (
        items.length === 1 &&
        typeof window.showSaveFilePicker === "function"
      ) {
        const handle = await window.showSaveFilePicker({
          suggestedName: items[0].name,
        });
        sink = await handle.createWritable();
        nativeDestination = true;
      } else if (
        items.reduce((sum, item) => sum + (item.size || 0), 0) >
        downloadMemoryLimit
      )
        throw coreError(
          items.length > 1
            ? "DOWNLOAD_BATCH_MEMORY_LIMIT"
            : "DOWNLOAD_FILE_API_REQUIRED",
        );
      signal.throwIfAborted();
      for (let index = 0; index < items.length; index++) {
        currentIndex = index;
        signal.throwIfAborted();
        const item = items[index];
        lastProgress = { received: 0, total: item.size || 0 };
        update(entries[index].id, { status: "running" });
        if (directory) {
          created = await createDownloadFile(directory, item.name, signal);
          sink = await created.handle.createWritable();
        }
        signal.throwIfAborted();
        setProgress({
          id: entries[index].id,
          name: item.name,
          index: index + 1,
          count: items.length,
          received: 0,
          total: 0,
        });
        const blob = await receiveFile(connection.client, item, {
          signal,
          sink,
          budget: downloadMemoryLimit - buffered,
          limitCode:
            items.length > 1
              ? "DOWNLOAD_BATCH_MEMORY_LIMIT"
              : "DOWNLOAD_MEMORY_LIMIT",
          onProgress: (value) => {
            lastProgress = value;
            if (active.current !== controller) return;
            setProgress({
              id: entries[index].id,
              name: item.name,
              index: index + 1,
              count: items.length,
              ...value,
            });
          },
        });
        signal.throwIfAborted();
        const saved = !!sink;
        if (sink) {
          await sink.close();
          sink = null;
          created = null;
        } else {
          buffered += blob.size;
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = item.name;
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
        completed.push(item);
        update(entries[index].id, {
          status: saved ? "saved" : "submitted",
          ...lastProgress,
        });
      }
      if (active.current === controller)
        toast(
          items.length === 1 && nativeDestination
            ? t("core.downloadComplete", { name: items[0].name })
            : t(
                nativeDestination
                  ? "library.downloadsSaved"
                  : "library.downloadsRequested",
                { count: completed.length },
              ),
        );
      return true;
    } catch (error) {
      if (sink) await sink.abort().catch(() => {});
      if (directory && created)
        await directory.removeEntry(created.name).catch(() => {});
      const cancelled = signal.aborted || error.name === "AbortError";
      update(entries[currentIndex].id, {
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? null : error.message,
        ...lastProgress,
      });
      for (let index = currentIndex + 1; index < entries.length; index++)
        update(entries[index].id, { status: "cancelled" });
      if (active.current === controller)
        toast(
          cancelled ? t("core.downloadCancelled") : error.message,
          !cancelled,
        );
      return false;
    } finally {
      if (active.current === controller) {
        if (completed.length) remember(completed);
        setTasks((current) => current.slice(-100));
        active.current = null;
        setProgress(null);
      }
    }
  };
  return {
    download: (item) => downloadMany([item]),
    downloadMany,
    cancel,
    progress,
    tasks,
    batch,
    clearFinished: () =>
      setTasks((current) =>
        current.filter((task) =>
          ["queued", "preparing", "running"].includes(task.status),
        ),
      ),
  };
}
