import { openItem } from "../helpers/open-item.mjs";
import { listingOptionsButton } from "../helpers/listing-options.mjs";
import { test, expect } from "@playwright/test";
import { mainNavigation, openConnectionSettings } from "../helpers/navigation.mjs";

const recentKey = "lantern-dock:demo::/:recent";
const visit = {
  path: "/%E9%A1%B9%E7%9B%AE%E7%AC%94%E8%AE%B0.md",
  name: "项目笔记.md", kind: "text", isDirectory: false, size: 1248, visitedAt: 20,
};

for (const history of [[], [visit]]) {
  test(`home waits for history before choosing ${history.length ? "recent files" : "directory fallback"}`, async ({ page }) => {
    await page.addInitScript(({ key, history }) => {
      localStorage.setItem(key, JSON.stringify(history));
      window.homeTitles = [];
      new MutationObserver(() => {
        const title = document.querySelector(".file-section-title")?.textContent;
        if (title && window.homeTitles.at(-1) !== title) window.homeTitles.push(title);
      }).observe(document, { subtree: true, childList: true, characterData: true });
    }, { key: recentKey, history });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/config", async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".file-section-title")).toHaveText("最近文件");
      await expect(page.locator("#file-list")).toHaveAttribute("aria-busy", "true");
      await expect(page.locator("#file-list")).toHaveAttribute("aria-label", "最近文件列表");
      await expect(page.locator(".skeleton")).toHaveCount(8);
      await expect(page.locator(".file-item,.empty-state")).toHaveCount(0);
      await expect(listingOptionsButton(page)).toHaveCount(0);
    } finally {
      release();
    }
    await expect(page.locator(".file-item")).toHaveCount(history.length || 12);
    await expect(page.locator(".file-section-title")).toHaveText(history.length ? "最近文件" : "文件");
    await expect.poll(() => page.evaluate(() => window.homeTitles))
      .toEqual(history.length ? ["最近文件"] : ["最近文件", "文件"]);
  });
}

test("configuration failure remains an error without pretending history is empty", async ({ page }) => {
  await page.route("**/api/config", (route) => route.fulfill({
    status: 503, json: { error: "Configuration temporarily unavailable" },
  }));
  await page.goto("/");
  await expect(page.locator(".file-section-title")).toHaveText("最近文件");
  await expect(page.getByRole("heading", { name: "无法读取文件", exact: true })).toBeVisible();
  await expect(page.locator("#file-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".file-item,.skeleton")).toHaveCount(0);
  await expect(listingOptionsButton(page)).toHaveCount(0);
});

test("denied history reads stay errors and retry recovers without a directory flash", async ({ page }) => {
  await page.addInitScript(({ key, visit }) => {
    localStorage.setItem(key, JSON.stringify([visit]));
    window.blockRecentReads = true;
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      if (window.blockRecentReads && name === key)
        throw new DOMException("Denied", "SecurityError");
      return getItem.call(this, name);
    };
  }, { key: recentKey, visit });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "无法读取最近文件记录", exact: true })).toBeVisible();
  await expect(page.locator(".file-section-title")).toHaveText("最近文件");
  await expect(page.locator(".file-item,.skeleton")).toHaveCount(0);
  await expect(page.locator("#file-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => { window.blockRecentReads = false; });
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".file-name")).toHaveText([visit.name]);
  await expect(page.locator(".file-section-title")).toHaveText("最近文件");
  await expect(page.locator(".empty-state")).toHaveCount(0);
});

test("corrupt history is not overwritten by previewing a file and can be retried", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "{corrupt"), recentKey);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "无法读取最近文件记录", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看文件", exact: true }).click();
  await expect(page.locator(".file-item")).toHaveCount(12);
  await openItem(page.getByRole("button", { name: `预览 ${visit.name}`, exact: true }));
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), recentKey)).toBe("{corrupt");
  const nav = page.getByRole("navigation", {
    name: page.viewportSize().width <= 700 ? "移动端资源导航" : "资源导航", exact: true,
  });
  await nav.getByRole("button", { name: "首页", exact: true }).click();
  await expect(page.getByRole("heading", { name: "无法读取最近文件记录", exact: true })).toBeVisible();
  await page.evaluate((key) => localStorage.setItem(key, "[]"), recentKey);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".file-section-title")).toHaveText("文件");
  await expect(page.locator(".file-item")).toHaveCount(12);
});

for (const switchBackend of [false, true]) {
  test(`${switchBackend ? "switching backends" : "reconnecting"} waits for history and the replacement directory`, async ({ page }) => {
    await page.addInitScript(({ key, history }) => localStorage.setItem(key, JSON.stringify(history)), {
      key: recentKey, history: switchBackend ? [visit] : [],
    });
    await page.goto("/");
    await expect(page.locator(".file-item")).toHaveCount(switchBackend ? 1 : 12);
    await expect(page.locator(".status-pill")).toContainText("演示空间");
    await page.evaluate(() => {
      window.sawEmptyDirectory = false;
      new MutationObserver(() => {
        if (document.querySelector(".empty-state h2")?.textContent === "暂无文件")
          window.sawEmptyDirectory = true;
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/config", async (route) => {
      await gate;
      await route.fulfill({ json: { backend: {
        name: "公开资源库", transport: "demo", endpoint: switchBackend ? "second-backend" : "",
        rootPath: "/", auth: "none", gatewayAuth: false, certificates: [],
      } } });
    });
    try {
      await openConnectionSettings(page);
      await page.getByRole("button", { name: "连接", exact: true }).click();
      if (page.viewportSize().width <= 700)
        await mainNavigation(page).getByRole("button", { name: "首页", exact: true }).click();
      await expect(page.locator(".file-section-title")).toHaveText("最近文件");
      await expect(page.locator("#file-list")).toHaveAttribute("aria-busy", "true");
      await expect(page.locator(".file-item")).toHaveCount(0);
      await expect(page.locator(".skeleton")).toHaveCount(8);
    } finally {
      release();
    }
    await expect(page.locator(".file-item")).toHaveCount(12);
    await expect(page.locator(".file-section-title")).toHaveText("文件");
    expect(await page.evaluate(() => window.sawEmptyDirectory)).toBe(false);
  });
}

test("confirmed recents remain visible when directory loading fails", async ({ page }) => {
  const endpoint = "http://127.0.0.1:8788";
  await page.addInitScript(({ key, visit }) => localStorage.setItem(key, JSON.stringify([visit])), {
    key: `lantern-dock:http:${endpoint}:/:recent`, visit,
  });
  await page.route("**/api/config", (route) => route.fulfill({ json: { backend: {
    name: "Failed directory", transport: "http", endpoint, rootPath: "/",
    auth: "none", gatewayAuth: false, certificates: [],
  } } }));
  await page.route("**/*", (route) => route.request().method() === "PROPFIND"
    ? route.fulfill({ status: 503 }) : route.fallback());
  await page.goto("/");
  await expect(page.locator(".status-pill")).toContainText("连接异常");
  await expect(page.locator(".file-section-title")).toHaveText("最近文件");
  await expect(page.locator(".file-name")).toHaveText([visit.name]);
  await expect(page.locator(".empty-state,.skeleton")).toHaveCount(0);
  const nav = page.getByRole("navigation", {
    name: page.viewportSize().width <= 700 ? "移动端资源导航" : "资源导航", exact: true,
  });
  await nav.getByRole("button", { name: /^文件/ }).click();
  await expect(page.getByRole("heading", { name: "无法读取文件", exact: true })).toBeVisible();
});
