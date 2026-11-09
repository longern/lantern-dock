import { openItem } from "../helpers/open-item.mjs";
import { test, expect } from "@playwright/test";
import { mainNavigation, openConnectionSettings, openFavorites } from "../helpers/navigation.mjs";
import { listingOptionsButton } from "../helpers/listing-options.mjs";

const popup = (page) => page.locator(".listing-options-menu");
const surface = (page) => page.locator(".listing-options-surface");
const activate = (locator) => locator.evaluate((node) => node.click());

async function holdMenuMotion(page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.addStyleTag({ content: ".listing-options-surface { animation-play-state: paused !important; }" });
}

async function sampleMotion(locator, fraction) {
  return locator.evaluate((node, fraction) => {
    getComputedStyle(node).animationName;
    const animations = node.getAnimations();
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = Number(animation.effect.getComputedTiming().duration) * fraction;
    }
    const style = getComputedStyle(node);
    return {
      count: animations.length,
      opacity: Number(style.opacity),
      scale: new DOMMatrixReadOnly(style.transform).a,
    };
  }, fraction);
}

async function finishMenuMotion(page) {
  await surface(page).evaluate((node) => node.getAnimations().forEach((animation) => animation.finish()));
  await page.clock.runFor(500);
}

async function expectBorderless(locator) {
  for (const side of ["top", "right", "bottom", "left"])
    await expect(locator).toHaveCSS(`border-${side}-width`, "0px");
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated: false } }));
  await page.goto("/");
  await expect(page.locator(".file-item")).toHaveCount(12);
});

test("listing menu grows and fades from its anchor and remains mounted through a noninteractive exit", async ({ page }) => {
  await holdMenuMotion(page);
  const trigger = listingOptionsButton(page);
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(popup(page)).toHaveAttribute("data-state", "open");
  const start = await sampleMotion(surface(page), 0);
  expect(start.count).toBeGreaterThan(0);
  expect(start.opacity).toBeLessThan(1);
  expect(start.scale).toBeLessThan(1);
  const middle = await sampleMotion(surface(page), 0.5);
  expect(middle.opacity).toBeGreaterThan(start.opacity);
  expect(middle.opacity).toBeLessThan(1);
  expect(middle.scale).toBeGreaterThan(start.scale);
  expect(middle.scale).toBeLessThan(1);
  await finishMenuMotion(page);
  await expectBorderless(popup(page));
  await expectBorderless(surface(page));
  const first = popup(page).getByRole("menuitemradio").first();
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("outline-width", "2px");
  await expect(surface(page).locator('[role="group"]').last()).toHaveCSS("border-top-width", "1px");
  const placement = await surface(page).evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const trigger = node.closest(".listing-options").querySelector(".listing-options-trigger").getBoundingClientRect();
    return { width: bounds.width, x: bounds.x, anchorX: trigger.x + trigger.width / 2,
      origin: getComputedStyle(node).transformOrigin.split(" ").map(parseFloat) };
  });
  expect(placement.origin[0]).toBeCloseTo(Math.max(0, Math.min(placement.width, placement.anchorX - placement.x)), 1);
  expect(placement.origin[1]).toBeCloseTo(0, 1);
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await expect(popup(page)).toHaveAttribute("data-state", "closed");
  await expect(popup(page)).toHaveJSProperty("inert", true);
  await expect(popup(page)).toHaveAttribute("aria-hidden", "true");
  expect(await popup(page).evaluate((node) => typeof node.showPopover !== "function" || node.matches(":popover-open"))).toBe(true);
  const leaving = await sampleMotion(surface(page), 0.5);
  expect(leaving.count).toBeGreaterThan(0);
  expect(leaving.opacity).toBeGreaterThan(0);
  expect(leaving.opacity).toBeLessThan(1);
  expect(leaving.scale).toBeLessThan(1);
  await finishMenuMotion(page);
  await expect(popup(page)).toHaveCount(0);
});

test("reopening during exit cancels stale completion and preserves keyboard focus", async ({ page }) => {
  await holdMenuMotion(page);
  const trigger = listingOptionsButton(page);
  await activate(trigger);
  await expect(popup(page)).toHaveAttribute("data-state", "open");
  await sampleMotion(surface(page), 0.5);
  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveAttribute("data-state", "closed");
  await sampleMotion(surface(page), 0.5);
  await activate(trigger);
  await expect(popup(page)).toHaveAttribute("data-state", "open");
  await expect(popup(page)).toHaveJSProperty("inert", false);
  await finishMenuMotion(page);
  await page.clock.runFor(1000);
  await expect(popup(page)).toHaveCount(1);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(popup(page).getByRole("menuitemradio").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await finishMenuMotion(page);
  await expect(popup(page)).toHaveCount(0);
});

test("a flipped and viewport-clamped menu uses the matching bottom anchor origin", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({ content: ".listing-options-trigger { position: fixed !important; left: 0 !important; top: calc(100dvh - 48px) !important; }" });
  await activate(listingOptionsButton(page));
  await expect(popup(page)).toHaveAttribute("data-state", "open");
  const position = await surface(page).evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const anchor = node.closest(".listing-options").querySelector(".listing-options-trigger").getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, anchorTop: anchor.top,
      anchorX: anchor.x + anchor.width / 2, origin: getComputedStyle(node).transformOrigin.split(" ").map(parseFloat) };
  });
  expect(position.x).toBeGreaterThanOrEqual(8);
  expect(position.y + position.height).toBeLessThanOrEqual(position.anchorTop);
  expect(position.origin[0]).toBeCloseTo(Math.max(0, Math.min(position.width, position.anchorX - position.x)), 1);
  expect(position.origin[1]).toBeCloseTo(position.height, 1);
});

test("reduced motion closes immediately and can replace an animation already in progress", async ({ page }) => {
  await holdMenuMotion(page);
  await activate(listingOptionsButton(page));
  await expect(popup(page)).toHaveAttribute("data-state", "open");
  expect((await sampleMotion(surface(page), 0.4)).count).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(surface(page)).toHaveCSS("animation-name", "none");
  await expect(surface(page)).toHaveCSS("transform", "none");
  await expect(surface(page)).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await page.clock.runFor(1);
  await expect(popup(page)).toHaveCount(0);
  for (let pass = 0; pass < 2; pass++) {
    await activate(listingOptionsButton(page));
    await expect(surface(page)).toHaveCSS("animation-name", "none");
    await page.keyboard.press("Escape");
    await page.clock.runFor(1);
    await expect(popup(page)).toHaveCount(0);
  }
});

test("closing Favorites removes its animated top-layer menu without a leaked popup", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Native Favorites dialog is mobile only");
  await openFavorites(page);
  await holdMenuMotion(page);
  await activate(listingOptionsButton(page));
  await expect(popup(page)).toHaveAttribute("data-state", "open");
  await activate(page.locator("#favorites-back"));
  await page.clock.runFor(500);
  await expect(page.locator("#favorites-dialog")).toHaveCount(0);
  await expect(popup(page)).toHaveCount(0);
  await expect(page.locator("#my-favorites")).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("settings and preview dialogs have no outer borders while controls and dividers remain", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openConnectionSettings(page);
  const settings = page.getByRole("dialog", { name: "连接设置", exact: true });
  await expectBorderless(settings);
  await expect(settings.locator(".dialog-actions")).toHaveCSS("border-top-width", "1px");
  await expect(settings.locator("select").first()).toHaveCSS("border-top-width", "1px");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await mainNavigation(page).getByRole("button", { name: /^文件/ }).click();
  await openItem(page.getByRole("button", { name: "预览 项目笔记.md", exact: true }));
  await expectBorderless(page.locator("#preview-dialog"));
  await expect(page.locator(".preview-header")).toHaveCSS("border-bottom-width", "1px");
});

test("mobile My, login, action menu and Favorites keep borderless outer surfaces", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "These surfaces are mobile only");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#sidebar,#navigation-toggle")).toHaveCount(0);
  await mainNavigation(page).getByRole("button", { name: "我的", exact: true }).click();
  await expectBorderless(page.locator(".my-action-list"));
  await page.getByRole("button", { name: "游客", exact: true }).click();
  await expectBorderless(page.locator("#sign-in-dialog"));
  await page.keyboard.press("Escape");
  await expect(page.locator("#sign-in-dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "我的收藏", exact: true }).click();
  await expectBorderless(page.locator("#favorites-dialog"));
  await expect(page.locator(".favorites-heading")).toHaveCSS("border-bottom-width", "1px");
});
