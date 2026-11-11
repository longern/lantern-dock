import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { breakpoints, isCompact } from "../helpers/responsive.mjs";

const token = "A".repeat(43);
const batch = "b".repeat(32);
const file = (name = "周末旅行.mp4", size = 8192) => ({
  name,
  mimeType: "video/mp4",
  buffer: Buffer.alloc(size, 65),
});
const info = {
  title: "旅行文件投递",
  expiresAt: "2036-01-01T00:00:00Z",
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 1024 ** 3,
  maxFiles: 200,
  usedFiles: 0,
  usedBytes: 0,
};

async function install(
  page,
  { resumable = false, holdRefresh = false, personal = false } = {},
) {
  const state = { creates: [], deletes: [], reads: 0, refresh: null };
  const root = personal ? "/api/account/uploads" : "/api/uploads";
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        backend: {
          transport: "http",
          endpoint: new URL(route.request().url()).origin,
          rootPath: "/dav/",
          auth: "none",
        },
      },
    }),
  );
  await page.route("**" + root + "**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "DELETE") {
      state.deletes.push(path);
      return route.fulfill({ status: 204 });
    }
    if (request.method() === "HEAD") {
      return route.fulfill({
        status: 204,
        headers: { "Upload-Offset": "2048" },
      });
    }
    if (request.method() === "POST") {
      state.creates.push(
        path.endsWith("/resumable") ? {} : request.postDataJSON(),
      );
      if (path.endsWith("/resumable"))
        return route.fulfill({
          status: 201,
          headers: {
            Location:
              root +
              "/resumable/" +
              state.creates.length.toString(16).padStart(32, "0"),
          },
        });
      return route.fulfill({
        status: 201,
        json: { id: state.creates.length.toString(16).padStart(32, "0") },
      });
    }
    if (path.endsWith("/resumable")) {
      const hash = (data) => createHash("sha256").update(data).digest();
      return route.fulfill({
        json: [
          {
            id: "c".repeat(32),
            name: file().name,
            size: 8192,
            offset: 2048,
            fingerprint: hash(hash(file().buffer)).toString("hex"),
            status: "pending",
          },
        ],
      });
    }
    if (path !== root) return route.fulfill({ json: { status: "pending" } });
    state.reads++;
    if (holdRefresh && state.reads > 1) {
      state.refresh = route;
      return;
    }
    return route.fulfill({
      json: info,
      headers: resumable ? { "Tus-Version": "1.0.0" } : {},
    });
  });
  // Control only XHR byte delivery. The production upload client, metadata,
  // cancellation cleanup, resumable protocol, and component queue remain real.
  await page.addInitScript(
    ({ storageKey, savedBatch }) => {
      if (savedBatch) sessionStorage.setItem(storageKey, savedBatch);
      const fixture = (window.uploadFixture = {
        requests: [],
        current() {
          return this.requests.findLast((request) => !request.finished);
        },
        progress(loaded) {
          const request = this.current();
          request.upload.onprogress?.({
            lengthComputable: true,
            loaded,
            total: request.body.size,
          });
        },
        finish() {
          const request = this.current();
          request.finished = true;
          request.status = request.method === "PATCH" ? 204 : 201;
          request.responseText = JSON.stringify({ status: "complete" });
          request.onload();
        },
        fail() {
          const request = this.current();
          request.finished = true;
          request.onerror();
        },
      });
      window.XMLHttpRequest = class {
        constructor() {
          this.upload = {};
          this.headers = {};
        }
        open(method, url) {
          this.method = method;
          this.url = String(url);
        }
        setRequestHeader(key, value) {
          this.headers[key] = value;
        }
        getResponseHeader() {
          return String(
            Number(this.headers["Upload-Offset"] || 0) + this.body.size,
          );
        }
        send(body) {
          this.body = body;
          fixture.requests.push(this);
        }
        abort() {
          if (!this.finished) {
            this.finished = true;
            this.onabort?.();
          }
        }
      };
    },
    {
      storageKey:
        "lantern-dock:upload-batch:" +
        createHash("sha256").update(token).digest("hex"),
      savedBatch: resumable ? batch : null,
    },
  );
  if (personal) {
    await page.route("**/src/lib/identity.js*", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `
        const user = { sub: 'upload-user', issuer: location.origin, name: 'Uploader', role: 'member' };
        export async function identitySession() { return { authenticated: true, user }; }
        export async function accountConnection() { return { user, capabilities: { directUploads: true }, backend: { transport: 'http', endpoint: location.origin, rootPath: '/dav/', auth: 'none' }, transport: { close() {} } }; }
        export async function requestNASGrant() { return { access_token: 'fixture-token', token_type: 'DPoP', expires_in: 60 }; }
        export async function identityProof() { return 'fixture-proof'; }
        export async function beginLogin() {}
        export async function endLogin() {}
      `,
      }),
    );
    await page.route("**/api/capabilities", (route) =>
      route.fulfill({
        json: {
          version: 1,
          services: {
            inbox: {
              enabled: true,
              protocol: "lantern-dock-inbox",
              version: 1,
              href: "/api/uploads",
            },
          },
        },
      }),
    );
    await page.route("**/dav/**", (route) =>
      route.fulfill({
        status: 207,
        contentType: "application/xml",
        body: '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
      }),
    );
    await page.goto("/files/");
  } else await page.goto("/upload#token=" + token);
  return state;
}

async function active(page) {
  await expect
    .poll(() => page.evaluate(() => !!window.uploadFixture.current()))
    .toBe(true);
}

async function noOverflow(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".upload-panel")
      .evaluate((node) => node.scrollHeight <= node.clientHeight + 1),
  ).toBe(true);
}

test("single-file uploads keep a compact row and show foreground guidance only during transfer", async ({
  page,
}, testInfo) => {
  await install(page);
  await expect(page.locator(".upload-foreground-note")).toHaveCount(0);
  await expect(page.getByLabel("选择上传文件", { exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("upload-ready.png") });
  await page.getByLabel("选择上传文件", { exact: true }).setInputFiles(file());
  await active(page);
  await page.evaluate(() => window.uploadFixture.progress(2048));
  await expect(page.locator(".upload-summary strong")).toHaveText("25%");
  await expect(page.locator(".upload-foreground-note")).toContainText(
    "锁屏或切换应用可能中断上传",
  );
  await expect(page.locator(".upload-drop")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "取消上传", exact: true }),
  ).toBeVisible();
  const row = await page.locator(".upload-file").boundingBox();
  expect(row.height).toBeLessThan(110);
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("upload-single.png") });
  await page.evaluate(() => window.uploadFixture.finish());
  await expect(page.locator(".upload-result.complete")).toHaveCount(1);
  await expect(page.locator(".upload-summary strong")).toHaveText("100%");
  await expect(page.locator(".upload-foreground-note")).toHaveCount(0);
  await expect(page.getByLabel("选择上传文件", { exact: true })).toBeEnabled();
});

test("a 100-file queue scrolls independently and cancel all prevents any queued upload from starting", async ({
  page,
}, testInfo) => {
  const state = await install(page);
  await page
    .getByLabel("选择上传文件", { exact: true })
    .setInputFiles(
      Array.from({ length: 100 }, (_, index) =>
        file(`旅行片段${String(index + 1).padStart(2, "0")}.mp4`),
      ),
    );
  for (let index = 0; index < 12; index++) {
    await active(page);
    await page.evaluate(() => window.uploadFixture.finish());
    await expect(page.locator(".upload-result.complete")).toHaveCount(
      index + 1,
    );
  }
  await active(page);
  await page.evaluate(() => window.uploadFixture.progress(2048));
  await expect(page.locator(".upload-summary strong")).toHaveText("12%");
  await expect(page.locator(".upload-file")).toHaveCount(100);
  await expect(page.locator(".upload-file").first()).toHaveClass(/uploading/);
  await expect(page.locator(".upload-result.queued")).toHaveCount(87);
  if (page.viewportSize().width >= breakpoints.values.md) {
    const overview = await page.locator(".upload-summary").boundingBox();
    const queue = await page.locator(".upload-content").boundingBox();
    expect(queue.x).toBeGreaterThan(overview.x + overview.width);
    const visible = await page.locator(".upload-results").evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return [...node.children].filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      }).length;
    });
    expect(visible).toBeGreaterThanOrEqual(8);
  }
  const before = await page.locator(".upload-actions").boundingBox();
  await page.screenshot({ path: testInfo.outputPath("upload-many.png") });
  const scrolled = await page.locator(".upload-results").evaluate((node) => {
    node.scrollTop = 600;
    return {
      top: node.scrollTop,
      height: node.clientHeight,
      total: node.scrollHeight,
    };
  });
  expect(scrolled.total).toBeGreaterThan(scrolled.height);
  expect(scrolled.top).toBeGreaterThan(0);
  expect((await page.locator(".upload-actions").boundingBox()).y).toBe(
    before.y,
  );
  await expect(page.locator(".upload-foreground-note")).toBeInViewport();
  await noOverflow(page);
  await page.getByRole("button", { name: "取消全部", exact: true }).click();
  await expect(page.locator(".upload-result.cancelled")).toHaveCount(88);
  await expect(page.locator(".upload-panel")).not.toHaveAttribute(
    "data-working",
    "",
  );
  expect(state.creates).toHaveLength(13);
  expect(state.deletes).toHaveLength(1);
  await expect(page.locator(".upload-result.complete")).toHaveCount(12);
  await expect(page.locator(".upload-foreground-note")).toHaveCount(0);
});

test("overall progress is weighted by bytes and cancellation also stops a queue between requests", async ({
  page,
}) => {
  const state = await install(page, { holdRefresh: true });
  await page
    .getByLabel("选择上传文件", { exact: true })
    .setInputFiles([file("small.mp4", 8192), file("large.mp4", 24576)]);
  await active(page);
  await page.evaluate(() => window.uploadFixture.progress(4096));
  await expect(page.locator(".upload-summary strong")).toHaveText("12%");
  await expect(page.locator(".upload-result.uploading")).toHaveText(
    "上传中 · 50%",
  );
  await page.evaluate(() => window.uploadFixture.finish());
  await expect.poll(() => !!state.refresh).toBe(true);
  await expect(page.locator(".upload-summary strong")).toHaveText("25%");
  await page.getByRole("button", { name: "取消全部", exact: true }).click();
  await expect(page.locator(".upload-result.cancelled")).toHaveCount(1);
  await state.refresh.fulfill({ json: info });
  await expect(page.locator(".upload-panel")).not.toHaveAttribute(
    "data-working",
    "",
  );
  expect(state.creates).toHaveLength(1);
});

test("restored paused uploads retain original-file resume and cancellation controls", async ({
  page,
}) => {
  const state = await install(page, { resumable: true });
  await expect(page.locator(".upload-result.paused")).toBeVisible();
  await expect(page.locator(".upload-foreground-note")).toHaveCount(0);
  await page
    .getByLabel("重选原文件继续", { exact: true })
    .setInputFiles(file());
  await active(page);
  await page.evaluate(() => window.uploadFixture.progress(2048));
  await expect(page.locator(".upload-summary strong")).toHaveText("50%");
  await expect(page.locator(".upload-foreground-note")).toBeVisible();
  await page.getByRole("button", { name: "取消上传", exact: true }).click();
  await expect(page.locator(".upload-result.cancelled")).toHaveCount(1);
  expect(state.deletes).toEqual(["/api/uploads/resumable/" + "c".repeat(32)]);
  expect(state.creates).toHaveLength(0);
});

test("upload errors stay with the affected file and never show a successful total", async ({
  page,
}) => {
  await install(page);
  await page.getByLabel("选择上传文件", { exact: true }).setInputFiles(file());
  await active(page);
  await page.evaluate(() => window.uploadFixture.fail());
  await expect(page.locator(".upload-result.failed")).toHaveText("上传失败");
  await expect(page.locator(".upload-file-error")).toBeVisible();
  await expect(page.locator(".upload-summary strong")).toHaveText("0%");
  await expect(page.locator(".upload-foreground-note")).toHaveCount(0);
  await noOverflow(page);
});

test("files can be appended during transfer and individual cancellation preserves the rest of the queue", async ({
  page,
}) => {
  const state = await install(page);
  await page
    .getByLabel("选择上传文件", { exact: true })
    .setInputFiles([file("first.mp4"), file("skip.mp4")]);
  await active(page);
  await page.evaluate(() => window.uploadFixture.progress(2048));
  await page
    .getByLabel("选择上传文件", { exact: true })
    .setInputFiles(file("appended.mp4"));
  await expect(page.locator(".upload-file")).toHaveCount(3);
  await expect(page.locator(".upload-summary strong")).toHaveText("8%");
  await page
    .getByRole("button", { name: "取消上传 skip.mp4", exact: true })
    .click();
  await expect(page.locator(".upload-result.cancelled")).toHaveCount(1);
  expect(state.creates).toHaveLength(1);
  await page
    .getByRole("button", { name: "取消上传 first.mp4", exact: true })
    .click();
  await expect.poll(() => state.creates.length).toBe(2);
  await active(page);
  await expect(page.locator(".upload-file.uploading")).toContainText(
    "appended.mp4",
  );
  await page.evaluate(() => window.uploadFixture.finish());
  await expect(page.locator(".upload-result.complete")).toHaveCount(1);
  await expect(page.locator(".upload-result.cancelled")).toHaveCount(2);
  expect(state.creates.map((request) => request.name)).toEqual([
    "first.mp4",
    "appended.mp4",
  ]);
});

test("authenticated uploads use the same bounded layout and stay open until cancellation settles", async ({
  page,
}, testInfo) => {
  const state = await install(page, { personal: true });
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#file-intake-trigger").click();
  if (isCompact(page))
    await page
      .locator(".intake-sheet")
      .getByRole("button", { name: "选择文件上传" })
      .click();
  await (
    await chooser
  ).setFiles([file(), file("片段02.mp4"), file("片段03.mp4")]);
  const dialog = page.getByRole("dialog", { name: "上传文件", exact: true });
  await active(page);
  await page.evaluate(() => window.uploadFixture.progress(2048));
  await expect(
    dialog.getByRole("button", { name: "关闭对话框", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".upload-foreground-note")).toBeVisible();
  await noOverflow(page);
  await dialog.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  await page.screenshot({ path: testInfo.outputPath("upload-personal.png") });
  await dialog.getByRole("button", { name: "取消全部", exact: true }).click();
  await expect(dialog.locator(".upload-result.cancelled")).toHaveCount(3);
  await expect(
    dialog.getByRole("button", { name: "完成", exact: true }),
  ).toBeEnabled();
  expect(state.creates).toHaveLength(1);
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#file-intake-trigger")).toBeFocused();
});

test.describe("English upload layout", () => {
  test.use({ locale: "en-US" });
  test("long names and English statuses fit the queue with usable icon targets", async ({
    page,
  }, testInfo) => {
    await install(page);
    await page
      .getByLabel("Choose files to upload", { exact: true })
      .setInputFiles([
        file(
          "a-very-long-name-that-should-truncate-without-hiding-the-controls.mp4",
        ),
        file("second.mp4"),
      ]);
    await active(page);
    await page.evaluate(() => window.uploadFixture.progress(2048));
    await expect(page.locator(".upload-subtitle")).toHaveText(
      "2 files · 16.0 KB",
    );
    await expect(page.locator(".upload-foreground-note")).toContainText(
      "Keep this page in the foreground",
    );
    await noOverflow(page);
    const target = await page
      .locator(".upload-file-cancel")
      .first()
      .boundingBox();
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("upload-english.png") });
  });
});

test("cancel all also cancels paused tasks after adding another upload", async ({
  page,
}) => {
  const state = await install(page, { resumable: true });
  await expect(page.locator(".upload-result.paused")).toHaveCount(1);
  await page
    .getByLabel("选择上传文件", { exact: true })
    .setInputFiles(file("new.mp4"));
  await active(page);
  await page.getByRole("button", { name: "取消全部", exact: true }).click();
  await expect(page.locator(".upload-result.cancelled")).toHaveCount(2);
  await expect(page.locator(".upload-panel")).not.toHaveAttribute(
    "data-working",
    "",
  );
  expect(state.deletes).toHaveLength(2);
  expect(state.creates).toHaveLength(1);
});

test("short landscape screens keep the foreground note, active row, and cancel action visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await install(page);
  await page
    .getByLabel("选择上传文件", { exact: true })
    .setInputFiles([file(), file("second.mp4")]);
  await active(page);
  await expect(page.locator(".upload-foreground-note")).toBeInViewport();
  await expect(page.locator(".upload-file.uploading")).toBeInViewport({
    ratio: 1,
  });
  await expect(
    page.getByRole("button", { name: "取消全部", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await noOverflow(page);
});

test("the upload queue switches columns at the shared breakpoint without interrupting an active transfer", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Resize one desktop viewport across portrait and landscape widths",
  );
  const state = await install(page);
  await page
    .getByLabel("选择上传文件", { exact: true })
    .setInputFiles(
      Array.from({ length: 100 }, (_, index) => file(`片段${index + 1}.mp4`)),
    );
  await active(page);
  await page.evaluate(() => window.uploadFixture.progress(2048));
  for (const [width, height] of [
    [899, 900],
    [900, 900],
    [1024, 768],
    [1440, 1000],
    [768, 1024],
  ]) {
    await page.setViewportSize({ width, height });
    const overview = await page.locator(".upload-summary").boundingBox();
    const queue = await page.locator(".upload-content").boundingBox();
    if (width >= breakpoints.values.md) {
      expect(queue.x).toBeGreaterThan(overview.x + overview.width);
      expect(queue.y).toBeLessThan(overview.y);
    } else {
      expect(queue.y).toBeGreaterThan(overview.y + overview.height);
    }
    await noOverflow(page);
    await expect(page.locator(".upload-foreground-note")).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "取消全部", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".upload-result.uploading")).toHaveText(
      "上传中 · 25%",
    );
    if (width === 1024)
      await page.screenshot({
        path: testInfo.outputPath("upload-tablet-landscape.png"),
      });
  }
  expect(state.creates).toHaveLength(1);
});
