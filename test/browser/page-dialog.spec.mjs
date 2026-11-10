import { isCompact } from "../helpers/responsive.mjs";
import { openItem } from "../helpers/open-item.mjs";
import { test, expect } from "@playwright/test";

const albumDialog = (page) => page.locator("#album-page-dialog");
const openAlbum = async (page) => {
  await page
    .getByRole("navigation", { name: "文件分类", exact: true })
    .getByRole("button", { name: "相册", exact: true })
    .click();
  await expect(page).toHaveURL(/\/album\/$/);
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.goto("/");
  await expect(page.locator(".file-item")).toHaveCount(12);
});

test("desktop album keeps the existing page while mobile uses the shared full-screen app bar", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openAlbum(page);
  if (!isCompact(page)) {
    await expect(albumDialog(page)).toHaveCount(0);
    await expect(page.locator(".album-heading h1")).toHaveText("照片");
    await expect(page.locator(".album-heading h1")).toHaveCSS(
      "font-size",
      "36px",
    );
    await expect(page.locator(".album-heading h1")).toHaveCSS(
      "font-weight",
      "500",
    );
  } else {
    const dialog = albumDialog(page);
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
    const header = dialog.locator(":scope > .page-dialog-header");
    await expect(header).toHaveCSS("height", "60px");
    await expect(header.locator("h1")).toHaveText("相册");
    await expect(header.locator("h1")).toHaveCSS("font-weight", "400");
    const geometry = await header.evaluate((node) => {
      const title = node.querySelector("h1").getBoundingClientRect();
      return Math.abs(title.x + title.width / 2 - innerWidth / 2);
    });
    expect(geometry).toBeLessThan(1);
    for (const button of await header.getByRole("button").all()) {
      await expect(button).toHaveCSS("width", "48px");
      await expect(button).toHaveCSS("height", "48px");
      await expect(button.locator("svg")).toHaveCSS("width", "24px");
    }
    await expect(dialog.locator(".album-heading,.filter-chip")).toHaveCount(0);
    await expect(page.locator("#file-list")).toHaveCount(1);
    await page
      .locator(".mobile-tabs button")
      .first()
      .evaluate((node) => node.focus());
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
    const last = dialog.locator(".album-preview").last();
    await last.focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#album-back")).toBeFocused();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("album-page.png") });
});

test("mobile Back dismisses a photo before the album, and forward reopens the album", async ({
  page,
}) => {
  test.skip(!isCompact(page), "Mobile nested page dialogs");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openAlbum(page);
  const photo = albumDialog(page).locator(".album-preview").first();
  await openItem(photo);
  await expect(page.locator("#album-viewer")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#album-viewer")).toHaveCount(0);
  await expect(albumDialog(page)).toBeVisible();
  await expect(photo).toBeFocused();
  await page.goBack();
  await expect(albumDialog(page)).toHaveCount(0);
  await expect(page.locator(".category-album")).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await page.goForward();
  await expect(albumDialog(page)).toBeVisible();
  await page.locator("#album-back").click();
  await expect(albumDialog(page)).toHaveCount(0);
  await expect(page.locator(".category-album")).toBeFocused();
});

test("a direct mobile album link closes locally and breakpoint changes release the modal", async ({
  page,
}) => {
  test.skip(!isCompact(page), "Mobile page route and breakpoint transitions");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/album/");
  const dialog = albumDialog(page);
  const back = page.locator("#album-back");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".album-item")).toHaveCount(3);
  const header = dialog.locator(":scope > .page-dialog-header");
  await expect(header).toBeFocused();
  await expect(header).toHaveCSS("outline-style", "none");
  await expect(back).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.keyboard.press("Tab");
  await expect(back).toBeFocused();
  await expect(back).toHaveCSS("background-color", "rgba(81, 77, 187, 0.14)");
  await back.click();
  await expect(albumDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await openAlbum(page);
  await openItem(albumDialog(page).locator(".album-preview").first());
  await expect(page.locator("#album-viewer")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator("#album-page-dialog,#album-viewer")).toHaveCount(0);
  await expect(page.locator(".album-heading h1")).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(albumDialog(page)).toBeVisible();
  await expect(page.locator("#file-list")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(albumDialog(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("mobile page and backdrop stay mounted through both slide directions", async ({
  page,
}) => {
  test.skip(!isCompact(page), "Mobile page motion");
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await openAlbum(page);
  const dialog = albumDialog(page);
  await expect(dialog).toBeVisible();
  const entering = await dialog.evaluate(async (node) => {
    const animations = node.getAnimations({ subtree: true });
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 100;
    }
    await Promise.all(animations.map((animation) => animation.ready));
    return {
      animation: getComputedStyle(node).animationName,
      x: new DOMMatrixReadOnly(getComputedStyle(node).transform).m41,
      opacity: Number(getComputedStyle(node, "::backdrop").opacity),
    };
  });
  expect(entering.animation).toBe("page-dialog-in");
  expect(entering.x).toBeGreaterThan(0);
  expect(entering.x).toBeLessThan(page.viewportSize().width);
  expect(entering.opacity).toBeGreaterThan(0);
  expect(entering.opacity).toBeLessThan(1);
  await dialog.evaluate((node) =>
    node.getAnimations().forEach((animation) => animation.finish()),
  );
  await page.clock.runFor(250);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveAttribute("data-state", "closed");
  await expect(dialog).toHaveAttribute("open", "");
  const leaving = await dialog.evaluate(async (node) => {
    const animations = node.getAnimations({ subtree: true });
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 90;
    }
    await Promise.all(animations.map((animation) => animation.ready));
    return {
      animation: getComputedStyle(node).animationName,
      opacity: Number(getComputedStyle(node, "::backdrop").opacity),
    };
  });
  expect(leaving.animation).toBe("page-dialog-out");
  expect(leaving.opacity).toBeGreaterThan(0);
  expect(leaving.opacity).toBeLessThan(1);
  await page.clock.runFor(250);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".category-album")).toBeFocused();
});
