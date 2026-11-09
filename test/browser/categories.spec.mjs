import { chooseListingOption, expectListingOptions, listingOptionsButton } from "../helpers/listing-options.mjs";
import { test, expect } from "@playwright/test";

const cards = (page) => page.getByRole("navigation", { name: "文件分类", exact: true });
const mainNav = (page) => page.getByRole("navigation", {
  name: page.viewportSize().width <= 700 ? "移动端资源导航" : "资源导航",
  exact: true,
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-card")).toHaveCount(12);
});

test("home cards show an icon-only album above its label and match the light gray canvas", async ({ page }, testInfo) => {
  await expect(cards(page).getByRole("button")).toHaveText(["相册", "视频", "文档", "图书", "音频"]);
  await expect(cards(page).locator("img,video,canvas")).toHaveCount(0);
  await expect(page.locator(".main-area")).toHaveCSS("background-color", "rgb(245, 245, 245)");
  await expect(page.locator(".browser-header")).toHaveCSS("background-color", "rgb(245, 245, 245)");
  for (const card of await cards(page).getByRole("button").all())
    await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");
  const album = cards(page).getByRole("button", { name: "相册", exact: true });
  const iconBox = await album.locator("svg").boundingBox();
  const textBox = await album.locator("span").boundingBox();
  expect(iconBox.y + iconBox.height).toBeLessThan(textBox.y);
  expect(Math.abs(iconBox.x + iconBox.width / 2 - textBox.x - textBox.width / 2)).toBeLessThan(1);
  await expect.poll(() => page.evaluate(() => [document.documentElement, ...document.querySelectorAll(".category-cards,.category-card")]
    .filter((node) => node.scrollWidth > node.clientWidth + 1)
    .map((node) => node.className))).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("home-categories.png"), fullPage: false });
});

test("category shortcuts open the file view and clear search", async ({ page }) => {
  for (const [label, count] of [["相册", 3], ["文档", 4], ["视频", 0], ["图书", 0], ["音频", 0]]) {
    await mainNav(page).getByRole("button", { name: "首页", exact: true }).click();
    await page.getByRole("searchbox").fill("no-matching-file");
    await cards(page).getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByRole("searchbox", { includeHidden: true })).toHaveCount(0);
    await expect(page.locator(".topbar").getByRole("button", {
      name: "连接设置", exact: true, includeHidden: true,
    })).toHaveCount(0);
    await expect(cards(page)).toHaveCount(0);
    await expect(mainNav(page).getByRole("button", { name: /^文件/ })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".filter-chip")).toContainText(label);
    await expect(page.locator(".file-card")).toHaveCount(count);
    if (!count) {
      await expect(page.locator(".empty-state")).toContainText("当前文件夹没有此类文件");
      await page.getByRole("button", { name: "查看全部文件" }).click();
    } else {
      await page.getByRole("button", { name: "清除类型筛选" }).click();
    }
    await expect(page.locator(".file-card")).toHaveCount(12);
    await expect(page.getByRole("searchbox", { includeHidden: true })).toHaveCount(0);
    await mainNav(page).getByRole("button", { name: "首页", exact: true }).click();
    await expect(page.getByRole("searchbox")).toHaveValue("");
    await expect(page.locator(".file-card")).toHaveCount(12);
  }
});

test("home shortcuts support keyboard activation and return to recent files", async ({ page }) => {
  await cards(page).getByRole("button", { name: "相册", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".file-card")).toHaveCount(3);
  await page.getByRole("button", { name: "预览 海边的周末.svg", exact: true }).click();
  await expect(page.locator(".album-media[data-current=true] img").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#album-viewer")).toHaveCount(0);
  await mainNav(page).getByRole("button", { name: "首页", exact: true }).click();
  await expect(cards(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近文件", exact: true })).toBeVisible();
  await expect(page.locator(".file-card")).toHaveCount(1);
  await mainNav(page).getByRole("button", { name: /^文件/ }).click();
  await expect(cards(page)).toHaveCount(0);
  await page.getByRole("button", { name: "打开文件夹 照片", exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  await mainNav(page).getByRole("button", { name: "首页", exact: true }).click();
  await expect(cards(page)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "文件路径" })).toHaveCount(0);
});

test("album is a compact square preview-only grid with accessible file opening", async ({ page }, testInfo) => {
  await cards(page).getByRole("button", { name: "相册", exact: true }).click();
  const gallery = page.getByLabel("相册", { exact: true });
  await expect(gallery).toHaveClass(/album-timeline/);
  await expect(gallery).not.toHaveClass(/list-layout/);
  await expect(page.getByRole("group", { name: "显示方式" })).toHaveCount(0);
  await expect(page.locator(".list-head")).toBeHidden();
  await expect(gallery.locator(".file-info,.row-size,.row-modified,.extension,.favorite-button,svg")).toHaveCount(0);
  await expect(gallery.locator(".album-item")).toHaveText(["", "", ""]);
  await expect(gallery.locator(".album-item")).toHaveCount(3);
  await expect(gallery.locator(".album-layout")).toHaveCSS("gap", "4px");
  await expect(page.getByRole("heading", { name: "照片", exact: true })).toBeVisible();
  await expect(page.locator(".album-heading p")).toHaveCount(0);
  await expect(listingOptionsButton(page)).toHaveCount(0);
  for (const item of await gallery.locator(".album-item").all()) {
    await expect(item).toHaveCSS("border-width", "0px");
    await expect(item).toHaveCSS("border-radius", "0px");
    const button = item.getByRole("button");
    const box = await button.boundingBox();
    expect(Math.abs(box.width - box.height)).toBeLessThan(1);
    await expect(button).toHaveCSS("padding", "0px");
    await expect(item.locator("img")).toHaveCSS("object-fit", "cover");
    await expect.poll(() => item.locator("img").evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  }
  expect(await gallery.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("album-grid.png"), fullPage: false });
  const photo = gallery.getByRole("button", { name: "预览 海边的周末.svg", exact: true });
  await photo.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".album-media[data-current=true] img").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#album-viewer")).toHaveCount(0);
  await expect(photo).toBeFocused();
  await expect(gallery).toHaveClass(/album-timeline/);
  await expect(page.getByRole("searchbox", { includeHidden: true })).toHaveCount(0);
  await page.keyboard.press("/");
  await expect(photo).toBeFocused();
  await expect(gallery.locator(".album-item")).toHaveCount(3);
});

test("leaving and reentering album preserves the normal file view preference", async ({ page }) => {
  for (const view of ["列表视图", "网格视图"]) {
    await mainNav(page).getByRole("button", { name: /^文件/ }).click();
    await chooseListingOption(page, view);
    await chooseListingOption(page, "大小");
    await mainNav(page).getByRole("button", { name: "首页", exact: true }).click();
    await cards(page).getByRole("button", { name: "相册", exact: true }).click();
    await expect(page.locator("#file-list")).toHaveClass(/album-timeline/);
    await page.getByRole("button", { name: "清除类型筛选" }).click();
    await expect(page.locator("#file-list")).not.toHaveClass(/album-timeline/);
    await expect(page.locator(".file-name")).toHaveCount(12);
    await expectListingOptions(page, [view, "大小"]);
  }
});
