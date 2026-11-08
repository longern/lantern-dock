import { chooseListingOption } from "../helpers/listing-options.mjs";
import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { closeFavorites, openConnectionSettings, openFavorites } from "../helpers/navigation.mjs";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      delete window.showSaveFilePicker;
    });
    await use(page);
    expect(errors).toEqual([]);
  },
});
const nav = (page) =>
  page.viewportSize().width <= 700
    ? page.getByRole("navigation", { name: "移动端资源导航" })
    : page.getByRole("navigation", { name: "资源导航", exact: true });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-card")).toHaveCount(12);
});

test("search, sorting, views, folders and navigation work", async ({
  page,
}) => {
  await page.getByRole("searchbox").fill("山间");
  await expect(page.locator(".file-card")).toHaveCount(1);
  await page.getByRole("searchbox").fill("no-such-file");
  await expect(page.getByText("没有找到匹配的文件")).toBeVisible();
  await expect(page.locator(".list-head")).toBeHidden();
  await page.getByRole("searchbox").fill("");
  await chooseListingOption(page, "大小");
  await expect(
    page.locator(".file-card").nth(4).locator(".file-name"),
  ).toHaveText("归档资料.zip");
  await chooseListingOption(page, "网格视图");
  await expect(page.locator("#file-list")).not.toHaveClass(/list-layout/);
  await chooseListingOption(page, "列表视图");
  await expect(page.locator("#file-list")).toHaveClass(/list-layout/);
  await page
    .getByRole("button", { name: "打开文件夹 照片", exact: true })
    .click();
  await expect(page.locator(".file-card")).toHaveCount(4);
  await expect(
    page.getByRole("navigation", { name: "文件路径" }),
  ).toContainText("照片");
  await page
    .getByRole("navigation", { name: "文件路径" })
    .getByRole("button", { name: "公开资源库", exact: true })
    .click();
  await expect(page.locator(".file-card")).toHaveCount(12);
  await nav(page).getByRole("button", { name: /首页/ }).click();
  await expect(page.locator(".file-card")).toHaveCount(12);
  await expect(page.getByRole("navigation", { name: "文件路径" })).toHaveCount(0);
});

test("preview switches between panel and modal at viewport boundaries", async ({
  page,
}, testInfo) => {
  const original = page.viewportSize();
  const trigger = page.getByRole("button", {
    name: "预览 海边的周末.svg",
    exact: true,
  });
  await trigger.click();
  await expect(page.locator(".preview-content img")).toBeVisible();
  await expect(page.locator(".file-details")).toContainText("1200 × 800");
  for (const width of [1440, 1024, 1000, 768, 701, 700, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page
          .locator("#preview-dialog")
          .evaluate((node) => node.matches(":modal")),
      )
      .toBe(width <= 1000);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const nodes = [
            document.documentElement,
            ...document.querySelectorAll(
              ".topbar,.file-toolbar,.file-open,.list-head",
            ),
          ];
          return nodes
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => node.className);
        }),
      )
      .toEqual([]);
  }
  await page.setViewportSize(original);
  await page.screenshot({
    path: testInfo.outputPath("preview.png"),
    fullPage: false,
  });
  await page.getByRole("button", { name: "关闭预览" }).click();
  await expect(page.locator("#preview-dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#preview-dialog")).toHaveCount(0);
});

test("favorites and recent entries survive reload without storing credentials", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "预览 项目笔记.md", exact: true })
    .click();
  await expect(page.locator(".preview-content pre")).toContainText(
    "欢迎使用 LanternDock",
  );
  await page.getByRole("button", { name: "收藏文件", exact: true }).click();
  await page.getByRole("button", { name: "关闭预览" }).click();
  await openFavorites(page);
  await expect(page.locator(".file-card")).toHaveCount(1);
  await closeFavorites(page);
  await nav(page).getByRole("button", { name: /首页/ }).click();
  await expect(page.locator(".file-card")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".file-card")).toHaveCount(1);
  await openFavorites(page);
  await expect(page.locator(".file-name")).toHaveText("项目笔记.md");
});

test("settings reconnect and credential clearing clean up preview", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "预览 项目笔记.md", exact: true })
    .click();
  await page.getByRole("button", { name: "关闭预览" }).click();
  await openConnectionSettings(page);
  await page.getByLabel("访问方式", { exact: true }).selectOption("basic");
  await page.getByLabel("用户名", { exact: true }).fill("local-user");
  await page.getByLabel("密码", { exact: true }).fill("memory-only-secret");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".file-card")).toHaveCount(1);
  await openConnectionSettings(page);
  await expect(page.getByLabel("用户名", { exact: true })).toHaveValue(
    "local-user",
  );
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "memory-only-secret",
  );
  await page.getByRole("button", { name: "清除登录信息" }).click();
  await expect(page.getByLabel("访问方式", { exact: true })).toHaveValue(
    "none",
  );
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.reload();
  await expect(page.locator(".file-card")).toHaveCount(1);
  await openConnectionSettings(page);
  await expect(page.getByLabel("访问方式", { exact: true })).toHaveValue(
    "none",
  );
});

test("text downloads contain file contents", async ({ page }) => {
  await page
    .getByRole("button", { name: "预览 阅读清单.txt", exact: true })
    .click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载", exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("阅读清单.txt");
  expect(await readFile(await file.path(), "utf8")).toContain("HTTP Semantics");
});

test("config failures stay visible and reconnect can recover", async ({
  page,
}) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "No unexpired certificate pins" },
    }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "No unexpired certificate pins",
  );
  await expect(page.locator(".file-card")).toHaveCount(0);
  await expect(page.locator(".list-head")).toBeHidden();
  const settings = page.locator(".empty-state").getByRole("button", { name: "连接设置", exact: true });
  await settings.click();
  await expect(page.getByRole("dialog", { name: "连接设置", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "连接设置", exact: true })).toHaveCount(0);
  await expect(settings).toBeFocused();
  await page.unroute("**/api/config");
  await settings.click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".file-card")).toHaveCount(12);
  await expect(page.locator(".list-head")).not.toHaveAttribute("hidden");
});

test("error notifications use a translucent black surface below center above preview dialogs", async ({
  page,
}, testInfo) => {
  await page
    .getByRole("button", { name: "预览 归档资料.zip", exact: true })
    .click();
  await page.getByRole("button", { name: "下载", exact: true }).click();
  const notification = page.getByRole("alert");
  await expect(notification).toContainText("连接真实后端");
  expect(
    await notification.evaluate((node) => node.matches(":popover-open")),
  ).toBe(true);
  const style = await notification.evaluate((node) => {
    const box = node.getBoundingClientRect(),
      style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      color: style.color,
      x: box.x + box.width / 2,
      y: (box.y + box.height / 2) / innerHeight,
      width: innerWidth,
      height: box.height,
    };
  });
  expect(style.background).toBe("rgba(20, 20, 24, 0.88)");
  expect(style.color).toBe("rgb(255, 255, 255)");
  expect(Math.abs(style.x - style.width / 2)).toBeLessThan(2);
  expect(style.y).toBeGreaterThan(0.6);
  expect(style.y).toBeLessThan(0.85);
  expect(style.height).toBeLessThan(100);
  await expect(notification).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("error-toast.png"),
    fullPage: false,
  });
});

test("notifications fade out before removal and respect reduced motion", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page
    .getByRole("button", { name: "预览 归档资料.zip", exact: true })
    .click();
  for (const reducedMotion of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion });
    await page.getByRole("button", { name: "下载", exact: true }).click();
    const notification = page.getByRole("alert");
    await expect(notification).toContainText("连接真实后端");
    await expect(notification).toHaveCSS(
      "animation-name",
      reducedMotion === "reduce" ? "none" : "toast-in",
    );
    await page.clock.runFor(6500);
    await expect(notification).toHaveCSS(
      "animation-name",
      reducedMotion === "reduce" ? "none" : "toast-out",
    );
    expect(
      await notification.evaluate((node) => node.matches(":popover-open")),
    ).toBe(true);
    await page.clock.runFor(200);
    await expect(notification).toHaveCount(0);
  }
});
