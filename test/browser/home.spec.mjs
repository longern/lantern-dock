import { test, expect } from "@playwright/test";

const nav = (page) => page.getByRole("navigation", {
  name: page.viewportSize().width <= 700 ? "移动端资源导航" : "资源导航",
  exact: true,
});
const home = (page) => nav(page).getByRole("button", { name: "首页", exact: true });
const files = (page) => nav(page).getByRole("button", { name: /^文件/ });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-card")).toHaveCount(12);
});

test("home and files are separate destinations, with breadcrumbs only in files", async ({ page }) => {
  await expect(nav(page).getByRole("button").nth(0)).toHaveText("首页");
  await expect(nav(page).getByRole("button").nth(1)).toContainText("文件");
  await expect(home(page)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "文件路径" })).toHaveCount(0);
  await expect(page.locator(".file-section-title")).toHaveText("文件");
  await files(page).click();
  await expect(page.getByRole("navigation", { name: "文件路径" })).toBeVisible();
  await expect(page.locator(".category-cards")).toHaveCount(0);
  await page.getByRole("button", { name: "打开文件夹 照片", exact: true }).click();
  await expect(page.locator(".file-card")).toHaveCount(4);
  await home(page).click();
  await expect(page.locator(".file-card")).toHaveCount(12);
  await expect(page.getByRole("navigation", { name: "文件路径" })).toHaveCount(0);
});

test("home shows actual recent visits, persists them and does not fall back after an unmatched search", async ({ page }) => {
  await page.getByLabel("排序", { exact: true }).selectOption("name");
  await page.getByRole("button", { name: "预览 项目笔记.md", exact: true }).click();
  await page.getByRole("button", { name: "关闭预览" }).click();
  await expect(page.locator(".file-section-title")).toHaveText("最近文件");
  await expect(page.locator("#file-list")).toHaveAttribute("aria-label", "最近文件列表");
  await expect(page.locator(".file-name")).toHaveText(["项目笔记.md"]);
  await files(page).click();
  await expect(page.locator(".file-card")).toHaveCount(12);
  await page.getByRole("button", { name: "预览 阅读清单.txt", exact: true }).click();
  await page.getByRole("button", { name: "关闭预览" }).click();
  await home(page).click();
  await expect(page.locator(".file-name")).toHaveText(["阅读清单.txt", "项目笔记.md"]);
  await expect(page.getByLabel("排序", { exact: true })).toHaveCount(0);
  await page.getByRole("searchbox").fill("山间");
  await expect(page.locator(".file-card")).toHaveCount(0);
  await expect(page.locator(".file-section-title")).toHaveText("最近文件");
  await expect(page.locator(".empty-state")).toContainText("没有找到匹配的文件");
  await expect(page.getByLabel("排序", { exact: true })).toHaveCount(0);
  await page.locator(".empty-state").getByRole("button", { name: "清除搜索" }).click();
  await page.reload();
  await expect(page.locator(".file-name")).toHaveText(["阅读清单.txt", "项目笔记.md"]);
  await files(page).click();
  await expect(page.locator(".file-card")).toHaveCount(12);
  await page.getByLabel("排序", { exact: true }).selectOption("size");
  await home(page).click();
  await expect(page.locator(".file-name")).toHaveText(["阅读清单.txt", "项目笔记.md"]);
  await expect(page.getByLabel("排序", { exact: true })).toHaveCount(0);
});

test("home has no divider between the search header and category shortcuts", async ({ page }) => {
  const headerRow = page.locator(page.viewportSize().width <= 700 ? ".mobile-file-tools" : ".topbar");
  await expect(headerRow).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".category-cards")).toHaveCSS("border-top-width", "0px");
  await files(page).click();
  await expect(headerRow).toHaveCSS("border-bottom-width", "1px");
});

test("search is 36px tall with and without the clear control on both destinations", async ({ page }) => {
  for (const destination of [home(page), files(page)]) {
    await destination.click();
    for (const value of ["", "笔记", ""]) {
      await page.getByRole("searchbox").fill(value);
      await expect(page.locator(".search-box")).toHaveCSS("height", "36px");
      const box = await page.locator(".search-box").boundingBox();
      expect(box.height).toBe(36);
      if (value) {
        const clear = await page.locator(".search-clear").boundingBox();
        expect(clear.y).toBeGreaterThanOrEqual(box.y);
        expect(clear.y + clear.height).toBeLessThanOrEqual(box.y + box.height);
      }
    }
  }
});

test("mobile home card is edge-to-edge, fills the screen and grows with its contents without negative margins", async ({ page }, testInfo) => {
  test.skip(page.viewportSize().width > 700, "Mobile card layout");
  // One recent file exercises the otherwise empty space below short lists.
  await page.getByRole("button", { name: "预览 项目笔记.md", exact: true }).click();
  await page.getByRole("button", { name: "关闭预览" }).click();
  const inspect = () => page.locator(".home-content").evaluate((node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      left: box.left, right: box.right, bottom: box.bottom, width: innerWidth,
      viewportHeight: innerHeight, height: box.height,
      background: style.backgroundColor,
      radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
      margins: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft].map(parseFloat),
      overflow: [document.documentElement, node, ...node.querySelectorAll(".file-toolbar,.file-open")]
        .filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.className),
    };
  });
  const short = await inspect();
  expect(short.left).toBe(0);
  expect(short.right).toBe(short.width);
  expect(short.bottom).toBeGreaterThanOrEqual(short.viewportHeight);
  expect(short.background).toBe("rgb(255, 255, 255)");
  expect(short.radii).toEqual(["20px", "20px", "0px", "0px"]);
  expect(short.margins.every((value) => value >= 0)).toBe(true);
  expect(short.overflow).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("home-recent.png"), fullPage: false });
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.endsWith(":recent"));
    const first = JSON.parse(localStorage.getItem(key))[0];
    localStorage.setItem(key, JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
      ...first, path: `/note-${index}.md`, name: `笔记 ${index}.md`, visitedAt: Date.now() - index,
    }))));
  });
  await page.reload();
  await expect(page.locator(".file-card")).toHaveCount(30);
  const long = await inspect();
  expect(long.height).toBeGreaterThan(short.height);
  expect(long.overflow).toEqual([]);
});
