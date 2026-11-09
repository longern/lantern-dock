import { test, expect } from "@playwright/test";
import { mainNavigation } from "../helpers/navigation.mjs";

const session = { authenticated: true, user: { sub: "site-user", issuer: "https://site.example", name: "Shared account" } };

test("a pending Worker check never blocks public files and survives My navigation", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Mobile account navigation");
  let release, checks = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/auth/session", async (route) => {
    checks++;
    await gate;
    await route.fulfill({ json: session });
  });
  await page.goto("/");
  await expect(page.locator(".file-item")).toHaveCount(12);
  await mainNavigation(page).getByRole("button", { name: "我的", exact: true }).click();
  await expect(page.locator("#my-account")).toHaveAttribute("data-status", "loading");
  await mainNavigation(page).getByRole("button", { name: "首页", exact: true }).click();
  await expect(page.locator(".file-item")).toHaveCount(12);
  await mainNavigation(page).getByRole("button", { name: "我的", exact: true }).click();
  expect(checks).toBe(1);
  release();
  await expect(page.locator("#my-account")).toContainText("Shared account");
  await page.locator("#my-account-link").click();
  await expect(page.getByRole("heading", { name: "Shared account", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回我的", exact: true }).click();
  await expect(page.locator("#my-account")).toContainText("Shared account");
  expect(checks).toBe(1);
});

test("an unavailable NAS leaves the Worker account signed in and has an independent retry", async ({ page }) => {
  let sessionChecks = 0, nasChecks = 0;
  await page.route("**/api/auth/session", (route) => {
    sessionChecks++;
    return route.fulfill({ json: session });
  });
  await page.route("**/api/config", (route) => {
    nasChecks++;
    return route.fulfill({ status: 503, json: { message: "NAS temporarily unavailable" } });
  });
  await page.goto("/#/account");
  await expect(page.getByRole("heading", { name: "Shared account", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("NAS temporarily unavailable");
  await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "统一登录", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "重新检查 NAS 权限", exact: true }).click();
  await expect.poll(() => nasChecks).toBe(2);
  expect(sessionChecks).toBe(1);
});

test("offline is not rendered as a guest, and returning online rechecks the shared session", async ({ page }) => {
  test.skip(page.viewportSize().width > 700, "Mobile account state");
  let checks = 0;
  await page.route("**/api/auth/session", (route) => { checks++; return route.fulfill({ json: session }); });
  await page.goto("/#/me");
  await expect(page.locator("#my-account")).toContainText("Shared account");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(page.locator("#my-account")).toHaveAttribute("data-status", "error");
  await expect(page.locator("#my-account")).toContainText("当前处于离线状态");
  await expect(page.locator("#my-guest-button")).toHaveCount(0);
  await expect(page.locator("#my-settings")).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.locator("#my-account")).toContainText("Shared account");
  expect(checks).toBe(2);
});

test("blocked cross-tab messaging does not interrupt public or account state", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.BroadcastChannel = class { constructor() { throw new DOMException("Blocked", "SecurityError"); } };
  });
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: session }));
  await page.goto("/");
  await expect(page.locator(".file-item")).toHaveCount(12);
  await page.evaluate(() => { location.hash = "#/account"; });
  await expect(page.getByRole("heading", { name: "Shared account", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
