import { coreError } from "./errors.js";

export const downloadMemoryLimit = 256 * 1024 * 1024;

// The remaining batch budget includes already issued Blob downloads.
export async function receiveFile(
  client,
  item,
  { signal, sink, budget, onProgress, limitCode = "DOWNLOAD_MEMORY_LIMIT" },
) {
  signal.throwIfAborted();
  const response = await client.get(item.path, signal);
  const total =
    Number(response.headers.get("Content-Length")) || item.size || 0;
  if (!sink && total > budget) {
    await response.body?.cancel();
    throw coreError(limitCode);
  }
  const chunks = [];
  let received = 0;
  const reader = response.body?.getReader();
  const abort = () => reader?.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    onProgress({ received, total });
    if (reader)
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (sink) await sink.write(value);
        else {
          if (received > budget) throw coreError(limitCode);
          chunks.push(value);
        }
        onProgress({ received, total });
      }
    signal.throwIfAborted();
    return sink
      ? null
      : new Blob(chunks, {
          type:
            response.headers.get("Content-Type") || "application/octet-stream",
        });
  } catch (error) {
    await reader?.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader?.releaseLock();
  }
}

// Directory access has no per-file overwrite confirmation. Choose an unused
// name rather than opening an existing destination for writing.
export async function createDownloadFile(directory, name, signal) {
  if (!name || [".", ".."].includes(name) || /[\/\\\x00-\x1f]/.test(name))
    throw coreError("INVALID_PATH");
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 0; index < 10000; index++) {
    signal.throwIfAborted();
    const candidate = index ? `${base} (${index})${extension}` : name;
    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (error.name === "TypeMismatchError") continue;
      if (error.name !== "NotFoundError") throw error;
      signal.throwIfAborted();
      return {
        name: candidate,
        handle: await directory.getFileHandle(candidate, { create: true }),
      };
    }
  }
  throw coreError("DOWNLOAD_NAME_CONFLICT");
}
