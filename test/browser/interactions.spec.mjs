import { test, expect } from "@playwright/test";
import {
  connectionSettingsReturnTarget,
  mainNavigation,
  openConnectionSettings,
} from "../helpers/navigation.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-item")).toHaveCount(12);
});

test("mobile primary navigation uses Home, Files and My without a drawer", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Mobile navigation");
  await expect(page.locator("#sidebar,#navigation-toggle")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "文件分类", exact: true }).getByRole("button")).toHaveCount(5);
  await mainNavigation(page).getByRole("button", { name: /^文件/ }).click();
  await expect(page).toHaveURL(/\/files\/$/);
  await mainNavigation(page).getByRole("button", { name: "我的", exact: true }).click();
  await expect(page.locator("#my-favorites,#my-settings")).toHaveCount(2);
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("dialog backdrop, Escape and close control share an exit and restore focus", async ({
  page,
}) => {
  for (const dismiss of ["backdrop", "escape", "button"]) {
    const trigger = await openConnectionSettings(page);
    const dialog = page.getByRole("dialog", { name: "连接设置", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("访问方式", { exact: true }).selectOption("basic");
    await dialog.getByLabel("用户名", { exact: true }).fill("unsaved-user");
    if (dismiss === "backdrop") await page.mouse.click(4, 4);
    else if (dismiss === "escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: "关闭设置" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  }
  await openConnectionSettings(page);
  await expect(page.getByLabel("访问方式", { exact: true })).toHaveValue(
    "none",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "连接设置", exact: true })).toHaveCount(0);
  await expect(connectionSettingsReturnTarget(page)).toBeFocused();
});

test("settings restore visible focus when switching between mobile My and the desktop sidebar", async ({ page }) => {
  await mainNavigation(page).getByRole("button", { name: /^文件/ }).click();
  for (const [from, to] of [[700, 701], [701, 700]]) {
    await page.setViewportSize({ width: from, height: 900 });
    await openConnectionSettings(page);
    await page.setViewportSize({ width: to, height: 900 });
    const settings = page.getByRole("dialog", { name: "连接设置", exact: true });
    if (from <= 700) await expect(settings).toHaveCount(0);
    else {
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    }
    await expect(page.locator(".topbar").getByRole("button", {
      name: "连接设置", exact: true, includeHidden: true,
    })).toHaveCount(0);
    await expect(settings).toHaveCount(0);
    await expect(connectionSettingsReturnTarget(page)).toBeVisible();
    await expect(connectionSettingsReturnTarget(page)).toBeFocused();
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    if (to <= 700) await expect(page.locator("#sidebar")).toHaveCount(0);
  }
});

for (const [from, to] of [[700, 701], [701, 700]]) {
  test(`settings return focus when resizing from ${from}px to ${to}px during the exit animation`, async ({ page }) => {
    await mainNavigation(page).getByRole("button", { name: /^文件/ }).click();
    await page.setViewportSize({ width: from, height: 900 });
    await openConnectionSettings(page);
    // Freeze after the actual settings entry has opened its modal.
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const settings = page.getByRole("dialog", { name: "连接设置", exact: true });
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(settings).toHaveAttribute("data-state", "closed");
    await expect(settings).toHaveAttribute("open", "");
    await page.setViewportSize({ width: to, height: 900 });
    await page.clock.runFor(16);
    if (to <= 700) await expect(page.locator("#sidebar")).toHaveCount(0);
    else await expect(page.locator("#sidebar")).toHaveJSProperty("tagName", "ASIDE");
    await expect(settings).toHaveAttribute("open", "");
    await page.clock.runFor(220);
    await expect(settings).toHaveCount(0);
    await expect(connectionSettingsReturnTarget(page)).toBeFocused();
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");

  });
}

test("reduced motion disables surface and backdrop animation without leaving a modal behind", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const trigger = await openConnectionSettings(page);
  const settings = page.getByRole("dialog", { name: "连接设置", exact: true });
  expect(
    await settings.evaluate((node) => [
      getComputedStyle(node).animationName,
      getComputedStyle(node, "::backdrop").animationName,
    ]),
  ).toEqual(["none", "none"]);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("search and type empty states offer recovery without losing keyboard access", async ({
  page,
}) => {
  await page.getByRole("searchbox").fill("unmatched query");
  await expect(page.locator(".list-head")).toBeHidden();
  await page
    .locator(".empty-state")
    .getByRole("button", { name: "清除搜索" })
    .click();
  await expect(page.locator(".file-item")).toHaveCount(12);
  await page.getByRole("searchbox").fill("山间");
  await page
    .locator(".search-box")
    .getByRole("button", { name: "清除搜索" })
    .click();
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.getByRole("navigation", { name: "文件分类", exact: true })
    .getByRole("button", { name: "视频", exact: true }).click();
  await expect(page.locator(".empty-state")).toContainText(
    "当前文件夹没有此类文件",
  );
  await page.getByRole("button", { name: "查看全部文件" }).click();
  await expect(page.locator(".file-item")).toHaveCount(12);
});
