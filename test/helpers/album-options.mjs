import { expect } from "@playwright/test";

export const albumOptionsButton = (scope) =>
  scope.getByRole("button", { name: "相册选项", exact: true });
export const albumOptionsMenu = (scope) =>
  scope.getByRole("menu", { name: "相册选项", exact: true });

export async function openAlbumOptions(scope) {
  await albumOptionsButton(scope).click();
  const menu = albumOptionsMenu(scope);
  await expect(menu).toBeVisible();
  return menu;
}

export async function chooseAlbumView(scope, name) {
  const menu = await openAlbumOptions(scope);
  await menu.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(menu).toHaveCount(0);
}

export async function refreshAlbum(scope) {
  const menu = await openAlbumOptions(scope);
  await menu.getByRole("menuitem", { name: "刷新", exact: true }).click();
  await expect(menu).toHaveCount(0);
}
