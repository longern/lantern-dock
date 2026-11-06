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

test("categories filter, toggle, clear search and recover from empty results", async ({ page }) => {
  const album = cards(page).getByRole("button", { name: "相册", exact: true });
  await page.getByRole("searchbox").fill("no-matching-file");
  await album.click();
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect(album).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".file-card")).toHaveCount(3);
  await album.click();
  await expect(album).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".file-card")).toHaveCount(12);
  await cards(page).getByRole("button", { name: "文档", exact: true }).click();
  await expect(page.locator(".file-card")).toHaveCount(4);
  await page.getByRole("searchbox").fill("笔记");
  await expect(page.locator(".file-card")).toHaveCount(1);
  await page.getByRole("button", { name: "清除类型筛选" }).click();
  await expect(page.locator(".file-card")).toHaveCount(12);
  for (const label of ["视频", "图书", "音频"]) {
    const button = cards(page).getByRole("button", { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".empty-state")).toContainText("当前文件夹没有此类文件");
    await page.getByRole("button", { name: "查看全部文件" }).click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".file-card")).toHaveCount(12);
  }
});

test("home shortcuts stay scoped to the root file view and work with keyboard and previews", async ({ page }) => {
  const album = cards(page).getByRole("button", { name: "相册", exact: true });
  await album.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".file-card")).toHaveCount(3);
  await page.getByRole("button", { name: "预览 海边的周末.svg", exact: true }).click();
  await expect(page.locator(".preview-content img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#preview-dialog")).toHaveCount(0);
  await expect(album).toHaveAttribute("aria-pressed", "true");
  await mainNav(page).getByRole("button", { name: /最近/ }).click();
  await expect(cards(page)).toHaveCount(0);
  await mainNav(page).getByRole("button", { name: /文件/ }).click();
  await expect(album).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "打开文件夹 照片", exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  await page.getByRole("navigation", { name: "文件路径" })
    .getByRole("button", { name: "公开资源库", exact: true }).click();
  await expect(cards(page)).toBeVisible();
  await expect(page.locator(".file-card")).toHaveCount(12);
});
