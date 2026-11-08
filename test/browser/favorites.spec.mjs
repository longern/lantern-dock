import { listingOptionsButton } from "../helpers/listing-options.mjs";
import { test as base, expect } from "@playwright/test";
import { closeFavorites, mainNavigation, openConnectionSettings, openFavorites } from "../helpers/navigation.mjs";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated: false } }));
    await use(page);
    expect(errors).toEqual([]);
  },
});

const favoriteKey = "lantern-dock:demo::/:favorites";
const favorite = {
  path: "/%E9%A1%B9%E7%9B%AE%E7%AC%94%E8%AE%B0.md", name: "项目笔记.md",
  kind: "text", isDirectory: false, size: 1248,
};
const favoritesDialog = (page) => page.getByRole("dialog", { name: "我的收藏", exact: true });

async function prepareFavorite(page) {
  await page.goto("/");
  await expect(page.locator(".file-card")).toHaveCount(12);
  await page.getByRole("button", { name: "收藏 项目笔记.md", exact: true }).click();
}

async function expectSingleListing(page) {
  await expect(page.locator("#file-list")).toHaveCount(1);
  await expect(page.locator("#item-count")).toHaveCount(1);
}

test("mobile favorites have a 60px header with a centered regular title and a 48px Back target", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Mobile favorites header");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/favorites");
  const dialog = favoritesDialog(page);
  const header = dialog.locator(".favorites-heading");
  const title = dialog.getByRole("heading", { name: "我的收藏", exact: true });
  const back = dialog.getByRole("button", { name: "返回我的", exact: true });
  await expect(header).toHaveCSS("height", "60px");
  await expect(back).toHaveCSS("width", "48px");
  await expect(back).toHaveCSS("height", "48px");
  await expect(back).toHaveCSS("margin-left", "-12px");
  const options = listingOptionsButton(header);
  await expect(options).toBeVisible();
  await expect(options).toHaveCSS("width", "48px");
  await expect(options).toHaveCSS("height", "48px");
  await expect(options).toHaveCSS("margin-right", "-12px");
  await expect(listingOptionsButton(dialog.locator(".file-toolbar"))).toHaveCount(0);
  await expect(title).toHaveCSS("font-size", "16px");
  await expect(title).toHaveCSS("font-weight", "400");
  await expect(title).toHaveCSS("text-align", "center");
  const bounds = await header.boundingBox();
  const titleBounds = await title.boundingBox();
  const backBounds = await back.boundingBox();
  const optionsBounds = await options.boundingBox();
  expect(optionsBounds.x + optionsBounds.width).toBeCloseTo(bounds.x + bounds.width - 4, 1);
  expect(Math.abs(titleBounds.x + titleBounds.width / 2 - bounds.x - bounds.width / 2)).toBeLessThan(1);
  expect(backBounds.x).toBeCloseTo(bounds.x + 4, 1);
  expect(backBounds.width).toBe(48);
  expect(backBounds.height).toBe(48);
  await back.focus();
  await expect(back).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#my-favorites")).toBeFocused();
});

test("desktop favorites keep the existing subpage heading styles", async ({ page }) => {
  test.skip(page.viewportSize().width <= 700, "Desktop favorites heading");
  await page.goto("/#/favorites");
  const pageHeading = page.locator(".favorites-page .favorites-heading");
  const title = pageHeading.getByRole("heading", { name: "我的收藏", exact: true });
  await expect(pageHeading).toHaveCSS("display", "flex");
  await expect(title).toHaveCSS("font-size", "22px");
  await expect(title).toHaveCSS("font-weight", "650");
  await expect(pageHeading.locator("#favorites-back")).toHaveCSS("width", "40px");
  await expect(pageHeading.locator("#favorites-back")).toHaveCSS("margin-left", "0px");
});

test("mobile favorites use a native modal with repeated dismissals and focus restoration", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Mobile favorites dialog");
  await prepareFavorite(page);
  for (const dismiss of ["button", "escape", "history"]) {
    const back = await openFavorites(page);
    const dialog = favoritesDialog(page);
    await expect(page).toHaveURL(/#\/favorites$/);
    await expect(dialog).toHaveJSProperty("tagName", "DIALOG");
    expect(await dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
    await expect(dialog.locator(".file-name")).toHaveText(favorite.name);
    await expectSingleListing(page);
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    await expect(page.locator(".mobile-tabs button").last()).toHaveAttribute("aria-current", "page");
    await back.focus();
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    if (dismiss === "button") await back.click();
    else if (dismiss === "escape") await page.keyboard.press("Escape");
    else await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/#\/me$/);
    await expect(page.locator("#my-favorites")).toBeFocused();
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  }
});

test("mobile favorites slide in from the right while fading and animate their exit", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Mobile favorites motion");
  await prepareFavorite(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const back = await openFavorites(page);
  const dialog = favoritesDialog(page);
  const sampleMotion = () => dialog.evaluate(async (node) => {
    const animation = node.getAnimations().find((item) => item.effect.getKeyframes()
      .some((frame) => frame.transform && frame.transform !== "none"));
    if (!animation) return null;
    animation.pause();
    animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
    await animation.ready;
    const style = getComputedStyle(node);
    return {
      offset: new DOMMatrixReadOnly(style.transform).m41,
      opacity: Number(style.opacity), width: node.clientWidth,
      backdrop: getComputedStyle(node, "::backdrop").animationName,
    };
  });
  const entering = await sampleMotion();
  expect(entering).not.toBeNull();
  expect(entering.offset).toBeGreaterThan(0);
  expect(entering.offset).toBeLessThan(entering.width);
  expect(entering.opacity).toBeGreaterThan(0);
  expect(entering.opacity).toBeLessThan(1);
  expect(entering.backdrop).not.toBe("none");
  await dialog.evaluate((node) => node.getAnimations().forEach((animation) => animation.finish()));
  await back.click();
  await expect(dialog).toHaveAttribute("data-state", "closed");
  await expect(dialog).toHaveAttribute("open", "");
  const exiting = await sampleMotion();
  expect(exiting.offset).toBeGreaterThan(0);
  expect(exiting.opacity).toBeGreaterThan(0);
  expect(exiting.opacity).toBeLessThan(1);
  await page.clock.runFor(400);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#my-favorites")).toBeFocused();
});

test("reduced motion skips favorites animations and leaves no modal or scroll lock", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Mobile favorites motion");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepareFavorite(page);
  for (let count = 0; count < 2; count++) {
    await openFavorites(page);
    const dialog = favoritesDialog(page);
    expect(await dialog.evaluate((node) => [
      getComputedStyle(node).animationName, getComputedStyle(node, "::backdrop").animationName,
    ])).toEqual(["none", "none"]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    await expect(page.locator("#my-favorites")).toBeFocused();
  }
});

test("Back then Forward during the favorites exit keeps the reopened sheet mounted", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Interrupted native dialog exit");
  await prepareFavorite(page);
  await openFavorites(page);
  const dialog = favoritesDialog(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.goBack();
  await expect(dialog).toHaveAttribute("data-state", "closed");
  await expect(dialog).toHaveAttribute("open", "");
  await page.goForward();
  await expect(dialog).toHaveAttribute("data-state", "open");
  await page.clock.runFor(500);
  await expect(page).toHaveURL(/#\/favorites$/);
  expect(await dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
  await expectSingleListing(page);
  await page.keyboard.press("Escape");
  await page.clock.runFor(400);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#my-favorites")).toBeFocused();
});

test("double-clicking favorites Back cannot navigate past My", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Repeated sheet dismissal");
  await prepareFavorite(page);
  await openFavorites(page);
  await favoritesDialog(page).getByRole("button", { name: "返回我的", exact: true }).dblclick();
  await expect(favoritesDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/me$/);
  await expect(page.locator("#my-favorites")).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(/#\/favorites$/);
  await expect(favoritesDialog(page)).toBeVisible();
});

test("Escape closes only the nested preview and removing the final favorite keeps a usable return target", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Nested favorites and preview modals");
  await prepareFavorite(page);
  await openFavorites(page);
  const dialog = favoritesDialog(page);
  const trigger = dialog.getByRole("button", { name: "预览 项目笔记.md", exact: true });
  await trigger.click();
  await expect(page.locator(".preview-content pre")).toContainText("欢迎使用 LanternDock");
  await page.keyboard.press("Escape");
  await expect(page.locator("#preview-dialog")).toHaveCount(0);
  await expect(dialog).toHaveAttribute("data-state", "open");
  await expect(page).toHaveURL(/#\/favorites$/);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("button", { name: "取消收藏文件", exact: true }).click();
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(page.locator("#preview-dialog")).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "暂无收藏", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "返回我的", exact: true })).toBeFocused();
  await expectSingleListing(page);
  await closeFavorites(page);
  await expect(page.locator("#my-favorites")).toBeFocused();
});

test("desktop favorites are a reloadable subpage with working Back, Forward and sidebar navigation", async ({ page }) => {
  test.skip(page.viewportSize().width <= 700, "Desktop favorites subpage");
  await prepareFavorite(page);
  await openFavorites(page);
  await expect(page.locator(".favorites-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "我的收藏", exact: true })).toBeVisible();
  await expect(page.locator("#favorites-dialog")).toHaveCount(0);
  await expect(page.locator(".file-name")).toHaveText(favorite.name);
  await expectSingleListing(page);
  await page.reload();
  await expect(page).toHaveURL(/#\/favorites$/);
  await expect(page.locator(".file-name")).toHaveText(favorite.name);
  await page.goBack();
  await expect(page.getByRole("searchbox")).toBeVisible();
  await expect(page.locator(".favorites-page")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator(".favorites-page")).toBeVisible();
  await expect(page.locator(".file-name")).toHaveText(favorite.name);
  await mainNavigation(page).getByRole("button", { name: /^文件/ }).click();
  await expect(page.locator(".file-card")).toHaveCount(12);
  await expect(page.locator(".favorites-page")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "文件路径", exact: true })).toBeVisible();
});

test("a direct favorites link waits for configuration, then loads only saved favorites", async ({ page }) => {
  await page.addInitScript(({ key, favorite }) => localStorage.setItem(key, JSON.stringify([favorite])), {
    key: favoriteKey, favorite,
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/config", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/#/favorites", { waitUntil: "domcontentloaded" });
    await expectSingleListing(page);
    await expect(page.locator("#file-list")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".file-card,.empty-state")).toHaveCount(0);
    if (page.viewportSize().width <= 700) await expect(favoritesDialog(page)).toBeVisible();
  } finally {
    release();
  }
  await expect(page.locator("#file-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".file-name")).toHaveText(favorite.name);
  await page.locator("#favorites-back").click();
  await expect(page).toHaveURL(page.viewportSize().width <= 700 ? /#\/me$/ : /#\/$/);
  await expect(page.locator("#favorites-dialog,.favorites-page")).toHaveCount(0);
});

for (const failure of ["denied", "corrupt"]) {
  test(`favorites ${failure} storage stays recoverable instead of masquerading as an empty collection`, async ({ page }) => {
    await page.addInitScript(({ key, favorite, failure }) => {
      localStorage.setItem(key, failure === "corrupt" ? "{corrupt" : JSON.stringify([favorite]));
      window.blockFavoritesReads = failure === "denied";
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (name) {
        if (window.blockFavoritesReads && name === key) throw new DOMException("Denied", "SecurityError");
        return getItem.call(this, name);
      };
    }, { key: favoriteKey, favorite, failure });
    await page.goto("/#/favorites");
    await expect(page.getByRole("heading", { name: "无法读取收藏", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "暂无收藏", exact: true })).toHaveCount(0);
    await expect(page.locator(".file-card")).toHaveCount(0);
    await expectSingleListing(page);
    await page.evaluate(({ key, favorite }) => {
      window.blockFavoritesReads = false;
      localStorage.setItem(key, JSON.stringify([favorite]));
    }, { key: favoriteKey, favorite });
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.locator(".file-name")).toHaveText(favorite.name);
    await expect(page.getByRole("heading", { name: "无法读取收藏", exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/#\/favorites$/);
  });
}

test("favorites remain one destination when resizing with a nested preview", async ({ page }) => {
  await prepareFavorite(page);
  await openFavorites(page);
  for (const width of [1440, 700, 701, 320]) {
    await page.getByRole("button", { name: "预览 项目笔记.md", exact: true }).click();
    await expect(page.locator("#preview-dialog")).toBeVisible();
    // Cross the actual breakpoint on every pass, regardless of project start.
    const target = page.viewportSize().width <= 700 ? Math.max(width, 701) : Math.min(width, 700);
    await page.setViewportSize({ width: target, height: 844 });
    await expect(page.locator("#preview-dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/#\/favorites$/);
    await expectSingleListing(page);
    if (target <= 700) {
      expect(await favoritesDialog(page).evaluate((node) => node.matches(":modal"))).toBe(true);
      await expect(page.locator(".favorites-page")).toHaveCount(0);
    } else {
      await expect(page.locator("#favorites-dialog")).toHaveCount(0);
      await expect(page.locator(".favorites-page")).toBeVisible();
      await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    }
  }
});

test("desktop favorites settings cannot be covered by a new parent sheet after resizing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareFavorite(page);
  await openFavorites(page);
  await openConnectionSettings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog", { name: "连接设置", exact: true })).toHaveCount(0);
  const dialog = favoritesDialog(page);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
  await expectSingleListing(page);
  await closeFavorites(page);
  await expect(page.locator("#my-favorites")).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("settings recovery inside favorites returns focus to the surviving favorites surface", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Settings nested in mobile favorites");
  let failed = true;
  await page.route("**/api/config", (route) => failed
    ? route.fulfill({ status: 503, json: { error: "Configuration temporarily unavailable" } })
    : route.continue());
  await page.goto("/#/favorites");
  const dialog = favoritesDialog(page);
  await expect(dialog.getByRole("heading", { name: "无法读取文件", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "连接设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "连接设置", exact: true });
  await expect(settings).toBeVisible();
  failed = false;
  await settings.getByRole("button", { name: "连接", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "暂无收藏", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "返回我的", exact: true })).toBeFocused();
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#my-favorites")).toBeFocused();
});
