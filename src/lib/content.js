import { coreError } from "./errors.js";
export async function limitedBytes(response, limit, signal, onProgress) {
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > limit) {
    await response.body?.cancel();
    throw coreError("MEMORY_LIMIT");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw coreError("MEMORY_LIMIT");
      chunks.push(value);
      onProgress?.(total);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of chunks) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
