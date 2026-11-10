import { expect } from "@playwright/test";

export const listingOptionsButton = (scope) =>
  scope.getByRole("button", {
    name: "排序与视图",
    exact: true,
  });
export const listingOptionsMenu = (scope) =>
  scope.getByRole("menu", {
    name: "排序与视图",
    exact: true,
  });

export async function openListingOptions(scope) {
  const trigger = listingOptionsButton(scope);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const menu = listingOptionsMenu(scope);
  await expect(menu).toBeVisible();
  return menu;
}

export async function chooseListingOption(scope, name) {
  const menu = await openListingOptions(scope);
  await menu.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(menu).toHaveCount(0);
}

export async function expectListingOptions(scope, names) {
  const menu = await openListingOptions(scope);
  for (const name of names)
    await expect(
      menu.getByRole("menuitemradio", { name, exact: true }),
    ).toHaveAttribute("aria-checked", "true");
  await menu.press("Escape");
  await expect(menu).toHaveCount(0);
}
