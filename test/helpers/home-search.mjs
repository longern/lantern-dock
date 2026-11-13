import { expect } from "@playwright/test";
import { isCompact } from "./responsive.mjs";

export const homeSearchTrigger = (page) => page.locator("#home-search-trigger");
export const homeSearchDialog = (page) => page.locator("#home-search-dialog");
export const homeSearchEntry = (page) =>
  isCompact(page) ? homeSearchTrigger(page) : page.getByRole("searchbox");

export async function openHomeSearch(page) {
  if (isCompact(page) && !(await homeSearchDialog(page).isVisible()))
    await homeSearchTrigger(page).click();
  return page.getByRole("searchbox");
}

export async function closeHomeSearch(page) {
  if (!isCompact(page)) return;
  const dialog = homeSearchDialog(page);
  await dialog.locator(".home-search-header > button").click();
  await expect(dialog).toHaveCount(0);
}
