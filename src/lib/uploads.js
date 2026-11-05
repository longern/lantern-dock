import { DirectTransport } from "./transport.js";

export async function uploadResponse(response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      value.error ||
        (response.status === 407
          ? "收件网关需要认证，请联系收件人检查配置。"
          : `收件服务返回 ${response.status}，请稍后重试。`),
    );
    error.code = value.code;
    error.status = response.status;
    throw error;
  }
  return value;
}

export class UploadClient {
  constructor(backend, token) {
    this.transport = new DirectTransport(backend, {
      mode: "bearer",
      bearer: token,
    });
    this.token = token;
    this.closed = false;
  }
  close() {
    this.closed = true;
    this.transport.close();
  }
  async info(signal) {
    return this.request("/api/uploads", { signal });
  }
  async request(path, options) {
    if (this.closed) throw new DOMException("连接已关闭", "AbortError");
    return uploadResponse(await this.transport.request(path, options));
  }
  async sendHTTP(path, file, signal, onProgress) {
    signal?.throwIfAborted();
    const endpoint = new URL(path, this.transport.config.endpoint);
    if (
      location.protocol === "https:" &&
      endpoint.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    )
      throw new Error("HTTPS 网页需要通过 HTTPS 或 WebTransport 上传文件。");
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = () => signal?.removeEventListener("abort", abort);
      xhr.open("PUT", endpoint);
      xhr.setRequestHeader("Authorization", "Bearer " + this.token);
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
        reject(new Error("上传连接中断，请检查网络后重试。"));
      };
      xhr.onabort = () => {
        finish();
        reject(new DOMException("已取消上传", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      xhr.send(file);
      if (signal?.aborted) abort();
    });
  }
  async upload(file, { signal, onProgress } = {}) {
    const task = await this.request("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size }),
      signal,
    });
    const path = `/api/uploads/${task.id}`;
    try {
      const response =
        this.transport.config.transport === "http"
          ? await this.sendHTTP(path, file, signal, onProgress)
          : await this.transport.request(path, {
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
        const cancelled = await this.transport.request(path, {
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
