import { t, locale } from "../../shared/i18n.js";
import { coreError } from "./errors.js";
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
      throw coreError("WEBTRANSPORT_UNSUPPORTED");
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
              () => reject(coreError("CONNECTION_TIMEOUT")),
              12000,
            );
          }),
        ]);
        if (this.pending !== session)
          throw new DOMException(t("core.connectionCancelled"), "AbortError");
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
  async request(
    path,
    { method = "GET", headers = {}, body, signal, onUploadProgress } = {},
  ) {
    signal?.throwIfAborted();
    const auth = authorization(this.credentials);
    const outgoing = new Headers(headers);
    outgoing.set("Accept-Language", locale);
    if (auth) outgoing.set("Authorization", auth);
    if (this.config.transport === "http") {
      const endpoint = new URL(this.config.endpoint);
      if (
        location.protocol === "https:" &&
        endpoint.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      )
        throw coreError("MIXED_CONTENT");
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
        throw coreError("BACKEND_UNREACHABLE");
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
      const blob = body instanceof Blob ? body : null;
      const bytes =
        body == null
          ? new Uint8Array()
          : body instanceof Uint8Array
            ? body
            : blob
              ? new Uint8Array()
              : new TextEncoder().encode(String(body));
      const length = blob ? blob.size : bytes.length;
      // Insert this after Headers construction, never through a guarded browser Request.
      if (this.config.gatewayAuth && this.credentials.gatewayToken)
        outgoing.set(
          "Proxy-Authorization",
          "Bearer " + this.credentials.gatewayToken,
        );
      const sending = (async () => {
        try {
          await writer.write(requestBytes(method, path, outgoing, length));
          if (blob) {
            const reader = blob.stream().getReader();
            let loaded = 0;
            try {
              while (true) {
                signal?.throwIfAborted();
                const { done, value } = await reader.read();
                if (done) break;
                for (let offset = 0; offset < value.length; offset += 65536) {
                  signal?.throwIfAborted();
                  const chunk = value.subarray(offset, offset + 65536);
                  await writer.write(chunk);
                  loaded += chunk.length;
                  onUploadProgress?.(loaded, length);
                }
              }
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          } else if (bytes.length) {
            await writer.write(bytes);
            onUploadProgress?.(bytes.length, length);
          }
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
