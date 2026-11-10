import { isCompact } from "./responsive.mjs";
import { expect } from "@playwright/test";

const navigationLabels = {
  "zh-CN": {
    navigation: "资源导航",
    mobileNavigation: "移动端资源导航",
    me: "我的",
    favorites: /^收藏/,
    myFavorites: "我的收藏",
    backToMe: "返回我的",
  },
  en: {
    navigation: "Resource navigation",
    mobileNavigation: "Mobile resource navigation",
    me: "Me",
    favorites: /^Favorites/,
    myFavorites: "My favorites",
    backToMe: "Back to Me",
  },
};

export const mainNavigation = (page, language = "zh-CN") =>
  page.getByRole("navigation", {
    name: isCompact(page)
      ? navigationLabels[language].mobileNavigation
      : navigationLabels[language].navigation,
    exact: true,
  });

export async function openFavorites(page, language = "zh-CN") {
  const copy = navigationLabels[language];
  const navigation = mainNavigation(page, language);
  if (isCompact(page)) {
    await navigation
      .getByRole("button", { name: copy.me, exact: true })
      .click();
    await page
      .getByRole("button", { name: copy.myFavorites, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: copy.myFavorites,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    return dialog.getByRole("button", { name: copy.backToMe, exact: true });
  }
  const trigger = navigation.getByRole("button", { name: copy.favorites });
  await trigger.click();
  await expect(page).toHaveURL(/\/favorites$/);
  return trigger;
}

export async function closeFavorites(page, language = "zh-CN") {
  if (!isCompact(page)) return;
  const copy = navigationLabels[language];
  const dialog = page.getByRole("dialog", {
    name: copy.myFavorites,
    exact: true,
  });
  await dialog
    .getByRole("button", { name: copy.backToMe, exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/me$/);
}

export const connectionSettingsReturnTarget = (page) =>
  isCompact(page)
    ? page.locator(
        new URL(page.url()).pathname === "/me"
          ? "#my-settings"
          : ".mobile-tabs button:last-child",
      )
    : page
        .locator("#sidebar")
        .getByRole("button", { name: "连接设置", exact: true });

export async function openConnectionSettings(page) {
  if (isCompact(page)) {
    await mainNavigation(page)
      .getByRole("button", { name: "我的", exact: true })
      .click();
    await page.locator("#my-settings").click();
  } else await page.locator("#connection-settings").click();
  await expect(
    page.getByRole("dialog", { name: "连接设置", exact: true }),
  ).toBeVisible();
  return connectionSettingsReturnTarget(page);
}
