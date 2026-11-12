import { t, locale } from "../../shared/i18n.js";
import { coreError } from "./errors.js";
import { DirectTransport } from "./transport.js";
import { backendPaths } from "../../shared/backend-paths.js";

const tusVersion = "1.0.0";
const chunkSize = 4 * 1024 * 1024;
const taskID = /^[a-f0-9]{32}$/;
const tusHeaders = (batch) => ({
  "Tus-Resumable": tusVersion,
  "X-Upload-Batch": batch,
});
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export async function uploadBatchKey(token) {
  return (
    "lantern-dock:upload-batch:" +
    hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))
  );
}

async function fingerprint(file, signal) {
  // Hash every byte with bounded memory. The manifest digest is independent
  // of retries and detects a changed file even when metadata still matches.
  const hashes = new Uint8Array(Math.ceil(file.size / chunkSize) * 32);
  for (let i = 0; i < hashes.length / 32; i++) {
    signal?.throwIfAborted();
    const chunk = file.slice(i * chunkSize, (i + 1) * chunkSize);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      await chunk.arrayBuffer(),
    );
    hashes.set(new Uint8Array(hash), i * 32);
  }
  signal?.throwIfAborted();
  return hex(await crypto.subtle.digest("SHA-256", hashes));
}

function confirmedOffset(response, size) {
  const header = response.headers.get("Upload-Offset");
  const offset = Number(header);
  if (
    !header ||
    !/^\d+$/.test(header) ||
    !Number.isSafeInteger(offset) ||
    offset > size
  )
    throw coreError("UPLOAD_CONNECTION_INTERRUPTED");
  return offset;
}

export async function uploadResponse(response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      value.error ||
        (response.status === 407
          ? t("core.error.UPLOAD_GATEWAY_AUTH")
          : t("core.error.UPLOAD_SERVICE_ERROR", { status: response.status })),
    );
    error.code = value.code;
    error.status = response.status;
    throw error;
  }
  return value;
}

export class UploadClient {
  constructor(backend, token, { path = backendPaths.inbox, authorize } = {}) {
    this.transport = new DirectTransport(backend);
    this.token = token;
    this.path = path;
    this.authorize = authorize;
    this.closed = false;
  }
  close() {
    this.closed = true;
    this.transport.close();
  }
  async info(signal) {
    const response = await this.send(this.path, { signal });
    const value = await uploadResponse(response);
    return {
      ...value,
      resumable:
        !this.authorize && response.headers.get("Tus-Version") === tusVersion,
    };
  }
  async headers(method, path, signal) {
    if (this.closed)
      throw new DOMException(t("core.connectionClosed"), "AbortError");
    const headers = this.authorize
      ? await this.authorize(method, path, signal)
      : { Authorization: "Bearer " + this.token };
    signal?.throwIfAborted();
    if (this.closed)
      throw new DOMException(t("core.connectionClosed"), "AbortError");
    return headers;
  }
  async send(path, { method = "GET", signal, headers, ...options } = {}) {
    const authorization = await this.headers(method, path, signal);
    return this.transport.request(path, {
      ...options,
      method,
      signal,
      headers: { ...headers, ...authorization },
    });
  }
  async request(path, options) {
    return uploadResponse(await this.send(path, options));
  }
  async sendHTTP(
    path,
    file,
    { method = "PUT", signal, onProgress, headers = {} } = {},
  ) {
    signal?.throwIfAborted();
    const endpoint = new URL(path, this.transport.config.endpoint);
    if (
      location.protocol === "https:" &&
      endpoint.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    )
      throw coreError("UPLOAD_HTTPS_REQUIRED");
    const authorization = await this.headers(method, path, signal);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = () => signal?.removeEventListener("abort", abort);
      xhr.open(method, endpoint);
      for (const [name, value] of Object.entries({
        "Content-Type": "application/octet-stream",
        ...headers,
        ...authorization,
      }))
        xhr.setRequestHeader(name, value);
      xhr.setRequestHeader("Accept-Language", locale);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded, event.total);
      };
      xhr.onload = () => {
        finish();
        if (!xhr.status) {
          reject(coreError("UPLOAD_CONNECTION_INTERRUPTED"));
          return;
        }
        const offset =
          method === "PATCH" ? xhr.getResponseHeader("Upload-Offset") : null;
        resolve(
          new Response(xhr.status === 204 ? null : xhr.responseText, {
            status: xhr.status,
            headers: offset === null ? {} : { "Upload-Offset": offset },
          }),
        );
      };
      xhr.onerror = () => {
        finish();
        reject(coreError("UPLOAD_CONNECTION_INTERRUPTED"));
      };
      xhr.onabort = () => {
        finish();
        reject(new DOMException(t("core.uploadCancelled"), "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      xhr.send(file);
      if (signal?.aborted) abort();
    });
  }
  sendFile(path, file, { method, headers, signal, onProgress }) {
    return this.transport.config.transport === "http"
      ? this.sendHTTP(path, file, { method, headers, signal, onProgress })
      : this.send(path, {
          method,
          headers,
          body: file,
          signal,
          onUploadProgress: onProgress,
        });
  }
  async resumableTasks(batch, signal, cursor) {
    const root = this.path + "/resumable";
    const response = await this.send(
      cursor ? root + "?cursor=" + cursor : root,
      {
        headers: tusHeaders(batch),
        signal,
      },
    );
    const tasks = await uploadResponse(response);
    const link = /^<([^>]+)>;\s*rel="next"$/.exec(
      response.headers.get("Link") || "",
    );
    const prefix = root + "?cursor=";
    const next = link?.[1].startsWith(prefix)
      ? link[1].slice(prefix.length)
      : null;
    return {
      tasks,
      next: next && /^[01]\.\d+\.[a-f0-9]{32}$/.test(next) ? next : null,
    };
  }
  async cancelResumable(batch, id) {
    const response = await this.send(this.path + "/resumable/" + id, {
      method: "DELETE",
      headers: tusHeaders(batch),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 410) {
      await response.body?.cancel();
      return "cancelled";
    }
    try {
      await uploadResponse(response);
      return "cancelled";
    } catch (error) {
      if (error.code === "UPLOAD_COMPLETE") return "complete";
      throw error;
    }
  }
  async uploadResumable(file, { batch, task, signal, onTask, onProgress }) {
    const root = this.path + "/resumable";
    const headers = tusHeaders(batch);
    const hash = await fingerprint(file, signal);
    if (
      task &&
      (task.name !== file.name ||
        task.size !== file.size ||
        task.fingerprint !== hash)
    )
      throw coreError("UPLOAD_FILE_MISMATCH");
    let recoverOffset = !!task;
    if (!task) {
      const encode = (value) =>
        btoa(String.fromCharCode(...new TextEncoder().encode(value)));
      const response = await this.send(root, {
        method: "POST",
        signal,
        headers: {
          ...headers,
          "Upload-Length": String(file.size),
          "Upload-Metadata": `filename ${encode(file.name)},fingerprint ${encode(hash)}`,
        },
      });
      if (!response.ok) await uploadResponse(response);
      const location = response.headers.get("Location");
      const id = location?.slice(root.length + 1);
      if (
        response.status !== 201 ||
        !location?.startsWith(root + "/") ||
        !taskID.test(id || "")
      ) {
        await response.body?.cancel();
        throw coreError("UPLOAD_CONNECTION_INTERRUPTED");
      }
      await response.body?.cancel();
      task = { id, name: file.name, size: file.size, fingerprint: hash };
    }
    onTask?.(task);
    const path = root + "/" + task.id;
    let offset = 0;
    let attempts = 0;
    while (offset < file.size || recoverOffset) {
      signal?.throwIfAborted();
      try {
        if (recoverOffset) {
          const response = await this.send(path, {
            method: "HEAD",
            headers,
            signal,
          });
          if (!response.ok) await uploadResponse(response);
          offset = confirmedOffset(response, file.size);
          onProgress?.(offset, true);
          recoverOffset = false;
          if (offset === file.size) break;
        }
        const end = Math.min(file.size, offset + chunkSize);
        const response = await this.sendFile(path, file.slice(offset, end), {
          method: "PATCH",
          headers: {
            ...headers,
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
          },
          signal,
          onProgress: (loaded) => onProgress?.(offset + loaded),
        });
        if (!response.ok) await uploadResponse(response);
        if (
          response.status !== 204 ||
          confirmedOffset(response, file.size) !== end
        )
          throw coreError("UPLOAD_CONNECTION_INTERRUPTED");
        offset = end;
        attempts = 0;
        onProgress?.(offset, true);
      } catch (error) {
        if (
          signal?.aborted ||
          (error.status && error.status !== 409 && error.status < 500) ||
          ++attempts > 2
        )
          throw error;
        recoverOffset = true;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempts));
      }
    }
  }
  async upload(file, { signal, onProgress } = {}) {
    const task = await this.request(this.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size }),
      signal,
    });
    if (!taskID.test(task?.id ?? ""))
      throw coreError("UPLOAD_CONNECTION_INTERRUPTED");
    const path = `${this.path}/${task.id}`;
    try {
      const response = await this.sendFile(path, file, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        signal,
        onProgress,
      });
      return await uploadResponse(response);
    } catch (error) {
      if (this.closed) throw error;
      // A lost acknowledgement must not turn a completed file into a duplicate retry.
      const cleanupSignal = AbortSignal.timeout(5000);
      try {
        const status = await this.request(path, { signal: cleanupSignal });
        if (status.status === "complete") return status;
        if (this.closed) throw error;
        const cancelled = await this.send(path, {
          method: "DELETE",
          signal: cleanupSignal,
        });
        await cancelled.body?.cancel();
        if (cancelled.status === 409) {
          const latest = await this.request(path, { signal: cleanupSignal });
          if (latest.status === "complete") return latest;
        }
      } catch {
        /* The NAS expires abandoned reservations and interrupted uploads. */
      }
      throw error;
    }
  }
}
