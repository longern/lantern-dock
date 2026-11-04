import test from "node:test";
import assert from "node:assert/strict";
import { DirectTransport } from "../src/lib/transport.js";

test("early HTTP rejection remains readable when the bridge stops the request upload", async (t) => {
  const stopped = new Error("STOP_SENDING");
  let incoming;
  const stream = {
    readable: new ReadableStream({
      start(controller) {
        incoming = controller;
      },
    }),
    writable: new WritableStream({
      write() {
        throw stopped;
      },
    }),
  };
  const transport = new DirectTransport({ transport: "webtransport" });
  transport.connect = async () => ({
    createBidirectionalStream: async () => stream,
  });
  const response = transport.request("/public/", {
    method: "PROPFIND",
    body: "<propfind/>",
  });
  // Delay the response until after STOP_SENDING, reproducing independent QUIC directions.
  await new Promise((resolve) => setTimeout(resolve, 10));
  incoming.enqueue(
    new TextEncoder().encode(
      "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 4\r\n\r\nnope",
    ),
  );
  incoming.close();
  const result = await response;
  assert.equal(result.status, 407);
  assert.equal(await result.text(), "nope");
});

test("send failure is still surfaced when a peer incorrectly returns success", async () => {
  const stopped = new Error("upload failed");
  const transport = new DirectTransport({ transport: "webtransport" });
  transport.connect = async () => ({
    createBidirectionalStream: async () => ({
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
            ),
          );
          controller.close();
        },
      }),
      writable: new WritableStream({
        write() {
          throw stopped;
        },
      }),
    }),
  });
  await assert.rejects(
    transport.request("/public/", { method: "PROPFIND", body: "test" }),
    /upload failed/,
  );
});

test("closing during a handshake cannot resurrect an old session or clobber a new connection", async (t) => {
  const sessions = [];
  class Session {
    constructor() {
      this.pending = Promise.withResolvers();
      this.ready = this.pending.promise;
      this.closed = new Promise(() => {});
      this.closeCount = 0;
      sessions.push(this);
    }
    close() {
      this.closeCount++;
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebTransport");
  Object.defineProperty(globalThis, "WebTransport", {
    configurable: true,
    writable: true,
    value: Session,
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "WebTransport", original);
    else delete globalThis.WebTransport;
  });
  const transport = new DirectTransport({
    endpoint: "https://bridge.invalid/webtransport",
  });
  const old = transport.connect();
  const rejected = assert.rejects(old, { name: "AbortError" });
  transport.close();
  const current = transport.connect();
  sessions[0].pending.resolve();
  await rejected;
  assert.ok(sessions[0].closeCount);
  assert.ok(transport.connecting);
  sessions[1].pending.resolve();
  assert.equal(await current, sessions[1]);
  assert.equal(transport.session, sessions[1]);
  transport.close();
});
