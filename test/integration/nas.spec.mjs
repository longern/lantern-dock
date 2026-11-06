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
