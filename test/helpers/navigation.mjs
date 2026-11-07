import { expect } from "@playwright/test";

export const mainNavigation = (page) => page.getByRole("navigation", {
  name: page.viewportSize().width <= 700 ? "移动端资源导航" : "资源导航",
  exact: true,
});

export const connectionSettingsReturnTarget = (page) => page.viewportSize().width <= 700
  ? page.getByRole("button", { name: "打开导航", exact: true })
  : page.locator("#sidebar").getByRole("button", { name: "连接设置", exact: true });

export async function openConnectionSettings(page) {
  const sidebar = page.locator("#sidebar");
  if (page.viewportSize().width <= 700) {
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await expect(sidebar).toBeVisible();
  }
  await sidebar.getByRole("button", { name: "连接设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "连接设置", exact: true })).toBeVisible();
  if (page.viewportSize().width <= 700) await expect(sidebar).not.toHaveAttribute("open");
  return connectionSettingsReturnTarget(page);
}
