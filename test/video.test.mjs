import test from "node:test";
import assert from "node:assert/strict";
import { createVideoSource } from "../src/lib/video.js";
import { MP4MediaSource } from "../src/lib/video-mp4.js";
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
  await assert.rejects(
    reader(async () => new Response(null, { status: 401 })).read(0),
    /登录/,
  );
  await assert.rejects(
    reader(
      async () =>
        new Response(new Uint8Array(2), {
          status: 206,
          headers: { "Content-Range": "bytes 0-3/4" },
        }),
    ).read(0),
    /不完整/,
  );
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
