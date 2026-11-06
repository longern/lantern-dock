import { test, expect } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startFixture, textFile } from "./fixture.mjs";
import { backendPaths } from "../../shared/backend-paths.js";

let fixture;
test.beforeAll(async () => {
  test.setTimeout(180000);
  fixture = await startFixture({ nas: true });
});
test.afterAll(async () => {
  await fixture?.stop();
});

test("default NAS routes and capabilities work through the shared bridge namespaces", async ({
  page,
}) => {
  expect(fixture.env.BACKEND_ROOT).toBeUndefined();
  await page.goto(fixture.origin);
  await expect(page.locator(".file-card")).toHaveCount(3);
  const result = await page.evaluate(async () => {
    const { DirectTransport } = await import("/__test/lib/transport.js");
    const { backendPaths } = await import("/shared/backend-paths.js");
    const { backend } = await (await fetch("/api/config")).json();
    const transport = new DirectTransport(backend);
    try {
      const response = await transport.request(backendPaths.capabilities);
      const document = await response.json();
      const cached = await transport.request(backendPaths.capabilities, {
        headers: { "If-None-Match": response.headers.get("ETag") },
      });
      await cached.body?.cancel();
      return {
        root: backend.rootPath,
        status: response.status,
        cache: response.headers.get("Cache-Control"),
        cachedStatus: cached.status,
        document,
      };
    } finally {
      transport.close();
    }
  });
  expect(result.root).toBe(backendPaths.files);
  expect(result.status).toBe(200);
  expect(result.cache).toBe("public, max-age=300");
  expect(result.cachedStatus).toBe(304);
  expect(result.document.version).toBe(1);
  expect(result.document.services.files).toMatchObject({
    href: backendPaths.files,
    protocol: "webdav",
    readOnly: true,
  });
  expect(result.document.services.inbox.href).toBe(backendPaths.inbox);
  expect(result.document.services.images).toMatchObject({
    href: backendPaths.images,
    version: 3,
    protocol: "http://iiif.io/api/image",
    enabled: true,
  });
  expect(result.document.services.account).toMatchObject({
    href: backendPaths.account,
    version: 2,
    enabled: false,
  });
});

test("NAS serves public read-only WebDAV and receives a private file through the real bridge", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.origin);
  await expect(page.locator(".file-card")).toHaveCount(3);
  await page
    .getByRole("button", { name: "预览 hello.txt", exact: true })
    .click();
  await expect(page.locator(".preview-content pre")).toHaveText(textFile);
  const created = await fixture.nas.createLink();
  await page.goto(created.url);
  await expect(
    page.getByRole("heading", { name: "临时收照片", exact: true }),
  ).toBeVisible();
  const contents = "你好，临时收件箱！\n";
  await page.getByLabel("选择上传文件").setInputFiles({
    name: "来访资料.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(contents),
  });
  await expect(page.getByRole("status")).toHaveText("已接收");
  const files = await readdir(
    resolve(fixture.nas.dataDir, "inbox", created.link.id),
  );
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/-来访资料\.txt$/);
  expect(
    await readFile(
      resolve(fixture.nas.dataDir, "inbox", created.link.id, files[0]),
      "utf8",
    ),
  ).toBe(contents);
  expect(await readdir(resolve(fixture.nas.dataDir, "inbox/.staging"))).toEqual(
    [],
  );
  await page.screenshot({
    path: testInfo.outputPath("received.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "返回公开文件", exact: true }).click();
  await expect(page.locator(".file-card")).toHaveCount(3);
  await expect(page.getByText("来访资料.txt")).toHaveCount(0);
  const status = await page.evaluate(async () => {
    const { DirectTransport } = await import("/__test/lib/transport.js");
    const config = await (await fetch("/api/config")).json();
    const transport = new DirectTransport(config.backend);
    try {
      const response = await transport.request("/dav/hello.txt", {
        method: "PUT",
        body: "overwrite",
      });
      await response.body?.cancel();
      return response.status;
    } finally {
      transport.close();
    }
  });
  expect(status).toBe(405);
  expect(errors).toEqual([]);
});

test("recycle bins and symlink aliases stay hidden and inaccessible through WebTransport", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await expect(page.locator(".file-card")).toHaveCount(3);
  await expect(
    page.locator(".file-card").filter({ hasText: /recycle/i }),
  ).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const { DirectTransport } = await import("/__test/lib/transport.js");
    const { backend } = await (await fetch("/api/config")).json();
    const transport = new DirectTransport(backend);
    try {
      const listings = [];
      for (const path of ["/dav/", "/dav/%E7%85%A7%E7%89%87/"]) {
        const response = await transport.request(path, {
          method: "PROPFIND",
          headers: { Depth: "1" },
        });
        listings.push({ status: response.status, xml: await response.text() });
      }
      const statuses = [];
      for (const path of [
        "/dav/%23recycle/",
        "/dav/%23recy%63le/deleted.txt",
        "/dav/%40Recycle/deleted.txt",
        "/dav/%E7%85%A7%E7%89%87/%40rEcYcLe/deleted.txt",
        "/dav/recycle-alias/",
        "/dav/recycle-alias/deleted.txt",
      ]) {
        for (const method of ["GET", "HEAD", "PROPFIND"]) {
          const response = await transport.request(path, {
            method,
            headers: { Depth: "1", Range: "bytes=0-5" },
          });
          statuses.push({ path, method, status: response.status });
          await response.body?.cancel();
        }
      }
      return { listings, statuses };
    } finally {
      transport.close();
    }
  });
  for (const listing of result.listings) {
    expect(listing.status).toBe(207);
    expect(listing.xml.toLowerCase()).not.toMatch(
      /recycle|deleted\.txt|recycled private fixture/,
    );
  }
  for (const request of result.statuses)
    expect(request.status, `${request.method} ${request.path}`).toBe(404);
});

test("NAS upload links enforce size, quotas, expiry and revocation in the browser", async ({
  page,
}) => {
  const created = await fixture.nas.createLink({
    maxFile: "8B",
    maxTotal: "8B",
    maxFiles: 1,
  });
  await page.goto(created.url);
  await expect(
    page.getByRole("heading", { name: "临时收照片", exact: true }),
  ).toBeVisible();
  await page.getByLabel("选择上传文件").setInputFiles({
    name: "too-big.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("123456789"),
  });
  await expect(page.getByRole("status")).toContainText("单文件大小限制");
  await page.getByLabel("选择上传文件").setInputFiles({
    name: "fits.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("12345678"),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "已接收" }),
  ).toHaveCount(1);
  await expect(page.getByLabel("选择上传文件")).toBeDisabled();
  await fixture.nas.revokeLink(created.link.id);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("已撤销");
  const expiring = await fixture.nas.createLink({ expires: "1s" });
  await expect
    .poll(() => Date.now() > Date.parse(expiring.link.expiresAt))
    .toBe(true);
  await page.goto(expiring.url);
  await expect(page.getByRole("alert")).toContainText("已过期");
});

test("direct HTTPS upload uses the same NAS permissions and supports zero-byte files", async ({
  page,
}) => {
  const previous = { ...fixture.env };
  const created = await fixture.nas.createLink();
  try {
    fixture.env.BACKEND_TRANSPORT = "http";
    fixture.env.BACKEND_ENDPOINT = "https://uploads.example";
    await page.route("https://uploads.example/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const response = await route.fetch({ url: fixture.nas.endpoint + path });
      await route.fulfill({ response });
    });
    await page.goto(created.url);
    await expect(
      page.getByRole("heading", { name: "临时收照片", exact: true }),
    ).toBeVisible();
    await page.getByLabel("选择上传文件").setInputFiles({
      name: "empty.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(0),
    });
    await expect(page.getByRole("status")).toHaveText("已接收");
    const files = await readdir(
      resolve(fixture.nas.dataDir, "inbox", created.link.id),
    );
    expect(
      await readFile(
        resolve(fixture.nas.dataDir, "inbox", created.link.id, files[0]),
        "utf8",
      ),
    ).toBe("");
  } finally {
    Object.assign(fixture.env, previous);
  }
});

test("cancelling a streaming upload through the bridge cleans partial files and restores quota", async ({
  page,
}) => {
  const created = await fixture.nas.createLink({
    maxFile: "4MiB",
    maxTotal: "4MiB",
    maxFiles: 1,
  });
  await page.goto(created.url);
  await expect(
    page.getByRole("heading", { name: "临时收照片", exact: true }),
  ).toBeVisible();
  const token = new URL(created.url).hash.slice("#/upload/".length);
  const cancelled = await page.evaluate(async (token) => {
    const { UploadClient } = await import("/__test/lib/uploads.js");
    const config = await (await fetch("/api/config")).json();
    const client = new UploadClient(config.backend, token);
    const controller = new AbortController();
    try {
      await client.upload(
        new File([new Uint8Array(4 * 1024 * 1024)], "cancelled.bin"),
        {
          signal: controller.signal,
          onProgress: () => controller.abort(),
        },
      );
      return false;
    } catch {
      return controller.signal.aborted;
    } finally {
      client.close();
    }
  }, token);
  expect(cancelled).toBe(true);
  await expect
    .poll(() => readdir(resolve(fixture.nas.dataDir, "inbox/.staging")))
    .toEqual([]);
  await page.reload();
  await expect(page.getByLabel("选择上传文件")).toBeEnabled();
  await page.getByLabel("选择上传文件").setInputFiles({
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retry succeeds"),
  });
  await expect(page.getByRole("status")).toHaveText("已接收");
});

test("IIIF thumbnails, preview and conditional cache work over real WebTransport", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.origin);
  await page
    .getByRole("button", { name: "打开文件夹 照片", exact: true })
    .click();
  await expect(page.locator(".file-card")).toHaveCount(2);
  const thumbnail = page
    .locator(".file-card")
    .filter({
      has: page.getByRole("button", { name: "预览 photo.png", exact: true }),
    })
    .locator(".thumbnail-slot img");
  await expect(thumbnail).toBeVisible();
  await expect
    .poll(() => thumbnail.evaluate((img) => img.naturalWidth))
    .toBe(128);
  await page.getByRole("button", { name: "网格视图", exact: true }).click();
  await expect
    .poll(() => thumbnail.evaluate((img) => img.naturalWidth))
    .toBe(384);
  await page
    .getByRole("button", { name: "预览 photo.png", exact: true })
    .click();
  const preview = page.locator(".preview-content img");
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((img) => img.naturalWidth))
    .toBe(1600);
  await expect(page.locator(".file-details")).toContainText("2400 × 1600");
  await page.screenshot({ path: testInfo.outputPath("iiif-preview.png") });
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(page.locator("#preview-dialog")).toHaveCount(0);
  const oldThumbnail = await thumbnail.getAttribute("src");
  await page.getByRole("button", { name: "刷新目录", exact: true }).click();
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail).not.toHaveAttribute("src", oldThumbnail);
  await expect
    .poll(() => thumbnail.evaluate((img) => img.naturalWidth))
    .toBe(384);
  const result = await page.evaluate(async () => {
    const { DirectTransport } = await import("/__test/lib/transport.js");
    const { DAVClient } = await import("/__test/lib/dav.js");
    const { backend } = await (await fetch("/api/config")).json();
    const transport = new DirectTransport(backend);
    const log = [];
    const request = transport.request.bind(transport);
    transport.request = async (path, opts) => {
      const response = await request(path, opts);
      log.push({ path, status: response.status, method: opts?.method });
      return response;
    };
    const client = new DAVClient(transport, backend);
    try {
      const path = backend.rootPath + encodeURIComponent("照片") + "/";
      const items = await client.list(path);
      await client.list(path);
      const listingsBeforeRefresh = log.filter(
        (r) => r.method === "PROPFIND",
      ).length;
      await client.images.image(items[0], 128);
      await client.images.image(items[0], 128);
      await client.list(path, undefined, { force: true });
      return {
        listingsBeforeRefresh,
        listingsAfterRefresh: log.filter((r) => r.method === "PROPFIND").length,
        imageStatuses: log
          .filter((r) => r.path.includes("/iiif/"))
          .map((r) => r.status),
      };
    } finally {
      client.dispose();
      transport.close();
    }
  });
  expect(result).toEqual({
    listingsBeforeRefresh: 1,
    listingsAfterRefresh: 2,
    imageStatuses: [200, 200, 304, 304],
  });
  const cached = await readdir(resolve(fixture.nas.dataDir, "cache/images"));
  expect(
    cached.filter((name) => name.endsWith(".jpg")).length,
  ).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test("video posters and MP4Box MediaSource playback seek over the real bridge", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.origin);
  await page
    .getByRole("button", { name: "打开文件夹 照片", exact: true })
    .click();
  const card = page.locator(".file-card").filter({
    has: page.getByRole("button", { name: "预览 video.mp4", exact: true }),
  });
  const poster = card.locator(".thumbnail-slot img");
  await expect(poster).toBeVisible();
  await expect.poll(() => poster.evaluate((img) => img.naturalWidth)).toBe(128);
  await page
    .getByRole("button", { name: "预览 video.mp4", exact: true })
    .click();
  const video = page.locator(".preview-content video");
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((v) => v.duration)).toBeCloseTo(8, 0);
  await expect(page.locator(".file-details")).toContainText("640 × 360");
  expect(await video.getAttribute("src")).toMatch(/^blob:/);
  await video.evaluate((v) => {
    v.muted = true;
    return v.play();
  });
  await expect
    .poll(() => video.evaluate((v) => v.currentTime))
    .toBeGreaterThan(0.2);
  await video.evaluate((v) => {
    v.currentTime = 6;
  });
  await expect
    .poll(() => video.evaluate((v) => !v.seeking && v.currentTime > 6))
    .toBe(true);
  await video.evaluate((v) => v.pause());
  await page.screenshot({ path: testInfo.outputPath("video-preview.png") });
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistrations()).length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(page.locator("#preview-dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("long moov-at-end videos load by Range, seek outside the buffer and seek back", async ({
  page,
}, testInfo) => {
  const { stat, rm } = await import("node:fs/promises");
  const path = await fixture.nas.longVideo();
  const size = (await stat(path)).size;
  try {
    await page.addInitScript(() => {
      window.videoReads = [];
      const create = WebTransport.prototype.createBidirectionalStream;
      WebTransport.prototype.createBidirectionalStream = async function (
        ...args
      ) {
        const stream = await create.apply(this, args);
        const writer = stream.writable.getWriter();
        let first = true;
        return {
          readable: stream.readable,
          writable: new WritableStream({
            write(chunk) {
              if (first) {
                first = false;
                const head = new TextDecoder().decode(chunk);
                const [method, path] = head.split(" ");
                const range = /\r\nrange:\s*([^\r\n]+)/i.exec(head)?.[1];
                if (path?.endsWith("long.mp4"))
                  window.videoReads.push({ method, path, range });
              }
              return writer.write(chunk);
            },
            close: () => writer.close(),
            abort: (reason) => writer.abort(reason),
          }),
        };
      };
    });
    await page.goto(fixture.origin);
    await page
      .getByRole("button", { name: "打开文件夹 照片", exact: true })
      .click();
    await page
      .getByRole("button", { name: "预览 long.mp4", exact: true })
      .click();
    const video = page.locator(".preview-content video");
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((v) => v.readyState))
      .toBeGreaterThanOrEqual(1);
    expect(await video.evaluate((v) => v.duration)).toBeCloseTo(120, 0);
    await expect
      .poll(() =>
        video.evaluate(
          (v) => v.buffered.length && v.buffered.end(v.buffered.length - 1),
        ),
      )
      .toBeGreaterThan(30);
    const before = await page.evaluate(() => window.videoReads);
    expect(before.length).toBeGreaterThan(1);
    expect(before.every((r) => /^bytes=\d+-\d+$/.test(r.range))).toBe(true);
    const requested = before.reduce((total, read) => {
      const [a, b] = read.range.slice(6).split("-").map(Number);
      return total + Math.min(size, b + 1) - a;
    }, 0);
    expect(requested).toBeLessThan(size);
    await video.evaluate((v) => {
      v.muted = true;
      v.currentTime = 100;
      return v.play();
    });
    await expect
      .poll(() => video.evaluate((v) => !v.seeking && v.currentTime > 100), {
        timeout: 15000,
      })
      .toBe(true);
    await video.evaluate((v) => {
      v.currentTime = 1;
    });
    await expect
      .poll(
        () =>
          video.evaluate(
            (v) => !v.seeking && v.currentTime > 1 && v.currentTime < 10,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => window.videoReads.length))
      .toBeGreaterThan(before.length + 1);
    await video.evaluate((v) => v.pause());
    await page.screenshot({ path: testInfo.outputPath("long-video.png") });
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await expect(page.locator("#preview-dialog")).toHaveCount(0);
    const reads = await page.evaluate(() => window.videoReads.length);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.videoReads.length)).toBe(reads);
  } finally {
    await rm(path, { force: true });
  }
});

test("public HTTPS videos use the original URL and native playback", async ({
  page,
}, testInfo) => {
  const previous = { ...fixture.env };
  const requests = [];
  try {
    fixture.env.BACKEND_TRANSPORT = "http";
    fixture.env.BACKEND_ENDPOINT = "https://media.example";
    await page.route("https://media.example/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("video.mp4")) requests.push(route.request().headers());
      const response = await route.fetch({ url: fixture.nas.endpoint + path });
      await route.fulfill({ response });
    });
    await page.goto(fixture.origin);
    await page
      .getByRole("button", { name: "打开文件夹 照片", exact: true })
      .click();
    await page
      .getByRole("button", { name: "预览 video.mp4", exact: true })
      .click();
    const video = page.locator(".preview-content video");
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute(
      "src",
      /^https:\/\/media\.example\/dav\//,
    );
    await expect
      .poll(() => video.evaluate((v) => v.readyState))
      .toBeGreaterThanOrEqual(1);
    await video.evaluate((v) => {
      v.muted = true;
      return v.play();
    });
    await expect
      .poll(() => video.evaluate((v) => v.currentTime))
      .toBeGreaterThan(0.2);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some((r) => r.range?.startsWith("bytes="))).toBe(true);
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .some((r) => r.name.includes("video-mp4-")),
      ),
    ).toBe(false);
    expect(
      await page.evaluate(
        async () => (await navigator.serviceWorker.getRegistrations()).length,
      ),
    ).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("https-video.png") });
  } finally {
    Object.assign(fixture.env, previous);
  }
});

test("rotated MOV playback preserves portrait orientation and releases each MediaSource", async ({
  page,
}) => {
  const { rm } = await import("node:fs/promises");
  const path = await fixture.nas.portraitVideo();
  try {
    await page.addInitScript(() => {
      window.previewSources = [];
      const create = URL.createObjectURL,
        revoke = URL.revokeObjectURL;
      URL.createObjectURL = function (value) {
        const url = create.call(URL, value);
        if (value instanceof MediaSource)
          window.previewSources.push({ source: value, url, revoked: false });
        return url;
      };
      URL.revokeObjectURL = function (url) {
        const entry = window.previewSources.find((v) => v.url === url);
        if (entry) entry.revoked = true;
        return revoke.call(URL, url);
      };
    });
    await page.goto(fixture.origin);
    await page
      .getByRole("button", { name: "打开文件夹 照片", exact: true })
      .click();
    for (const name of ["portrait.mov", "video.mp4", "portrait.mov"]) {
      await page
        .getByRole("button", { name: `预览 ${name}`, exact: true })
        .click();
      const video = page.locator(".preview-content video");
      await expect(video).toBeVisible();
      await expect
        .poll(() => video.evaluate((v) => v.readyState))
        .toBeGreaterThanOrEqual(1);
      const dimensions = await video.evaluate((v) => [
        v.videoWidth,
        v.videoHeight,
      ]);
      expect(dimensions).toEqual(
        name.endsWith(".mov") ? [360, 640] : [640, 360],
      );
      await video.evaluate((v) => {
        v.muted = true;
        return v.play();
      });
      await expect
        .poll(() => video.evaluate((v) => v.currentTime))
        .toBeGreaterThan(0.1);
      await page.getByRole("button", { name: "关闭预览", exact: true }).click();
      await expect(page.locator("#preview-dialog")).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.previewSources.every(
              (v) => v.revoked && v.source.readyState === "closed",
            ),
          ),
        )
        .toBe(true);
    }
  } finally {
    await rm(path, { force: true });
  }
});
