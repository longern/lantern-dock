import { test as base, expect } from "@playwright/test";
import { holdItem } from "../helpers/hold-item.mjs";
import { openItem } from "../helpers/open-item.mjs";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
});
const menu = (page) =>
  page.getByRole("menu", { name: "文件操作", exact: true });
const touch = () => !!test.info().project.use.hasTouch;
const key = "lantern-dock:http:http://127.0.0.1:8788:/dav/:recent";
const visit = {
  path: "/dav/photos/a.txt",
  name: "a.txt",
  kind: "text",
  isDirectory: false,
  size: 12,
  visitedAt: 2,
  modified: "2026-11-10T00:00:00Z",
};
const other = {
  ...visit,
  path: "/dav/photos/b.txt",
  name: "b.txt",
  visitedAt: 1,
};
async function fixture(page) {
  const state = { status: 200, listed: true, partial: false, log: [] };
  await page.addInitScript(
    ({ key, items }) => {
      localStorage.setItem(key, JSON.stringify(items));
      delete window.showSaveFilePicker;
      window.copiedLinks = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => window.copiedLinks.push(text) },
      });
    },
    { key, items: [visit, other] },
  );
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        backend: {
          transport: "http",
          endpoint: "http://127.0.0.1:8788",
          rootPath: "/dav/",
          auth: "none",
        },
      },
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.route("**/dav/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    state.log.push({ path, method: request.method() });
    if (request.method() === "PROPFIND") {
      const items =
        path === "/dav/"
          ? [{ path: "/dav/photos/", isDirectory: true }]
          : state.listed
            ? [visit, other]
            : [other];
      return route.fulfill({
        status: 207,
        contentType: "application/xml",
        body: `<d:multistatus xmlns:d="DAV:">${items.map((item) => `<d:response><d:href>${item.path}</d:href><d:propstat><d:prop><d:resourcetype>${item.isDirectory ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>12</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype></d:prop><d:status>HTTP/1.1 ${state.partial && item.path === visit.path ? "403 Forbidden" : "200 OK"}</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`,
      });
    }
    return route.fulfill({
      status: path === visit.path ? state.status : 200,
      contentType: "text/plain",
      headers: { "Last-Modified": "Tue, 10 Nov 2026 00:00:00 GMT" },
      body: request.method() === "HEAD" ? "" : "file content",
    });
  });
  await page.goto("/");
  await expect(page.locator("#file-list .file-item")).toHaveCount(2);
  return state;
}
const stored = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
async function showDetails(page) {
  const item = page.locator("#file-list .file-open").first();
  if (touch()) {
    await holdItem(page, item);
    await page
      .locator(".selection-panel")
      .getByRole("button", { name: "文件详情", exact: true })
      .tap();
  } else {
    await item.click({ button: "right" });
    await menu(page)
      .getByRole("menuitem", { name: "文件详情", exact: true })
      .click();
  }
  return page.getByRole("dialog", { name: "文件详情", exact: true });
}

test("right-click menu has compact rows, animated entry/exit, keyboard navigation and bulk actions", async ({
  page,
}, info) => {
  test.skip(touch(), "Desktop context menu");
  await fixture(page);
  const items = page.locator("#file-list .file-open");
  await items.first().click();
  await items.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await items.first().click({ button: "right", position: { x: 200, y: 30 } });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toBeFocused();
  await expect(menu(page)).toHaveCSS("outline-style", "none");
  await expect(menu(page).getByRole("menuitem").first()).not.toBeFocused();
  await expect(page.locator(".file-item[data-selected='true']")).toHaveCount(2);
  await menu(page).click({ position: { x: 2, y: 2 } });
  await expect(page.locator(".file-item[data-selected='true']")).toHaveCount(2);
  await expect(
    menu(page).getByRole("menuitem", { name: "文件详情" }),
  ).toHaveCount(0);
  await expect(menu(page).getByRole("menuitem").first()).toHaveCSS(
    "height",
    "32px",
  );
  await expect(menu(page).locator(".listing-options-surface")).toHaveCSS(
    "animation-name",
    "listing-menu-in",
  );
  await page.keyboard.press("End");
  await expect(menu(page).getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Escape");
  const closing = page.locator(".file-context-menu");
  await expect(closing).toHaveAttribute("data-state", "closed");
  await expect(closing).toHaveAttribute("inert", "");
  await expect(closing.locator(".listing-options-surface")).toHaveCSS(
    "animation-name",
    "listing-menu-out",
  );
  await expect(closing).toHaveCount(0);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
  await menu(page)
    .getByRole("menuitem", { name: "复制链接", exact: true })
    .click();
  expect(
    (await page.evaluate(() => window.copiedLinks.at(-1))).split("\n"),
  ).toHaveLength(2);
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await items.first().click({ button: "right" });
  await expect(
    menu(page).getByRole("menuitem", { name: "打开", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("file-context-menu.png") });
  await page.locator(".topbar").click({ position: { x: 250, y: 30 } });
  await expect(menu(page)).toHaveCount(0);
});

for (const status of [200, 404, 410, 401, 403, 500]) {
  test(`file details use HEAD and only remove missing recent entries (${status})`, async ({
    page,
  }) => {
    const state = await fixture(page);
    state.status = status;
    const details = await showDetails(page);
    await expect(details).toBeVisible();
    await expect(
      details.getByText("正在获取文件信息…", { exact: true }),
    ).toHaveCount(0);
    const missing = [404, 410].includes(status);
    await expect
      .poll(async () => (await stored(page)).length)
      .toBe(missing ? 1 : 2);
    if (missing) {
      await expect(details.getByRole("status")).toHaveText(
        "该文件已不存在或不可访问。",
      );
      expect((await stored(page)).map((item) => item.path)).toEqual([
        other.path,
      ]);
    }
    expect(state.log.filter((entry) => entry.method === "HEAD")).toEqual([
      { path: visit.path, method: "HEAD" },
    ]);
    expect(state.log.some((entry) => entry.method === "GET")).toBe(false);
    await details.getByRole("button", { name: "关闭文件详情" }).click();
    await expect(details).toHaveCount(0);
    if (missing)
      await expect(page.locator("#file-list .file-item")).toHaveCount(1);
  });
}

test("existing directory requests prune only their immediate missing children without scanning history", async ({
  page,
}) => {
  const state = await fixture(page);
  expect(
    state.log.every(
      (entry) => entry.method === "PROPFIND" && entry.path === "/dav/",
    ),
  ).toBe(true);
  expect((await stored(page)).length).toBe(2);
  state.listed = false;
  await page.goto("/files/photos/");
  await expect(page.locator("#file-list .file-item")).toHaveCount(1);
  await expect
    .poll(async () => (await stored(page)).map((item) => item.path))
    .toEqual([other.path]);
  expect(
    state.log.some((entry) => ["HEAD", "GET"].includes(entry.method)),
  ).toBe(false);
});

test("opening a missing source removes its recent entry", async ({ page }) => {
  const state = await fixture(page);
  state.status = 404;
  await openItem(page.locator("#file-list .file-open").first());
  await expect
    .poll(async () => (await stored(page)).map((item) => item.path))
    .toEqual([other.path]);
  expect(
    state.log.some(
      (entry) => entry.method === "GET" && entry.path === visit.path,
    ),
  ).toBe(true);
});

test("a failed original-file download also removes a confirmed missing recent entry", async ({
  page,
}) => {
  const state = await fixture(page);
  state.status = 410;
  const item = page.locator("#file-list .file-open").first();
  if (touch()) {
    await holdItem(page, item);
    await page
      .locator(".selection-panel")
      .getByRole("button", { name: "下载所选文件", exact: true })
      .tap();
  } else {
    await item.click({ button: "right" });
    await menu(page)
      .getByRole("menuitem", { name: "下载", exact: true })
      .click();
  }
  await expect
    .poll(async () => (await stored(page)).map((item) => item.path))
    .toEqual([other.path]);
  expect(
    state.log.some(
      (entry) => entry.method === "GET" && entry.path === visit.path,
    ),
  ).toBe(true);
});

test("removing a recent entry is local and keeps keyboard focus in the surviving list", async ({
  page,
}) => {
  test.skip(touch(), "Desktop context action");
  const state = await fixture(page);
  await page
    .locator("#file-list .file-open")
    .first()
    .click({ button: "right" });
  await menu(page)
    .getByRole("menuitem", { name: "从最近访问中移除", exact: true })
    .click();
  await expect(page.locator("#file-list .file-item")).toHaveCount(1);
  await expect(page.locator("#file-list")).toBeFocused();
  expect((await stored(page)).map((item) => item.path)).toEqual([other.path]);
  expect(state.log.every((entry) => entry.method === "PROPFIND")).toBe(true);
});

test("partial WebDAV property failures never remove recent records", async ({
  page,
}) => {
  const state = await fixture(page);
  state.partial = true;
  await page.goto("/files/photos/");
  await expect(page.locator("#file-list .file-item")).toHaveCount(1);
  expect((await stored(page)).length).toBe(2);
});
