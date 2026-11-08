import { expect } from "@playwright/test";

const navigationLabels = {
  "zh-CN": {
    navigation: "资源导航", mobileNavigation: "移动端资源导航",
    me: "我的", favorites: /^收藏/, myFavorites: "我的收藏", backToMe: "返回我的",
  },
  en: {
    navigation: "Resource navigation", mobileNavigation: "Mobile resource navigation",
    me: "Me", favorites: /^Favorites/, myFavorites: "My favorites", backToMe: "Back to Me",
  },
};

export const mainNavigation = (page, language = "zh-CN") => page.getByRole("navigation", {
  name: page.viewportSize().width <= 700
    ? navigationLabels[language].mobileNavigation
    : navigationLabels[language].navigation,
  exact: true,
});

export async function openFavorites(page, language = "zh-CN") {
  const copy = navigationLabels[language];
  const navigation = mainNavigation(page, language);
  if (page.viewportSize().width <= 700) {
    await navigation.getByRole("button", { name: copy.me, exact: true }).click();
    await page.getByRole("button", { name: copy.myFavorites, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: copy.myFavorites, exact: true });
    await expect(dialog).toBeVisible();
    return dialog.getByRole("button", { name: copy.backToMe, exact: true });
  }
  const trigger = navigation.getByRole("button", { name: copy.favorites });
  await trigger.click();
  await expect(page).toHaveURL(/#\/favorites$/);
  return trigger;
}

export async function closeFavorites(page, language = "zh-CN") {
  if (page.viewportSize().width > 700) return;
  const copy = navigationLabels[language];
  const dialog = page.getByRole("dialog", { name: copy.myFavorites, exact: true });
  await dialog.getByRole("button", { name: copy.backToMe, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/me$/);
}

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
