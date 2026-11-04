import { useEffect, useRef, useState } from "preact/hooks";

const memoryLimit = 256 * 1024 * 1024;

export function useDownload(connection, remember, toast) {
  const active = useRef(null);
  const [progress, setProgress] = useState(null);
  useEffect(() => () => active.current?.abort(), [connection]);
  const cancel = () => active.current?.abort();
  const download = async (item) => {
    if (active.current) {
      toast("请先等待当前下载结束，或取消后重试。");
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    let sink;
    try {
      if ("showSaveFilePicker" in window) {
        const handle = await window.showSaveFilePicker({
          suggestedName: item.name,
        });
        sink = await handle.createWritable();
      } else if (item.size > memoryLimit)
        throw new Error(
          "此浏览器的内存下载上限为 256 MB，请使用支持文件保存 API 的浏览器下载大文件。",
        );
      controller.signal.throwIfAborted();
      setProgress({ name: item.name, received: 0, total: 0 });
      const response = await connection.client.get(
        item.path,
        controller.signal,
      );
      const total =
        Number(response.headers.get("Content-Length")) || item.size || 0;
      if (!sink && total > memoryLimit) {
        await response.body?.cancel();
        throw new Error("文件超过此浏览器的 256 MB 内存下载限制。");
      }
      const chunks = [];
      let received = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            controller.signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (sink) await sink.write(value);
            else {
              if (received > memoryLimit)
                throw new Error("文件超过此浏览器的 256 MB 内存下载限制。");
              chunks.push(value);
            }
            setProgress({ name: item.name, received, total });
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
      }
      controller.signal.throwIfAborted();
      if (sink) {
        await sink.close();
        sink = null;
      } else {
        const url = URL.createObjectURL(
          new Blob(chunks, {
            type:
              response.headers.get("Content-Type") ||
              "application/octet-stream",
          }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = item.name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      remember(item);
      toast("下载完成：" + item.name);
    } catch (error) {
      if (sink) await sink.abort().catch(() => {});
      const cancelled =
        controller.signal.aborted || error.name === "AbortError";
      toast(cancelled ? "已取消下载" : error.message, !cancelled);
    } finally {
      if (active.current === controller) {
        active.current = null;
        setProgress(null);
      }
    }
  };
  return { download, cancel, progress };
}
