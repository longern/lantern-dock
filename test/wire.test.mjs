import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  WireReader,
  readResponse,
  requestBytes,
} from "../src/lib/http-wire.js";
const encode = (text) => new TextEncoder().encode(text);
function wire(chunks) {
  return new WireReader(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(typeof chunk === "string" ? encode(chunk) : chunk);
        controller.close();
      },
    }).getReader(),
  );
}
test("Content-Length framing handles every byte boundary and binary data", async () => {
  const bytes = encode(
    "HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Range: bytes 0-3/8\r\n\r\n",
  );
  const input = new Uint8Array([...bytes, 0, 255, 13, 10]);
  const r = await readResponse(
    wire(Array.from(input, (value) => new Uint8Array([value]))),
  );
  assert.equal(r.status, 206);
  assert.deepEqual(
    [...new Uint8Array(await r.arrayBuffer())],
    [0, 255, 13, 10],
  );
  assert.equal(r.headers.get("Content-Range"), "bytes 0-3/8");
});
test("chunked body, extensions, interim responses and trailers", async () => {
  const r = await readResponse(
    wire([
      "HTTP/1.1 103 Early Hints\r\nLink: </test>\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
      "3;foo=bar\r\na",
      "bc\r\n2\r\nde\r\n0\r\nX-End: yes\r\n\r\n",
    ]),
  );
  assert.equal(await r.text(), "abcde");
  assert.equal(r.headers.has("Transfer-Encoding"), false);
});
test("streaming response is available before body completion", async () => {
  let controller;
  const source = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(
        encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"),
      );
    },
  });
  const r = await readResponse(new WireReader(source.getReader()));
  const reader = r.body.getReader();
  controller.enqueue(encode("3\r\nabc\r\n"));
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "abc");
  controller.enqueue(encode("0\r\n\r\n"));
  controller.close();
  assert.equal((await reader.read()).done, true);
});
test("HEAD and 204 do not wait for a body", async () => {
  const r = await readResponse(
    wire(["HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n"]),
    { method: "HEAD" },
  );
  assert.equal(r.body, null);
  const empty = await readResponse(wire(["HTTP/1.1 204 No Content\r\n\r\n"]));
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
});
test("ambiguous framing and truncated bodies fail", async () => {
  await assert.rejects(
    readResponse(
      wire([
        "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n",
      ]),
    ),
    { code: "HTTP_FRAMING_INVALID" },
  );
  await assert.rejects(
    readResponse(
      wire([
        "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n",
      ]),
    ),
    { code: "HTTP_CONTENT_LENGTH_DUPLICATE" },
  );
  const r = await readResponse(
    wire(["HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabc"]),
  );
  await assert.rejects(r.arrayBuffer(), { code: "HTTP_BODY_TRUNCATED" });
  const chunked = await readResponse(
    wire(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nab"]),
  );
  await assert.rejects(chunked.arrayBuffer(), { code: "HTTP_CHUNK_TRUNCATED" });
});
test("close-delimited bodies and gzip decode without buffering full response", async () => {
  const r = await readResponse(wire(["HTTP/1.1 200 OK\r\n\r\nhello"]));
  assert.equal(await r.text(), "hello");
  const compressed = gzipSync("compressed");
  const gzip = await readResponse(
    wire([
      `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${compressed.length}\r\n\r\n`,
      compressed,
    ]),
  );
  assert.equal(await gzip.text(), "compressed");
  assert.equal(gzip.headers.has("Content-Encoding"), false);
});
test("request serialization preserves separate backend and gateway credentials", () => {
  const data = requestBytes(
    "PROPFIND",
    "/dav/a%20b/",
    {
      Authorization: "Basic abc",
      "Proxy-Authorization": "Bearer gateway",
      Depth: "1",
    },
    encode("é"),
  );
  const raw = new TextDecoder().decode(data);
  assert.match(raw, /authorization: Basic abc/);
  assert.match(raw, /proxy-authorization: Bearer gateway/);
  assert.match(raw, /content-length: 2/);
  assert.throws(() => requestBytes("GET", "/x\r\nX-Bad: yes", {}), {
    code: "HTTP_TARGET_INVALID",
  });
});
test("cancelling a response cancels its WebTransport reader", async () => {
  let cancelled = false;
  const source = new ReadableStream({
    start(c) {
      c.enqueue(encode("HTTP/1.1 200 OK\r\n\r\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const r = await readResponse(new WireReader(source.getReader()));
  await r.body.cancel();
  assert.ok(cancelled);
});
