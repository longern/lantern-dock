import test from "node:test";
import assert from "node:assert/strict";
import { MemoryCache, cachePolicy } from "../src/lib/cache.js";
import { ImageClient, imageIdentifier, iiifSize } from "../src/lib/images.js";

const item = {
  path: "/dav/照片/hello%20world.png",
  etag: '"v1"',
  modified: "",
  size: 100,
};
const base = "/api/iiif/3/" + imageIdentifier("照片/hello world.png");
const info = {
  id: "https://logical-nas.example" + base,
  type: "ImageService3",
  protocol: "http://iiif.io/api/image",
  profile: "level0",
  width: 2400,
  height: 1600,
  sizes: [
    { width: 128, height: 85 },
    { width: 384, height: 256 },
    { width: 1600, height: 1067 },
  ],
};
function transport({ policy = "private, no-cache", override } = {}) {
  const requests = [];
  return {
    requests,
    async request(path, options = {}) {
      requests.push({ path, options });
      const custom = await override?.(path, options);
      if (custom) return custom;
      if (path === "/api/capabilities")
        return Response.json({
          version: 1,
          services: {
            images: {
              enabled: true,
              protocol: "http://iiif.io/api/image",
              version: 3,
              href: "/api/iiif/3",
            },
          },
        });
      const metadata = path.endsWith("/info.json");
      const headers = {
        "Cache-Control": policy,
        ETag: metadata ? '"info"' : '"jpg"',
        "Content-Type": metadata ? "application/ld+json" : "image/jpeg",
      };
      if (options.headers["If-None-Match"])
        return new Response(null, { status: 304, headers });
      return new Response(
        metadata ? JSON.stringify(info) : new Uint8Array([255, 216, 255, 217]),
        { headers },
      );
    },
  };
}

test("bounded memory LRU evicts by bytes and count without persisting", () => {
  const cache = new MemoryCache(8, 2);
  cache.set("a", 1, 4);
  cache.set("b", 2, 4);
  cache.get("a");
  cache.set("c", 3, 4);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.bytes, 8);
  cache.expire();
  assert.equal(cache.get("a").time, 0);
  cache.set("huge", 0, 9);
  assert.equal(cache.get("huge"), undefined);
  cache.set("bad", 0, NaN);
  assert.equal(cache.get("bad"), undefined);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.entries.size, 0);
});
test("HTTP freshness is conservative and honors no-store, no-cache, max-age and Age", () => {
  assert.deepEqual(cachePolicy(new Headers()), { storable: true, freshFor: 0 });
  assert.equal(
    cachePolicy(new Headers({ "Cache-Control": 'private, max-age="120"' }))
      .freshFor,
    15000,
  );
  assert.equal(
    cachePolicy(new Headers({ "Cache-Control": "max-age=10", Age: "8" }))
      .freshFor,
    2000,
  );
  assert.equal(
    cachePolicy(new Headers({ "Cache-Control": "no-cache, max-age=60" }))
      .freshFor,
    0,
  );
  assert.equal(
    cachePolicy(new Headers({ "Cache-Control": "no-store" })).storable,
    false,
  );
});
test("IIIF identifiers preserve UTF-8 paths and advertised sizes bound the request", () => {
  assert.equal(
    Buffer.from(
      imageIdentifier("照片/hello world.png"),
      "base64url",
    ).toString(),
    "照片/hello world.png",
  );
  assert.deepEqual(iiifSize(info, 128), { width: 128, height: 85 });
  assert.deepEqual(iiifSize(info, 300), { width: 384, height: 256 });
  assert.deepEqual(iiifSize(info, 4000), { width: 1600, height: 1067 });
  for (const bad of [
    { ...info, width: -1 },
    { ...info, width: 1e9 },
    { ...info, sizes: [] },
    { ...info, sizes: [{ width: 3000, height: 2000 }] },
    { ...info, profile: "bespoke" },
  ])
    assert.throws(() => iiifSize(bad, 128));
});
test("IIIF images use the existing transport, validate with ETags and reuse 304 bodies", async () => {
  const wire = transport();
  const client = new ImageClient(wire);
  try {
    const first = await client.image(item, 128);
    assert.equal(first.width, 2400);
    assert.equal(first.blob.type, "image/jpeg");
    assert.equal(wire.requests.length, 3);
    assert.equal(wire.requests[2].path, base + "/full/128,85/0/default.jpg");
    const again = await client.image(item, 128);
    assert.equal(again.blob.size, 4);
    assert.equal(wire.requests.length, 5);
    assert.equal(wire.requests[3].options.headers["If-None-Match"], '"info"');
    assert.equal(wire.requests[4].options.headers["If-None-Match"], '"jpg"');
    assert.equal(client.peek(item, 128).blob.size, 4);
    client.expire();
    assert.equal(client.peek(item, 128), null);
    assert(wire.requests.every((r) => r.path.startsWith("/api/")));
  } finally {
    client.dispose();
  }
  assert.equal(client.responses.bytes, 0);
  assert.equal(client.previews.bytes, 0);
});
test("fresh explicit max-age avoids requests until refresh or file version changes", async () => {
  const wire = transport({ policy: "private, max-age=15" });
  const client = new ImageClient(wire);
  try {
    await client.image(item, 384);
    await client.image(item, 384);
    assert.equal(wire.requests.length, 3);
    client.expire();
    await client.image(item, 384);
    assert.equal(wire.requests.length, 5);
    await client.image({ ...item, etag: '"v2"' }, 384);
    assert.equal(wire.requests.length, 7);
    assert.equal(wire.requests[5].options.headers["If-None-Match"], undefined);
  } finally {
    client.dispose();
  }
});
test("no-store forbids byte and decoded preview retention", async () => {
  const wire = transport({ policy: "private, no-store" });
  const client = new ImageClient(wire);
  try {
    await client.image(item, 128);
    await client.image(item, 128);
    assert.equal(wire.requests.length, 5);
    assert.equal(client.responses.bytes, 0);
    assert.equal(client.previews.bytes, 0);
    assert.equal(client.peek(item, 128), null);
    assert.equal(wire.requests[3].options.headers["If-None-Match"], undefined);
  } finally {
    client.dispose();
  }
});
test("a 304 can revoke storage and a missing file cannot retain a preview", async () => {
  let state = "normal";
  const wire = transport({
    override: (path, opts) => {
      if (state === "gone" && path.endsWith("info.json"))
        return new Response(null, { status: 404 });
      if (state === "no-store" && opts.headers?.["If-None-Match"])
        return new Response(null, {
          status: 304,
          headers: { "Cache-Control": "no-store" },
        });
    },
  });
  const client = new ImageClient(wire);
  try {
    await client.image(item, 128);
    state = "no-store";
    await client.image(item, 128);
    assert.equal(client.responses.bytes, 0);
    assert.equal(client.peek(item, 128), null);
    state = "normal";
    await client.image(item, 128);
    state = "gone";
    await assert.rejects(client.image(item, 128), (e) => e.status === 404);
    assert.equal(client.peek(item, 128), null);
  } finally {
    client.dispose();
  }
});
test("generic WebDAV and unsupported image formats use the existing fallback", async () => {
  for (const missing of [true, false]) {
    const wire = transport({
      override: (path) => {
        if (missing && path === "/api/capabilities")
          return new Response(null, { status: 404 });
        if (!missing && path.endsWith("info.json"))
          return new Response(null, { status: 415 });
      },
    });
    const client = new ImageClient(wire);
    try {
      assert.equal(await client.image(item, 128), null);
      assert.equal(await client.image(item, 128), null);
      assert.equal(wire.requests.length, missing ? 1 : 2);
    } finally {
      client.dispose();
    }
  }
});
test("untrusted IIIF identifiers cannot redirect image traffic", async () => {
  const wire = transport({
    override: (path) =>
      path.endsWith("info.json")
        ? Response.json({ ...info, id: "https://evil.example/not-the-source" })
        : null,
  });
  const client = new ImageClient(wire);
  try {
    assert.equal(await client.image(item, 128), null);
    assert.equal(wire.requests.length, 2);
  } finally {
    client.dispose();
  }
});
test("image work is bounded to three concurrent requests and disposal cancels queued work", async () => {
  const client = new ImageClient({});
  let running = 0,
    peak = 0;
  const work = (signal) =>
    new Promise((resolve, reject) => {
      running++;
      peak = Math.max(peak, running);
      signal.addEventListener(
        "abort",
        () => {
          running--;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const promises = Array.from({ length: 8 }, () => client.run(work));
  assert.equal(running, 3);
  client.dispose();
  const result = await Promise.allSettled(promises);
  assert.equal(peak, 3);
  assert.equal(running, 0);
  assert(result.every((r) => r.status === "rejected"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.image(item, 128, controller.signal), {
    name: "AbortError",
  });
});
