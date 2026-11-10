import { t, locale } from "../../shared/i18n.js";
import { coreError } from "./errors.js";
import { DirectTransport } from "./transport.js";
import { backendPaths } from "../../shared/backend-paths.js";

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
    return this.request(this.path, { signal });
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
  async sendHTTP(path, file, signal, onProgress) {
    signal?.throwIfAborted();
    const endpoint = new URL(path, this.transport.config.endpoint);
    if (
      location.protocol === "https:" &&
      endpoint.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    )
      throw coreError("UPLOAD_HTTPS_REQUIRED");
    const headers = await this.headers("PUT", path, signal);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = () => signal?.removeEventListener("abort", abort);
      xhr.open("PUT", endpoint);
      for (const [name, value] of Object.entries(headers))
        xhr.setRequestHeader(name, value);
      xhr.setRequestHeader("Accept-Language", locale);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded, event.total);
      };
      xhr.onload = () => {
        finish();
        resolve(new Response(xhr.responseText, { status: xhr.status }));
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
  async upload(file, { signal, onProgress } = {}) {
    const task = await this.request(this.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size }),
      signal,
    });
    if (!/^[a-f0-9]{32}$/.test(task?.id ?? ""))
      throw coreError("UPLOAD_CONNECTION_INTERRUPTED");
    const path = `${this.path}/${task.id}`;
    try {
      const response =
        this.transport.config.transport === "http"
          ? await this.sendHTTP(path, file, signal, onProgress)
          : await this.send(path, {
              method: "PUT",
              headers: { "Content-Type": "application/octet-stream" },
              body: file,
              signal,
              onUploadProgress: onProgress,
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
