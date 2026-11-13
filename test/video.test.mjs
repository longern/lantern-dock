import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { readResponse, WireReader } from "../src/lib/http-wire.js";
import { createVideoSource } from "../src/lib/video.js";
import { MP4MediaSource } from "../src/lib/video-mp4.js";
import { isFreshVideoRange } from "../src/lib/video-cache.js";
const item = { path: "/dav/照片/video.mp4", name: "video.mp4" };
const client = (credentials = { mode: "none" }) => ({
  root: "/dav/",
  transport: {
    config: { transport: "http", endpoint: "https://media.example" },
    credentials,
  },
});

test("public HTTPS videos use the original URL without a parser or background worker", async () => {
  const source = await createVideoSource(client(), item);
  const video = {};
  source.attach(video);
  assert.equal(source.mode, "direct");
  assert.equal(video.crossOrigin, "anonymous");
  assert.equal(
    video.src,
    "https://media.example/dav/%E7%85%A7%E7%89%87/video.mp4",
  );
  source.dispose();
});
test("video sources stay within the DAV root and keep credentials out of URLs", async () => {
  for (const path of [
    "/private/video.mp4",
    "/dav/../video.mp4",
    "//evil.example/video.mp4",
  ])
    await assert.rejects(createVideoSource(client(), { ...item, path }));
  // Authenticated playback must use the page's transport; it cannot silently
  // fall back to putting Basic/Bearer credentials into a native media URL.
  await assert.rejects(
    createVideoSource(
      client({ mode: "bearer", bearer: "private-token" }),
      item,
    ),
    /不支持/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createVideoSource(client(), item, controller.signal), {
    name: "AbortError",
  });
});
function reader(request) {
  return Object.assign(Object.create(MP4MediaSource.prototype), {
    client: { read: request },
    item,
    controller: new AbortController(),
    size: Infinity,
  });
}
test("seeking restarts the range read while a SourceBuffer is removing old frames", () => {
  const request = new AbortController();
  const seeks = [];
  const appended = [];
  let removing = false;
  const source = Object.assign(reader(), {
    request,
    info: {},
    generation: 0,
    queued: 12,
    eof: true,
    media: { readyState: "open" },
    video: { currentTime: 90, buffered: { length: 0 } },
    file: {
      stop() {},
      seek(time, keyframe) {
        seeks.push([time, keyframe]);
        return { offset: 8192 };
      },
      start() {},
    },
    notify() {},
    fail(error) {
      throw error;
    },
  });
  const videoBuffer = {
    current: null,
    queue: [{ bytes: new Uint8Array(8) }],
    source: {
      get updating() {
        return removing;
      },
      buffered: { length: 1, start: () => 0, end: () => 30 },
      remove() {
        removing = true;
      },
      appendBuffer(bytes) {
        appended.push(bytes);
      },
      abort() {
        throw new DOMException(
          "Aborting async remove is disallowed",
          "InvalidStateError",
        );
      },
    },
  };
  const audioBuffer = {
    current: { bytes: new Uint8Array(4), sample: 1 },
    queue: [],
    source: {
      updating: true,
      abort() {
        this.updating = false;
      },
    },
  };
  source.buffers = [videoBuffer, audioBuffer];
  source.pump(videoBuffer);
  assert.equal(removing, true);
  source.seek();

  // The removal can still be pending when a rapid seek returns to this range.
  source.video.currentTime = 10;
  source.video.buffered = videoBuffer.source.buffered;
  source.seek();
  assert.equal(removing, true);
  assert.equal(audioBuffer.source.updating, false);
  assert.equal(request.signal.aborted, true);
  assert.deepEqual(seeks, [
    [90, true],
    [10, true],
  ]);
  assert.equal(source.nextSeek, 8192);
  assert.equal(source.eof, false);
  assert.equal(source.queued, 4);
  assert.equal(videoBuffer.queue.length, 0);

  const next = { bytes: new Uint8Array(6), sample: 2 };
  videoBuffer.queue.push(next);
  source.pump(videoBuffer);
  assert.equal(appended.length, 0);
  removing = false;
  source.pump(videoBuffer);
  assert.deepEqual(appended, [next.bytes]);
});
test("MSE reads bounded byte ranges and carries forward a strong If-Range validator", async () => {
  const calls = [];
  const source = reader(async (path, signal, headers) => {
    calls.push({ path, headers });
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4", ETag: '"v1"' },
    });
  });
  const data = await source.read(0);
  assert.equal(data.fileStart, 0);
  assert.deepEqual([...new Uint8Array(data)], [1, 2, 3, 4]);
  assert.equal(source.size, 4);
  await source.read(0);
  assert.deepEqual(calls[0].headers, { Range: "bytes=0-1048575" });
  assert.equal(calls[1].headers["If-Range"], '"v1"');
  assert.equal(calls[0].path, item.path);
});
test("ignored Range, malformed Content-Range and changed files cannot trigger a whole-file read", async () => {
  for (const [status, headers] of [
    [200, {}],
    [206, { "Content-Range": "bytes 5-8/100" }],
    [206, { "Content-Range": "bytes 0-1048576/2000000" }],
    [206, { "Content-Range": "bytes 0-3/3" }],
  ]) {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const source = reader(async () => new Response(body, { status, headers }));
    await assert.rejects(source.read(0));
    assert.equal(cancelled, true);
  }
  const source = reader(
    async () => new Response("whole file", { status: 200 }),
  );
  source.etag = '"old"';
  await assert.rejects(source.read(0), /已更新/);
});
test("MSE range reads report authentication failures and reject truncated data", async () => {
  let requests = 0;
  await assert.rejects(
    reader(async () => {
      requests++;
      return new Response(null, { status: 401 });
    }).read(0),
    /登录/,
  );
  assert.equal(requests, 1);
  requests = 0;
  await assert.rejects(
    reader(async () => {
      requests++;
      return new Response(new Uint8Array(2), {
        status: 206,
        headers: { "Content-Range": "bytes 0-3/4" },
      });
    }).read(0),
    /不完整/,
  );
  assert.equal(requests, 2);
  const source = reader(
    (path, signal) =>
      new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      ),
  );
  const loading = source.read(0);
  source.controller.abort();
  await assert.rejects(loading, { name: "AbortError" });
  assert.equal(source.request, null);
});

test("an interrupted WebTransport range waits for the foreground and retries the same bytes", async (t) => {
  const page = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  globalThis.document = page;
  t.after(() => delete globalThis.document);
  const reply = (body) =>
    readResponse(
      new WireReader(
        new Blob([
          "HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\n" +
            'Content-Range: bytes 4-7/8\r\nETag: "v1"\r\n' +
            "Cache-Control: max-age=30\r\n\r\n" +
            body,
        ])
          .stream()
          .getReader(),
      ),
    );
  const requests = [];
  const writes = [];
  const source = reader(async (_path, _signal, headers) => {
    requests.push(headers);
    return reply(requests.length === 1 ? "ab" : "WXYZ");
  });
  source.etag = '"v1"';
  source.client.images = { publicFiles: true };
  source.ranges = {
    get: () => null,
    async put(_path, _version, _range, value) {
      writes.push(value.bytes);
    },
  };

  const pending = source.read(4);
  await setImmediate();
  assert.equal(requests.length, 1);
  assert.equal(writes.length, 0);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  const data = await pending;
  const range = { Range: "bytes=4-1048579", "If-Range": '"v1"' };
  assert.deepEqual(requests, [range, range]);
  assert.equal(data.fileStart, 4);
  assert.equal(new TextDecoder().decode(data), "WXYZ");
  assert.deepEqual(writes, [new Uint8Array(data)]);

  page.visibilityState = "hidden";
  let cancelledRequests = 0;
  const cancelled = reader(() => {
    cancelledRequests++;
    return reply("ab");
  });
  const waiting = cancelled.read(4);
  await setImmediate();
  cancelled.request.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  assert.equal(cancelledRequests, 1);
  assert.equal(cancelled.request, null);
});

test("WebTransport reuses fresh video ranges and revalidates no-cache bytes with the NAS", async () => {
  const calls = [];
  const writes = [];
  let deletes = 0;
  let cacheControl = "private, max-age=30";
  let validation = {};
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const source = reader(async (_path, _signal, headers) => {
    calls.push(headers);
    return new Response(null, { status: 304, headers: validation });
  });
  source.client.images = { publicFiles: true };
  source.ranges = {
    get: () => ({
      time: Date.now() - 1000,
      bytes,
      etag: '"v1"',
      headers: new Headers({
        "Content-Range": "bytes 0-3/4",
        "Cache-Control": cacheControl,
        ETag: '"v1"',
      }),
    }),
    async put(_path, _version, _range, value) {
      writes.push(value);
    },
    async delete() {
      deletes++;
    },
  };
  assert.deepEqual(new Uint8Array(await source.read(0)), bytes);
  assert.equal(calls.length, 0);
  assert.equal(writes.length, 0);

  cacheControl = "private, no-cache";
  assert.deepEqual(new Uint8Array(await source.read(0)), bytes);
  assert.deepEqual(calls[0], {
    Range: "bytes=0-1048575",
    "If-Range": '"v1"',
    "If-None-Match": '"v1"',
  });
  assert.equal(writes.length, 1);

  validation = { "Cache-Control": "no-store" };
  assert.deepEqual(new Uint8Array(await source.read(0)), bytes);
  assert.equal(deletes, 1);
  assert.equal(writes.length, 1);
});

test("freshness honors the origin response date and Age for stored video ranges", () => {
  const time = Date.parse("2026-11-12T12:00:00Z");
  const headers = new Headers({
    "Cache-Control": "private, max-age=30",
    Date: "Thu, 12 Nov 2026 11:59:50 GMT",
    Age: "15",
  });
  assert.equal(isFreshVideoRange({ headers, time }, time + 14999), true);
  assert.equal(isFreshVideoRange({ headers, time }, time + 15000), false);
  headers.set("Cache-Control", "private, no-cache, max-age=30");
  assert.equal(isFreshVideoRange({ headers, time }, time), false);
});

test("MSE rejects a mismatched 206 ETag before combining file versions", async () => {
  const source = reader(
    async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-3/4", ETag: '"v2"' },
      }),
  );
  source.etag = '"v1"';
  await assert.rejects(source.read(0), /已更新/);
});
