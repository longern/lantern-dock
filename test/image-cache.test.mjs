import test from "node:test";
import assert from "node:assert/strict";
import {
  PersistentImageCache,
  clearPersistentImages,
  originalImageAccept,
} from "../src/lib/image-cache.js";
import { ImageClient, imageIdentifier } from "../src/lib/images.js";

const origin = "https://portal.example";
const backend = {
  transport: "webtransport",
  endpoint: "https://bridge.example/webtransport",
  rootPath: "/dav/",
  auth: "none",
};
const path = "/api/iiif/3/cGhvdG8uanBn/full/384,256/0/default.jpg";
const jpeg = "image/jpeg";
function storageFixture(options = {}) {
  const buckets = new Map();
  const cacheFor = (name) => {
    if (!buckets.has(name)) {
      const records = new Map();
      buckets.set(name, {
        records,
        async match(key) {
          return records.get(typeof key === "string" ? key : key.url)?.clone();
        },
        async put(key, response) {
          records.set(
            typeof key === "string" ? key : key.url,
            response.clone(),
          );
        },
        async delete(key) {
          return records.delete(typeof key === "string" ? key : key.url);
        },
        async keys() {
          return [...records.keys()].map((key) => new Request(key));
        },
      });
    }
    return buckets.get(name);
  };
  const cache = cacheFor("lantern-dock-public-images-v1");
  const storage = {
    async open(name) {
      return cacheFor(name);
    },
  };
  let queue = Promise.resolve();
  const locks = {
    request(_name, work) {
      const result = queue.then(work);
      queue = result.catch(() => {});
      return result;
    },
  };
  const settings = { storage, locks, origin, secure: true, ...options };
  const transport = { config: { ...backend }, credentials: { mode: "none" } };
  return {
    records: cache.records,
    cache,
    transport,
    settings,
    make: (other = transport) => new PersistentImageCache(other, settings),
    makeOriginal: (other = transport) =>
      new PersistentImageCache(other, { ...settings, original: true }),
  };
}
const payload = (size = 4, headers = {}) => ({
  bytes: new Uint8Array(size).fill(1),
  headers: new Headers({
    "Content-Type": jpeg,
    ETag: '"v1"',
    "Cache-Control": "private, no-cache",
    ...headers,
  }),
});

test("public renditions survive a new client and scopes isolate backend, root, source version and size", async () => {
  const f = storageFixture();
  await f.make().put(path, "v1", jpeg, payload());
  const next = f.make();
  assert.equal((await next.get(path, "v1", jpeg, 100)).bytes.length, 4);
  assert.equal(await next.get(path, "v2", jpeg, 100), null);
  assert.equal(
    await next.get(path.replace("384,256", "128,85"), "v1", jpeg, 100),
    null,
  );
  for (const changed of [
    { endpoint: "https://other.example/webtransport" },
    { rootPath: "/dav/other/" },
  ]) {
    const client = f.make({
      ...f.transport,
      config: { ...backend, ...changed },
    });
    assert.equal(await client.get(path, "v1", jpeg, 100), null);
  }
  const keys = [...f.records.keys()].join(" ");
  assert.ok(!keys.includes(backend.endpoint));
  assert.ok(!keys.includes("photo.jpg"));
});

test("private credentials, no-store, unsupported Vary, unvalidated bodies and non-IIIF paths do not persist", async () => {
  for (const config of [
    { auth: "basic" },
    { auth: "bearer" },
    { endpoint: "https://user:password@example.com" },
  ]) {
    const f = storageFixture();
    await f
      .make({ ...f.transport, config: { ...backend, ...config } })
      .put(path, "v1", jpeg, payload());
    assert.equal(f.records.size, 0);
  }
  const gateway = storageFixture();
  gateway.transport.credentials.gatewayToken = "private-gateway-credential";
  await gateway.make().put(path, "v1", jpeg, payload());
  assert.equal(gateway.records.size, 0);
  const f = storageFixture();
  const client = f.make();
  await client.put(path, "v1", jpeg, payload());
  f.transport.credentials = { mode: "bearer", bearer: "must-not-persist" };
  assert.equal(await client.get(path, "v1", jpeg, 100), null);
  f.transport.credentials = { mode: "none" };
  await client.put(
    path,
    "v1",
    jpeg,
    payload(4, { "Cache-Control": "no-store" }),
  );
  assert.equal(await client.get(path, "v1", jpeg, 100), null);
  for (const headers of [
    { Vary: "Cookie" },
    { Vary: "*" },
    { ETag: "" },
    { "Content-Type": "text/html" },
  ])
    await client.put(path, "v1", jpeg, payload(4, headers));
  for (const target of [
    "/api/admin/inbox",
    "/dav/original.jpg",
    "/api/media/Lg/index.json",
  ])
    await client.put(target, "v1", jpeg, payload());
  assert.equal(
    (await f.cache.keys()).filter((key) => !key.url.endsWith("/index")).length,
    0,
  );
});

test("byte and entry bounds evict the least recently validated image across clients", async (t) => {
  let time = 1000;
  t.mock.method(Date, "now", () => time++);
  const f = storageFixture({ maxBytes: 8, maxEntries: 2 });
  const a = f.make(),
    b = f.make();
  await a.put(path, "a", jpeg, payload());
  await b.put(path, "b", jpeg, payload());
  await a.put(path, "a", jpeg, payload());
  await b.put(path, "c", jpeg, payload());
  assert.ok(await a.get(path, "a", jpeg, 100));
  assert.equal(await a.get(path, "b", jpeg, 100), null);
  assert.ok(await a.get(path, "c", jpeg, 100));
  await a.put(path, "large", jpeg, payload(9));
  assert.equal(await a.get(path, "large", jpeg, 100), null);
});

test("concurrent writes respect a shared budget and a logout blocks old clients from repopulating it", async () => {
  const f = storageFixture({ maxBytes: 12, maxEntries: 3 });
  const old = f.make();
  await Promise.all(
    Array.from({ length: 12 }, (_, n) =>
      f.make().put(path, String(n), jpeg, payload()),
    ),
  );
  assert.equal(
    (await f.cache.keys()).filter((key) => !key.url.endsWith("/index")).length,
    3,
  );
  await clearPersistentImages(f.settings);
  await old.put(path, "late-response", jpeg, payload());
  assert.equal(await f.make().get(path, "late-response", jpeg, 100), null);
  assert.equal(
    (await f.cache.keys()).filter((key) => !key.url.endsWith("/index")).length,
    0,
  );
  await f.make().put(path, "new-client", jpeg, payload());
  assert.ok(await f.make().get(path, "new-client", jpeg, 100));
});

test("corrupt indexes and orphaned writes recover; quota and blocked storage fail harmlessly", async () => {
  const f = storageFixture();
  await f.make().put(path, "v1", jpeg, payload());
  await f.cache.put(
    origin + "/.lantern-dock-cache/images/v1/index",
    new Response("broken"),
  );
  assert.equal(await f.make().get(path, "v1", jpeg, 100), null);
  assert.equal((await f.cache.keys()).length, 1);
  const bad = storageFixture({
    storage: {
      async open() {
        throw new DOMException("Full", "QuotaExceededError");
      },
    },
  });
  await bad.make().put(path, "v1", jpeg, payload());
  assert.equal(await bad.make().get(path, "v1", jpeg, 100), null);
});

test("restored image responses are revalidated before use, including max-age; missing or revoked images never display stale pixels", async () => {
  const f = storageFixture();
  const item = {
    path: "/dav/photo.jpg",
    etag: '"source"',
    modified: "",
    size: 4,
  };
  const base = "/api/iiif/3/" + imageIdentifier("photo.jpg");
  const log = [];
  let status = 200,
    policy = "private, max-age=600";
  f.transport.request = async (target, options = {}) => {
    if (target === "/api/capabilities")
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
    const info = target.endsWith("/info.json");
    const headers = {
      "Cache-Control": policy,
      ETag: info ? '"info"' : '"jpg"',
      "Content-Type": info ? "application/ld+json" : jpeg,
    };
    const responseStatus =
      status !== 200 ? status : options.headers["If-None-Match"] ? 304 : 200;
    log.push({
      target,
      status: responseStatus,
      validator: options.headers["If-None-Match"],
    });
    return new Response(
      responseStatus === 200
        ? info
          ? JSON.stringify({
              id: "https://logical.example" + base,
              type: "ImageService3",
              protocol: "http://iiif.io/api/image",
              profile: "level0",
              width: 384,
              height: 256,
              sizes: [{ width: 384, height: 256 }],
            })
          : payload().bytes
        : null,
      { status: responseStatus, headers },
    );
  };
  const make = () =>
    new ImageClient(f.transport, { persistentCache: f.make() });
  const first = make();
  await first.image(item, 384);
  first.dispose();
  const next = make();
  assert.equal((await next.image(item, 384)).blob.size, 4);
  assert.deepEqual(
    log.map((entry) => entry.status),
    [200, 200, 304, 304],
  );
  assert.equal(log[2].validator, '"info"');
  assert.equal(log[3].validator, '"jpg"');
  next.dispose();
  policy = "no-store";
  const revoked = make();
  await revoked.image(item, 384);
  assert.equal(
    (await f.cache.keys()).filter((key) => !key.url.endsWith("/index")).length,
    0,
  );
  revoked.dispose();
  policy = "no-cache";
  await make().image(item, 384);
  status = 404;
  await assert.rejects(
    make().image(item, 384),
    (error) => error.status === 404,
  );
  status = 200;
  const blocked = storageFixture({
    storage: {
      async open() {
        throw new DOMException("Blocked", "SecurityError");
      },
    },
  });
  const fallback = new ImageClient(f.transport, {
    persistentCache: blocked.make(f.transport),
  });
  assert.equal((await fallback.image(item, 384)).blob.size, 4);
  fallback.dispose();
});

test("a blocked Cache Storage property does not prevent client construction or logout cleanup", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    get() {
      throw new DOMException("Blocked", "SecurityError");
    },
  });
  try {
    const f = storageFixture();
    const client = new PersistentImageCache(f.transport, {
      secure: true,
      origin,
      locks: f.settings.locks,
    });
    assert.equal(await client.get(path, "v1", jpeg, 100), null);
    await clearPersistentImages();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "caches", descriptor);
    else delete globalThis.caches;
  }
});

test("zoom originals have a separate disk budget and the same logout fence", async () => {
  const fullSize = storageFixture();
  const large = 9 * 1024 * 1024;
  await fullSize
    .makeOriginal()
    .put("/dav/large.jpg", "v1", originalImageAccept, payload(large));
  const restored = await fullSize
    .makeOriginal()
    .get("/dav/large.jpg", "v1", originalImageAccept, large);
  assert.equal(restored.bytes.length, large);

  const f = storageFixture({ maxBytes: 8, maxEntries: 2 });
  const preview = f.make();
  const original = f.makeOriginal();
  await preview.put(path, "v1", jpeg, payload(8));
  for (const photo of ["one.jpg", "two.jpg", "three.jpg"])
    await original.put("/dav/" + photo, "v1", originalImageAccept, payload(4));
  assert.equal((await preview.get(path, "v1", jpeg, 8)).bytes.length, 8);
  assert.equal(
    await original.get("/dav/one.jpg", "v1", originalImageAccept, 8),
    null,
  );
  assert.ok(
    await f.makeOriginal().get("/dav/three.jpg", "v1", originalImageAccept, 8),
  );
  for (const target of [
    "/api/admin/inbox/file",
    "/dav/../secret.jpg",
    "/dav/%2e%2e/secret.jpg",
    "/dav/elsewhere%2ffile.jpg",
    path,
  ]) {
    await original.put(target, "v1", originalImageAccept, payload());
    assert.equal(
      await original.get(target, "v1", originalImageAccept, 8),
      null,
    );
  }
  await clearPersistentImages(f.settings);
  await original.put("/dav/late.jpg", "v1", originalImageAccept, payload());
  assert.equal(
    await f.makeOriginal().get("/dav/late.jpg", "v1", originalImageAccept, 8),
    null,
  );
  assert.equal(
    await f.makeOriginal().get("/dav/three.jpg", "v1", originalImageAccept, 8),
    null,
  );
});

test("public zoom originals revalidate after reload, respect freshness and evict on no-store or denial", async (t) => {
  const f = storageFixture();
  f.transport.config.gatewayAuth = true; // An older Worker may still send this hint.
  const item = { path: "/dav/photo.jpg", etag: '"source"', size: 4 };
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  let control = "private, no-cache",
    denial;
  const log = [];
  f.transport.request = async (target, options) => {
    if (target === "/api/capabilities")
      return Response.json({
        version: 1,
        services: {
          files: {
            enabled: true,
            readOnly: true,
            protocol: "webdav",
            version: 1,
            href: "/dav/",
          },
        },
      });
    const validator = options.headers["If-None-Match"];
    const status = denial || (validator ? 304 : 200);
    log.push({ status, validator });
    return new Response(status === 200 ? payload().bytes : null, {
      status,
      headers: payload(4, { "Cache-Control": control, Age: "1" }).headers,
    });
  };
  const make = () =>
    new ImageClient(f.transport, {
      root: "/dav/",
      originalCache: f.makeOriginal(),
    });
  const get = (client) => client.original(item);
  const first = make();
  assert.equal((await get(first)).size, 4);
  assert.equal((await get(first)).size, 4);
  first.dispose();
  const reloaded = make();
  control = "max-age=2";
  assert.equal((await get(reloaded)).size, 4);
  await get(reloaded);
  assert.deepEqual(
    log.map(({ status }) => status),
    [200, 304, 304],
  );
  assert.equal(log.at(-1).validator, '"v1"');
  now += 1000;
  control = "no-store";
  await get(reloaded);
  reloaded.dispose();
  assert.equal(log.at(-1).status, 304);
  assert.equal(
    await f.makeOriginal().get(item.path, item.etag, originalImageAccept, 10),
    null,
  );
  control = "private, no-cache";
  await get(make());
  assert.equal(log.at(-1).status, 200);
  denial = 407;
  await assert.rejects(get(make()), (error) => error.status === 407);
  assert.equal(
    await f.makeOriginal().get(item.path, item.etag, originalImageAccept, 10),
    null,
  );
});
