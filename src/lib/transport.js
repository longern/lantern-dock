import { WireReader, readResponse, requestBytes } from "./http-wire.js";
export function basicAuthorization(username, password) {
  return (
    "Basic " +
    btoa(
      String.fromCharCode(
        ...new TextEncoder().encode(`${username}:${password}`),
      ),
    )
  );
}
export function authorization(credentials = {}) {
  if (credentials.mode === "basic")
    return basicAuthorization(
      credentials.username || "",
      credentials.password || "",
    );
  if (credentials.mode === "bearer" && credentials.bearer)
    return "Bearer " + credentials.bearer;
  return "";
}
export function pinOptions(certificates) {
  return certificates.map((pin) => ({
    algorithm: "sha-256",
    value: Uint8Array.from(atob(pin.value), (c) => c.charCodeAt(0)),
  }));
}
export class DirectTransport {
  constructor(config, credentials = {}) {
    this.config = config;
    this.credentials = credentials;
    this.session = null;
    this.pending = null;
    this.connecting = null;
  }
  close() {
    this.pending?.close();
    this.session?.close();
    this.pending = null;
    this.session = null;
    this.connecting = null;
  }
  async connect() {
    if (this.session) return this.session;
    if (this.connecting) return this.connecting;
    if (typeof WebTransport === "undefined")
      throw new Error(
        "此浏览器不支持 WebTransport，请使用支持该功能的浏览器，或将后端配置为 HTTPS。",
      );
    const connecting = (async () => {
      const session = new WebTransport(
        this.config.endpoint,
        this.config.certificates?.length
          ? { serverCertificateHashes: pinOptions(this.config.certificates) }
          : {},
      );
      this.pending = session;
      let timer;
      const closed = () => {
        if (this.session === session) this.session = null;
      };
      // closed can reject before ready (bad pins, cancellation or network failure).
      session.closed.then(closed, closed);
      try {
        await Promise.race([
          session.ready,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "连接超时，请检查 UDP 隧道、网页 Origin 和证书哈希。",
                  ),
                ),
              12000,
            );
          }),
        ]);
        if (this.pending !== session)
          throw new DOMException("连接已取消", "AbortError");
        this.session = session;
        return session;
      } catch (error) {
        session.close();
        throw error;
      } finally {
        clearTimeout(timer);
        if (this.pending === session) this.pending = null;
      }
    })();
    this.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }
  async request(path, { method = "GET", headers = {}, body, signal } = {}) {
    signal?.throwIfAborted();
    const auth = authorization(this.credentials);
    const outgoing = new Headers(headers);
    if (auth) outgoing.set("Authorization", auth);
    if (this.config.transport === "http") {
      const endpoint = new URL(this.config.endpoint);
      if (
        location.protocol === "https:" &&
        endpoint.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      )
        throw new Error(
          "HTTPS 网页无法直接访问此明文 HTTP 地址。请使用 HTTPS 后端，或改用 WebTransport。",
        );
      try {
        return await fetch(new URL(path, endpoint), {
          method,
          headers: outgoing,
          body,
          signal,
          credentials: "omit",
          mode: "cors",
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(
          "无法直连后端。请检查地址、HTTPS 证书、网络，以及 WebDAV 的 CORS / OPTIONS 配置。",
        );
      }
    }
    const session = await this.connect();
    signal?.throwIfAborted();
    const stream = await session.createBidirectionalStream();
    const wire = new WireReader(stream.readable.getReader());
    const writer = stream.writable.getWriter();
    const abort = () => {
      void wire.cancel(signal?.reason);
      void writer.abort(signal?.reason).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      throw signal.reason;
    }
    try {
      const bytes =
        body == null
          ? new Uint8Array()
          : body instanceof Uint8Array
            ? body
            : new TextEncoder().encode(String(body));
      // Insert this after Headers construction, never through a guarded browser Request.
      if (this.config.gatewayAuth && this.credentials.gatewayToken)
        outgoing.set(
          "Proxy-Authorization",
          "Bearer " + this.credentials.gatewayToken,
        );
      const sending = (async () => {
        try {
          await writer.write(requestBytes(method, path, outgoing, bytes));
          if (bytes.length) await writer.write(bytes);
          await writer.close();
        } finally {
          writer.releaseLock();
        }
      })();
      // The bridge may reject headers (e.g. 407) before consuming the body,
      // stopping our send direction while its HTTP response is still arriving.
      // Observe send failures without cancelling that independent receive side.
      const sent = sending.then(
        () => null,
        (error) => error,
      );
      const response = await readResponse(wire, {
        method,
        finish: () => signal?.removeEventListener("abort", abort),
      });
      const sendError = await sent;
      if (sendError && response.ok) {
        await response.body?.cancel(sendError);
        throw sendError;
      }
      return response;
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      abort();
      throw error;
    }
  }
}
