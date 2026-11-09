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

test("mobile drawer fades its backdrop both ways, contains focus and restores it after exit", async ({
  page,
}) => {
  test.skip(page.viewportSize().width > 700, "Temporary drawer is mobile only");
  const trigger = page.getByRole("button", { name: "打开导航", exact: true });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "主导航", exact: true });
  await expect(drawer).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const entering = await drawer.evaluate(async (node) => {
    getComputedStyle(node, "::backdrop").animationName;
    const animations = node.getAnimations({ subtree: true });
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 110;
    }
    await Promise.all(animations.map((animation) => animation.ready));
    const style = getComputedStyle(node, "::backdrop");
    return {
      name: style.animationName,
      opacity: Number(style.opacity),
      modal: node.matches(":modal"),
    };
  });
  expect(entering.name).toBe("backdrop-in");
  expect(entering.opacity).toBeGreaterThan(0);
  expect(entering.opacity).toBeLessThan(1);
  expect(entering.modal).toBe(true);
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await drawer.evaluate((node) =>
    node.getAnimations().forEach((animation) => animation.finish()),
  );
  await drawer.getByRole("button", { name: "连接设置", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(
    await drawer.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press("/");
  expect(
    await drawer.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  // Native backdrop clicks are retargeted to the dialog, outside its bounds.
  await page.mouse.click(page.viewportSize().width - 8, 200);
  await expect(drawer).toHaveAttribute("data-state", "closed");
  await expect(drawer).toHaveAttribute("open", "");
  const leaving = await drawer.evaluate(async (node) => {
    getComputedStyle(node, "::backdrop").animationName;
    const animations = node.getAnimations({ subtree: true });
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 90;
    }
    await Promise.all(animations.map((animation) => animation.ready));
    const style = getComputedStyle(node, "::backdrop");
    return { name: style.animationName, opacity: Number(style.opacity) };
  });
  expect(leaving.name).toBe("backdrop-out");
  expect(leaving.opacity).toBeGreaterThan(0);
  expect(leaving.opacity).toBeLessThan(1);
  await page.clock.runFor(220);
  await expect(page.locator("#sidebar")).not.toHaveAttribute("open");
  await expect(trigger).toBeFocused();
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

test("drawer can hand over to settings and switching to desktop releases the modal", async ({
  page,
}) => {
  test.skip(page.viewportSize().width > 700, "Temporary drawer is mobile only");
  await page.getByRole("button", { name: "打开导航" }).click();
  await page
    .locator("#sidebar")
    .getByRole("button", { name: "连接设置", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "连接设置", exact: true });
  await expect(page.locator("#sidebar")).not.toHaveAttribute("open");
  await expect(settings).toBeVisible();
  expect(
    await settings.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开导航", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await expect(
    page.getByRole("navigation", { name: "资源导航", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "打开导航" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.locator("#sidebar")).not.toHaveAttribute("open");
});

test("settings on Files restore visible navigation focus after crossing the drawer breakpoint", async ({ page }) => {
  await mainNavigation(page).getByRole("button", { name: /^文件/ }).click();
  for (const [from, to] of [[700, 701], [701, 700]]) {
    await page.setViewportSize({ width: from, height: 900 });
    await openConnectionSettings(page);
    await page.setViewportSize({ width: to, height: 900 });
    const settings = page.getByRole("dialog", { name: "连接设置", exact: true });
    await expect(settings).toBeVisible();
    await expect(page.getByRole("searchbox", { includeHidden: true })).toHaveCount(0);
    await expect(page.locator(".topbar").getByRole("button", {
      name: "连接设置", exact: true, includeHidden: true,
    })).toHaveCount(0);
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(connectionSettingsReturnTarget(page)).toBeVisible();
    await expect(connectionSettingsReturnTarget(page)).toBeFocused();
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    await expect(mainNavigation(page).getByRole("button", { name: /^文件/ }))
      .toHaveAttribute("aria-current", "page");
    if (to <= 700) {
      await expect(page.locator("#sidebar")).not.toHaveAttribute("open");
      await expect(connectionSettingsReturnTarget(page)).toHaveAttribute("aria-expanded", "false");
    }
  }
});

for (const [from, to] of [[700, 701], [701, 700]]) {
  test(`settings return focus when resizing from ${from}px to ${to}px during the exit animation`, async ({ page }) => {
    await mainNavigation(page).getByRole("button", { name: /^文件/ }).click();
    await page.setViewportSize({ width: from, height: 900 });
    await openConnectionSettings(page);
    // Freeze only after the mobile drawer has finished handing over to settings.
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const settings = page.getByRole("dialog", { name: "连接设置", exact: true });
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(settings).toHaveAttribute("data-state", "closed");
    await expect(settings).toHaveAttribute("open", "");
    await page.setViewportSize({ width: to, height: 900 });
    await page.clock.runFor(16);
    await expect(page.locator("#sidebar")).toHaveJSProperty("tagName", to <= 700 ? "DIALOG" : "ASIDE");
    await expect(settings).toHaveAttribute("open", "");
    await page.clock.runFor(220);
    await expect(settings).toHaveCount(0);
    await expect(connectionSettingsReturnTarget(page)).toBeFocused();
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    await expect(page.getByRole("searchbox", { includeHidden: true })).toHaveCount(0);
    await expect(mainNavigation(page).getByRole("button", { name: /^文件/ }))
      .toHaveAttribute("aria-current", "page");
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
  if (page.viewportSize().width <= 700) {
    await page.getByRole("button", { name: "打开导航" }).click();
    const drawer = page.getByRole("dialog", { name: "主导航" });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveCSS("transform", "none");
    await page.keyboard.press("Escape");
    await expect(page.locator("#sidebar")).not.toHaveAttribute("open");
  }
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
  if (page.viewportSize().width <= 700)
    await page.getByRole("button", { name: "打开导航" }).click();
  await page
    .getByRole("navigation", { name: "文件类型", exact: true })
    .getByRole("button", { name: "视频", exact: true })
    .click();
  await expect(page.locator(".empty-state")).toContainText(
    "当前文件夹没有此类文件",
  );
  await page.getByRole("button", { name: "查看全部文件" }).click();
  await expect(page.locator(".file-item")).toHaveCount(12);
});
