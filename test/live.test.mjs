import test from "node:test";
import assert from "node:assert/strict";
import { ImageClient, imageIdentifier } from "../src/lib/images.js";
import {
  liveDescriptor,
  fetchLiveMedia,
  albumLiveItems,
  createLiveVideoSource,
} from "../src/lib/live.js";
import { DAVClient } from "../src/lib/dav.js";
const version = "a".repeat(64);
const image = { path: "/dav/photo.jpg", kind: "image", size: 100, etag: "v1" };
const movie = { path: "/dav/movie.mov", kind: "video" };
const live = {
  image: image.path,
  pairedVideo: movie.path,
  video: `/api/media/${imageIdentifier("photo.jpg")}/${imageIdentifier("movie.mov")}/${version}/video.mp4`,
  length: 1000,
  posterTime: 0,
  kind: "apple",
};
function client({
  policy = "private, max-age=15",
  pages = [[live]],
  capabilities = true,
} = {}) {
  const requests = [];
  const transport = {
    config: { transport: "http", endpoint: "https://nas.example" },
    credentials: {},
    async request(path) {
      requests.push(path);
      if (path === "/api/capabilities")
        return Response.json({
          version: 1,
          services: capabilities
            ? {
                media: {
                  enabled: true,
                  protocol: "lantern-dock-media",
                  version: 1,
                  href: "/api/media",
                },
              }
            : {},
        });
      const offset = Number(
        new URL(path, "https://nas.example").searchParams.get("offset") || 0,
      );
      const page = offset / 64;
      return Response.json(
        {
          version: 1,
          revision: version,
          items: pages[page],
          nextOffset: page === pages.length - 1 ? null : offset + 64,
        },
        { headers: { "Cache-Control": policy } },
      );
    },
  };
  return {
    root: "/dav/",
    transport,
    images: new ImageClient(transport),
    requests,
  };
}
test("live descriptors bind each resource to its public image and companion", () => {
  assert.deepEqual(liveDescriptor(live, "/dav/"), live);
  for (const change of [
    { video: "https://evil.example/a.mp4" },
    { video: live.video + "?secret=x" },
    { image: "/dav/../private.jpg" },
    { image: "/dav/other.jpg" },
    { pairedVideo: "/dav/sub/movie.mov" },
    { length: -1 },
    { posterTime: NaN },
  ])
    assert.equal(liveDescriptor({ ...live, ...change }, "/dav/"), null);
  assert.equal(liveDescriptor(live, "/dav/sub/"), null);
  assert.equal(
    liveDescriptor({ ...live, kind: "motion-photo" }, "/dav/"),
    null,
  );
});
test("final paged index removes a provisional pair and respects cache invalidation", async () => {
  const c = client({ pages: [[live], []] });
  const signal = new AbortController().signal;
  assert.equal((await fetchLiveMedia(c, [image], signal)).size, 0);
  assert.equal(c.requests.length, 3);
  assert.equal((await fetchLiveMedia(c, [image], signal)).size, 0);
  assert.equal(c.requests.length, 3);
  c.images.expire();
  await fetchLiveMedia(c, [image], signal);
  assert.equal(c.requests.length, 5);
  c.images.dispose();
});
test("optional metadata discovery does not guess third-party DAV routes", async () => {
  const c = client({ capabilities: false });
  assert.equal(
    (await fetchLiveMedia(c, [image], new AbortController().signal)).size,
    0,
  );
  assert.deepEqual(c.requests, ["/api/capabilities"]);
  c.images.dispose();
});

test("busy live indexes retry and retain the last confirmed metadata", async () => {
  const c = client();
  const signal = new AbortController().signal;
  const fetch = c.transport.request;
  let busy = 0;
  c.transport.request = (path) => {
    if (path.endsWith("/index.json") && busy > 0) {
      busy--;
      return new Response(null, {
        status: 503,
        headers: { "Retry-After": "0" },
      });
    }
    return fetch(path);
  };
  busy = 1;
  assert.deepEqual(
    (await fetchLiveMedia(c, [image], signal)).get(image.path),
    live,
  );
  assert.equal(busy, 0);
  c.images.expire();
  busy = 4;
  assert.deepEqual(
    (await fetchLiveMedia(c, [image], signal)).get(image.path),
    live,
  );
  assert.equal(busy, 1);
  busy = 4;
  const changed = { ...image, etag: "v2" };
  assert.equal((await fetchLiveMedia(c, [changed], signal)).size, 0);
  c.images.dispose();
});

test("no-store metadata is never retained and paired videos hide only beside their image", async () => {
  const c = client({ policy: "no-store" }),
    signal = new AbortController().signal;
  const map = await fetchLiveMedia(c, [image], signal);
  await fetchLiveMedia(c, [image], signal);
  assert.equal(c.requests.length, 3);
  assert.equal(c.images.liveIndexes.entries.size, 0);
  assert.equal(albumLiveItems([image, movie], map).length, 1);
  assert.deepEqual(albumLiveItems([movie], map), [movie]);
  c.images.dispose();
});
test("live video adapter uses direct HTTPS while DAV still rejects the media namespace", async () => {
  const c = client();
  const source = await createLiveVideoSource(
    c,
    live,
    new AbortController().signal,
  );
  const video = {};
  source.attach(video);
  assert.equal(video.src, "https://nas.example" + live.video);
  assert.equal(source.mode, "direct");
  source.dispose();
  const dav = new DAVClient(c.transport, { rootPath: "/dav/" });
  await assert.rejects(dav.read(live.video), { code: "OUTSIDE_ROOT" });
  dav.dispose();
  c.images.dispose();
});
