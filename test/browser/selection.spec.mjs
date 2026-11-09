import { test as base, expect } from "@playwright/test";
import { openFavorites } from "../helpers/navigation.mjs";
import { chooseListingOption } from "../helpers/listing-options.mjs";
import { holdItem as hold } from "../helpers/hold-item.mjs";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.copiedSelection = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async value => window.copiedSelection.push(value),
      } });
    });
    await use(page);
    expect(errors).toEqual([]);
  },
});
const panel = page => page.locator(".selection-panel");
const selected = page => page.locator("#file-list .file-item[data-selected='true']");
const actions = page => page.getByRole("toolbar", { name: "所选项目操作" });
const touch = page => page.viewportSize().width <= 700;

test.beforeEach(async ({ page }) => {
  await page.goto("/files/");
  await expect(page.locator("#file-list .file-open")).toHaveCount(12);
});

test("desktop single click selects, modifiers toggle and Shift ranges follow the visible list", async ({ page }) => {
  test.skip(touch(page), "Mouse selection");
  const items = page.locator("#file-list .file-open");
  await items.nth(1).click();
  await expect(selected(page)).toHaveCount(1);
  await expect(page).toHaveURL(/\/files\/$/);
  await items.nth(3).click({ modifiers: ["ControlOrMeta"] });
  await expect(selected(page)).toHaveCount(2);
  await items.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await expect(selected(page)).toHaveCount(1);
  await items.nth(5).click({ modifiers: ["ControlOrMeta"] });
  await items.nth(8).click({ modifiers: ["Shift"] });
  await expect(selected(page)).toHaveCount(4);
  await items.nth(10).click({ modifiers: ["ControlOrMeta", "Shift"] });
  await expect(selected(page)).toHaveCount(6);
  await expect(page.locator("#item-count")).toHaveText("已选 6 项");
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(selected(page)).toHaveCount(0);
  await expect(page.locator("#item-count")).toHaveText("12 个项目");
  await items.first().dblclick();
  await expect(page).not.toHaveURL(/\/files\/$/);
  await expect(panel(page)).toHaveCount(0);
});

test("desktop keyboard selection and inline bulk actions preserve browser history", async ({ page }) => {
  test.skip(touch(page), "Mouse and keyboard selection");
  const items = page.locator("#file-list .file-open");
  await items.nth(4).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(page)).toHaveCount(2);
  await actions(page).getByRole("button", { name: "复制所选链接" }).click();
  const copied = await page.evaluate(() => window.copiedSelection.at(-1).split("\n"));
  expect(copied).toHaveLength(2);
  expect(copied.every(link => new URL(link).pathname.startsWith("/files/"))).toBe(true);
  await actions(page).getByRole("button", { name: "收藏所选项目", exact: true }).click();
  await expect(actions(page).getByRole("button", { name: "取消收藏所选项目", exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.endsWith(":favorites")))).length)).toBe(2);
  await items.nth(5).focus();
  await page.keyboard.press("Control+a");
  await expect(selected(page)).toHaveCount(12);
  await page.keyboard.press("Escape");
  await items.filter({ hasText: "项目笔记.md" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "关闭预览", exact: true })).toBeVisible();
});

test("touch long press replaces bottom navigation with a floating selection toolbar", async ({ page }, testInfo) => {
  test.skip(!touch(page), "Touch selection");
  const items = page.locator("#file-list .file-open");
  const artBefore = await items.first().locator(".file-art").boundingBox();
  await hold(page, items.first());
  await expect(selected(page)).toHaveCount(1);
  const row = await selected(page).first().boundingBox();
  expect(row.x).toBe(0);
  expect(row.width).toBe(page.viewportSize().width);
  expect(await items.first().locator(".file-art").boundingBox()).toEqual(artBefore);
  await expect(page).toHaveURL(/\/files\/$/);
  await expect(page.locator(".mobile-tabs")).toBeHidden();
  expect(await panel(page).evaluate(node => node.matches(":popover-open"))).toBe(true);
  await items.nth(4).tap();
  await expect(selected(page)).toHaveCount(2);
  await items.first().tap();
  await expect(selected(page)).toHaveCount(1);
  await actions(page).getByRole("button", { name: "全选", exact: true }).tap();
  await expect(selected(page)).toHaveCount(12);
  await expect(selected(page).last()).toHaveCSS("background-color", "rgb(239, 237, 252)");
  await page.screenshot({ path: testInfo.outputPath("touch-selection.png") });
  await actions(page).getByRole("button", { name: "取消全选", exact: true }).tap();
  await expect(selected(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(actions(page).getByRole("button", { name: "复制所选链接" })).toBeDisabled();
  await actions(page).getByRole("button", { name: "取消选择" }).tap();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".mobile-tabs")).toBeVisible();
  await expect(items.first()).toBeFocused();
});

test("touch actions batch favorites and copy shareable links without opening files", async ({ page }) => {
  test.skip(!touch(page), "Touch actions");
  const items = page.locator("#file-list .file-open");
  await hold(page, items.first());
  await items.nth(4).tap();
  await actions(page).getByRole("button", { name: "收藏所选项目", exact: true }).tap();
  await expect(actions(page).getByRole("button", { name: "取消收藏所选项目", exact: true })).toBeVisible();
  await actions(page).getByRole("button", { name: "复制所选链接" }).tap();
  expect(await page.evaluate(() => window.copiedSelection.at(-1).split("\n").length)).toBe(2);
  await actions(page).getByRole("button", { name: "取消收藏所选项目", exact: true }).tap();
  await expect(actions(page).getByRole("button", { name: "收藏所选项目", exact: true })).toBeVisible();
  await page.locator(".topbar").getByRole("button", { name: "搜索文件", exact: true }).tap();
  await page.getByRole("searchbox").fill("no-such-file");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".mobile-tabs")).toBeVisible();
});

test("touch scrolling cancels pending long press and ordinary taps still open folders", async ({ page }) => {
  test.skip(!touch(page), "Touch gestures");
  const item = page.locator("#file-list .file-open").first();
  const box = await item.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + 80, y: box.y + 30, id: 0 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + 35 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(550);
  await expect(panel(page)).toHaveCount(0);
  await item.tap();
  await expect(page).not.toHaveURL(/\/files\/$/);
  await expect(panel(page)).toHaveCount(0);
  await cdp.detach();
});

test("a legacy mobile MouseEvent click still opens after a touch pointer gesture", async ({ page }) => {
  test.skip(!touch(page), "Legacy mobile click compatibility");
  const item = page.getByRole("button", { name: "打开文件夹 照片", exact: true });
  await item.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 9, isPrimary: true, button: 0 });
  await item.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 9, isPrimary: true, button: 0 });
  await item.dispatchEvent("click", { detail: 1 });
  await expect(page).not.toHaveURL(/\/files\/$/);
  await expect(panel(page)).toHaveCount(0);
});

test("removing the last selected favorites keeps focus inside the surviving list", async ({ page }) => {
  await page.getByRole("button", { name: "收藏 项目笔记.md", exact: true }).click();
  await openFavorites(page);
  const scope = touch(page) ? page.locator("#favorites-dialog") : page.locator(".favorites-page");
  const item = scope.locator(".file-open").first();
  if (touch(page)) await hold(page, item);
  else await item.click();
  await actions(page).getByRole("button", { name: "取消收藏所选项目", exact: true }).click();
  await expect(scope.locator(".file-item")).toHaveCount(0);
  await expect(scope.getByRole("heading", { name: "暂无收藏", exact: true })).toBeVisible();
  await expect(scope.locator("#file-list")).toBeFocused();
  await expect(actions(page)).toHaveCount(0);
});

test("selection works inside mobile Favorites and Escape exits selection before the page dialog", async ({ page }) => {
  test.skip(!touch(page), "Native mobile page dialog");
  await page.getByRole("button", { name: "收藏 项目笔记.md", exact: true }).click();
  await openFavorites(page);
  const dialog = page.locator("#favorites-dialog");
  await hold(page, dialog.locator(".file-open").first());
  await expect(dialog).toBeVisible();
  await actions(page).getByRole("button", { name: "复制所选链接" }).tap();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("album selection uses the visible chronological media set inside the native dialog", async ({ page }) => {
  await page.goto("/album/");
  const scope = touch(page) ? page.locator("#album-page-dialog") : page;
  const items = scope.locator(".album-item .file-open");
  await expect(items.first()).toBeVisible();
  if (touch(page)) {
    await hold(page, items.first());
    await actions(page).getByRole("button", { name: "全选", exact: true }).tap();
  } else {
    await items.first().click();
    await items.first().press("Control+a");
    await expect(panel(page)).toHaveCount(0);
  }
  await expect(scope.locator(".album-item[data-selected='true']")).toHaveCount(await items.count());
  await actions(page).getByRole("button", { name: "复制所选链接" }).click();
  const links = await page.evaluate(() => window.copiedSelection.at(-1).split("\n"));
  expect(links).toHaveLength(await items.count());
  expect(links.every(link => new URL(link).pathname.startsWith("/files/") && new URL(link).searchParams.get("view") === "album")).toBe(true);
});

test("grid arrows use actual columns and sorting preserves the selected paths", async ({ page }) => {
  test.skip(touch(page), "Desktop grid keyboard");
  await chooseListingOption(page, "网格视图");
  const items = page.locator("#file-list .file-open");
  const rows = await items.evaluateAll(nodes => nodes.map(node => ({ path: node.dataset.path, top: node.getBoundingClientRect().top })));
  const nextRow = rows.findIndex(item => item.top > rows[0].top);
  expect(nextRow).toBeGreaterThan(1);
  await items.first().click();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(nextRow)).toBeFocused();
  await expect(items.nth(nextRow)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(selected(page)).toHaveCount(2);
  const paths = await selected(page).locator(".file-open").evaluateAll(nodes => nodes.map(node => node.dataset.path).sort());
  await chooseListingOption(page, "大小");
  expect(await selected(page).locator(".file-open").evaluateAll(nodes => nodes.map(node => node.dataset.path).sort())).toEqual(paths);
  await selected(page).locator(".file-open").first().focus();
  await page.keyboard.press("ControlOrMeta+c");
  expect(await page.evaluate(() => window.copiedSelection.at(-1).split("\n").length)).toBe(2);
});

test("a wide touch screen uses touch selection while its mouse keeps desktop behavior", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One hybrid input context");
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:8788", viewport: { width: 1440, height: 1000 }, hasTouch: true, locale: "zh-CN" });
  try {
    const page = await context.newPage();
    await page.goto("/files/");
    const items = page.locator("#file-list .file-open");
    await expect(items).toHaveCount(12);
    await hold(page, items.first());
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole("button", { name: "取消选择" }).tap();
    await items.first().click();
    await expect(selected(page)).toHaveCount(1);
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/files\/$/);
    await items.first().dblclick();
    await expect(page).not.toHaveURL(/\/files\/$/);
  } finally { await context.close(); }
});
