import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openItem } from "../helpers/open-item.mjs";
import { holdItem } from "../helpers/hold-item.mjs";

async function install(page, files = ["a.txt", "b.txt"]) {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        backend: {
          name: "Downloads",
          transport: "http",
          endpoint: "http://127.0.0.1:8788",
          rootPath: "/dav/",
          auth: "none",
          certificates: [],
        },
      },
    }),
  );
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.route("**/dav/**", (route) =>
    route.request().method() === "PROPFIND"
      ? route.fulfill({
          status: 207,
          contentType: "application/xml",
          body: `<d:multistatus xmlns:d="DAV:">${files.map((name) => `<d:response><d:href>/dav/${name}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>8</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`,
        })
      : route.fulfill({
          contentType: "text/plain",
          body: new URL(route.request().url()).pathname,
        }),
  );
  await page.goto("/files/");
  await expect(page.locator("#file-list .file-item")).toHaveCount(files.length);
  await expect(page.locator(".favorite-button,.file-copy-button")).toHaveCount(
    0,
  );
}
async function selectAll(page) {
  const items = page.locator("#file-list .file-open");
  if (page.viewportSize().width <= 700) {
    await holdItem(page, items.first());
    if (await items.count() > 1) await page
      .getByRole("toolbar")
      .getByRole("button", { name: "全选", exact: true })
      .tap();
  } else {
    await items.first().focus();
    await items.first().press("ControlOrMeta+a");
  }
}
test("multiple files become separate browser downloads without a ZIP", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
  await install(page);
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await selectAll(page);
  await page.getByRole("button", { name: "下载所选文件", exact: true }).click();
  await expect.poll(() => downloads.length).toBe(2);
  expect(downloads.map((item) => item.suggestedFilename())).toEqual([
    "a.txt",
    "b.txt",
  ]);
  for (const download of downloads)
    expect(await readFile(await download.path(), "utf8")).toBe(
      `/dav/${download.suggestedFilename()}`,
    );
  await expect(
    page.locator(".transfer-summary, .transfer-running"),
  ).toHaveCount(0);
});
test("one directory picker streams files and keeps existing destination names", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.savedFiles = { "a.txt": "Existing file" };
    window.directoryPickers = 0;
    window.showSaveFilePicker = async () => {
      throw new Error("Repeated file picker");
    };
    window.showDirectoryPicker = async () => {
      window.directoryPickers++;
      return {
        async getFileHandle(name, options) {
          if (!options?.create && !(name in window.savedFiles))
            throw new DOMException("Missing", "NotFoundError");
          if (options?.create) window.savedFiles[name] = "";
          return {
            async createWritable() {
              let value = "";
              return {
                async write(bytes) {
                  value += new TextDecoder().decode(bytes);
                },
                async close() {
                  window.savedFiles[name] = value;
                },
                async abort() {},
              };
            },
          };
        },
        async removeEntry(name) {
          delete window.savedFiles[name];
        },
      };
    };
  });
  await install(page);
  await selectAll(page);
  await page.getByRole("button", { name: "下载所选文件", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.savedFiles["b.txt"]))
    .toBe("/dav/b.txt");
  expect(await page.evaluate(() => window.savedFiles)).toEqual({
    "a.txt": "Existing file",
    "a (1).txt": "/dav/a.txt",
    "b.txt": "/dav/b.txt",
  });
  expect(await page.evaluate(() => window.directoryPickers)).toBe(1);
});
test("cancelling the current file stops the remaining queue", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
  await install(page, ["a.txt", "b.txt", "c.txt"]);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reads = [];
  await page.route("**/dav/*.txt", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const name = new URL(route.request().url()).pathname.split("/").pop();
    reads.push(name);
    if (name === "b.txt") await gate;
    return route.fulfill({ body: name }).catch(() => {});
  });
  try {
    await selectAll(page);
    await page
      .getByRole("button", { name: "下载所选文件", exact: true })
      .click();
    if (page.viewportSize().width <= 700)
      await expect(page.locator(".transfer-summary")).toContainText(
        "第 2 项，共 3 项",
      );
    else await expect(page.locator(".transfer-running")).toContainText("b.txt");
    await page.getByRole("button", { name: "取消下载", exact: true }).click();
    await expect(
      page.locator(".transfer-summary, .transfer-running"),
    ).toHaveCount(0);
    expect(reads).toEqual(["a.txt", "b.txt"]);
  } finally {
    release();
  }
});

async function settleCenter(page) {
  await center(page).evaluate(async (node) => {
    await Promise.all(
      node
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}
const center = (page) =>
  page.viewportSize().width <= 700
    ? page.locator("#transfer-dialog")
    : page.locator(".transfer-window");
async function openCenter(page) {
  if (page.viewportSize().width <= 700)
    await page.locator(".transfer-summary-open").click();
  await expect(center(page)).toBeVisible();
  await settleCenter(page);
}

test("home transfer entry adapts to viewport and supports closing and browser Back", async ({
  page,
}) => {
  await install(page);
  await page.goto("/");
  const trigger = page.locator("#transfers-button");
  await trigger.click();
  await expect(center(page)).toBeVisible();
  await expect(center(page)).toContainText("暂无传输任务");
  await settleCenter(page);
  const bounds = await center(page).boundingBox();
  if (page.viewportSize().width <= 700) {
    expect(bounds.width).toBeCloseTo(page.viewportSize().width, 1);
    await page.goBack();
    await expect(center(page)).toBeHidden();
    await expect(page).toHaveURL("/");
    await page.goForward();
    await expect(center(page)).toBeVisible();
  } else {
    expect(bounds.width).toBe(420);
    expect(Math.round(bounds.x + bounds.width)).toBe(
      await page
        .locator(".app-shell")
        .evaluate((node) => node.getBoundingClientRect().right - 24),
    );
    expect(Math.round(bounds.y + bounds.height)).toBe(
      page.viewportSize().height - 24,
    );
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await page.getByRole("searchbox").fill("a");
    await expect(center(page)).toBeVisible();
  }
  await center(page)
    .getByRole("button", { name: "收起传输列表", exact: true })
    .click();
  await expect(center(page)).toBeHidden();
  await trigger.focus();
  await trigger.press("Enter");
  await expect(center(page)).toBeVisible();
  await center(page)
    .getByRole("button", { name: "收起传输列表", exact: true })
    .press("Escape");
  await expect(center(page)).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("transfer history survives collapse; clearing finished keeps active tasks and cancellation stops queue", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
  await install(page, ["a.txt", "b.txt", "c.txt"]);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reads = [];
  await page.route("**/dav/*.txt", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const name = new URL(route.request().url()).pathname.split("/").pop();
    reads.push(name);
    if (name === "b.txt") await gate;
    return route.fulfill({ body: name }).catch(() => {});
  });
  try {
    await selectAll(page);
    await page
      .getByRole("button", { name: "下载所选文件", exact: true })
      .click();
    await expect.poll(() => reads).toEqual(["a.txt", "b.txt"]);
    await openCenter(page);
    await expect(center(page).locator(".transfer-submitted")).toContainText(
      "a.txt",
    );
    await expect(center(page).locator(".transfer-running")).toContainText(
      "b.txt",
    );
    await expect(center(page).locator(".transfer-queued")).toContainText(
      "c.txt",
    );
    await settleCenter(page);
    await page.screenshot({ path: testInfo.outputPath("transfers.png") });
    await center(page)
      .getByRole("button", { name: "收起传输列表", exact: true })
      .click();
    await expect(center(page)).toBeHidden();
    await expect(page.locator(".transfer-summary")).toBeVisible();
    expect(reads).toEqual(["a.txt", "b.txt"]);
    await page.locator(".transfer-summary-open").click();
    await expect(center(page)).toBeVisible();
    await center(page)
      .getByRole("button", { name: "清除已结束", exact: true })
      .click();
    await expect(center(page).locator(".transfer-item")).toHaveCount(2);
    await expect(center(page).locator(".transfer-running")).toContainText(
      "b.txt",
    );
    await center(page)
      .getByRole("button", { name: "取消下载", exact: true })
      .click();
    await expect(center(page).locator(".transfer-cancelled")).toHaveCount(2);
    await expect(
      center(page).getByRole("button", { name: "重试 b.txt", exact: true }),
    ).toBeEnabled();
    expect(reads).toEqual(["a.txt", "b.txt"]);
    release();
    await center(page)
      .getByRole("button", { name: "重试 b.txt", exact: true })
      .click();
    await expect(center(page).locator(".transfer-submitted")).toContainText(
      "b.txt",
    );
    expect(reads).toEqual(["a.txt", "b.txt", "b.txt"]);
    await center(page)
      .getByRole("button", { name: "清除已结束", exact: true })
      .click();
    await expect(center(page)).toContainText("暂无传输任务");
    await expect(page.locator(".transfer-summary")).toHaveCount(0);
  } finally {
    release();
  }
});

test("a failed transfer remains visible and can be retried on its own", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
  await install(page, ["a.txt", "b.txt"]);
  let attempts = 0;
  await page.route("**/dav/a.txt", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return ++attempts === 1
      ? route.fulfill({ status: 500, body: "Failed" })
      : route.fulfill({ body: "a.txt" });
  });
  await selectAll(page);
  await page.getByRole("button", { name: "下载所选文件", exact: true }).click();
  // Fast failures need no persistent compact progress prompt; reopen from Home.
  if (page.viewportSize().width <= 700) {
    await page
      .getByRole("navigation", { name: "移动端资源导航" })
      .getByRole("button", { name: "首页", exact: true })
      .click();
    await page.locator("#transfers-button").click();
  }
  await expect(center(page).locator(".transfer-failed")).toContainText("a.txt");
  await expect(center(page).locator(".transfer-cancelled")).toContainText(
    "b.txt",
  );
  await center(page)
    .getByRole("button", { name: "重试 a.txt", exact: true })
    .click();
  await expect(center(page).locator(".transfer-submitted")).toContainText(
    "a.txt",
  );
  expect(attempts).toBe(2);
  await center(page)
    .getByRole("button", { name: "收起传输列表", exact: true })
    .click();
  await expect(center(page)).toBeHidden();
  await page.reload();
  if (page.viewportSize().width > 700)
    await page
      .getByRole("navigation", { name: "资源导航" })
      .getByRole("button", { name: "首页", exact: true })
      .click();
  await page.locator("#transfers-button").click();
  await expect(center(page)).toContainText("暂无传输任务");
});

test("transfers inside a preview close independently and leave the download running", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
  await install(page, ["a.txt"]);
  await openItem(page.getByRole("button", { name: "预览 a.txt", exact: true }));
  await expect(page.locator("#preview-dialog")).toBeVisible();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/dav/a.txt", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await gate;
    return route.fulfill({ body: "a.txt" }).catch(() => {});
  });
  try {
    await page.getByRole("button", { name: "下载", exact: true }).click();
    await openCenter(page);
    if (page.viewportSize().width <= 700) await page.goBack();
    else
      await center(page)
        .getByRole("button", { name: "收起传输列表", exact: true })
        .press("Escape");
    await expect(center(page)).toBeHidden();
    await expect(page.locator("#preview-dialog")).toBeVisible();
    await expect(page).toHaveURL("/files/a.txt");
    await expect(page.locator(".transfer-summary")).toBeVisible();
    await page.getByRole("button", { name: "取消下载", exact: true }).click();
    await expect(page.locator(".transfer-summary")).toHaveCount(0);
  } finally {
    release();
  }
});

test("an expanded desktop window becomes a mobile dialog with its own Back entry", async ({
  page,
}) => {
  test.skip(page.viewportSize().width <= 700, "Starts with a desktop window");
  await install(page);
  await page.goto("/");
  await page.locator("#transfers-button").click();
  await expect(page.locator(".transfer-window")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#transfer-dialog")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#transfer-dialog")).toBeHidden();
  await expect(page).toHaveURL("/");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  await expect(page.locator(".transfer-window")).toBeHidden();
});

test("cancelling a destination picker keeps a retryable task; retry reports a confirmed native save", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.pickerAttempts = 0;
    window.savedDownload = "";
    window.showSaveFilePicker = async () => {
      if (++window.pickerAttempts === 1)
        throw new DOMException("Cancelled", "AbortError");
      return {
        async createWritable() {
          let result = "";
          return {
            async write(value) {
              result += new TextDecoder().decode(value);
            },
            async close() {
              window.savedDownload = result;
            },
            async abort() {},
          };
        },
      };
    };
  });
  await install(page, ["a.txt"]);
  let reads = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith("/dav/a.txt"))
      reads++;
  });
  await selectAll(page);
  await page.getByRole("button", { name: "下载所选文件", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pickerAttempts)).toBe(1);
  if (page.viewportSize().width <= 700) {
    await page
      .getByRole("navigation", { name: "移动端资源导航" })
      .getByRole("button", { name: "首页", exact: true })
      .click();
    await page.locator("#transfers-button").click();
  }
  await expect(center(page).locator(".transfer-cancelled")).toContainText(
    "a.txt",
  );
  expect(reads).toBe(0);
  await center(page)
    .getByRole("button", { name: "重试 a.txt", exact: true })
    .click();
  await expect(center(page).locator(".transfer-saved")).toContainText("已保存");
  expect(reads).toBe(1);
  expect(await page.evaluate(() => window.pickerAttempts)).toBe(2);
  expect(await page.evaluate(() => window.savedDownload)).toBe("/dav/a.txt");
  await expect(center(page).locator(".transfer-submitted")).toHaveCount(0);
});
