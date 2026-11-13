import { homeSearchEntry } from "../helpers/home-search.mjs";
import { test, expect } from "@playwright/test";
import { isCompact } from "../helpers/responsive.mjs";

test("interface text and editable fields follow a larger root font", async ({
  page,
}) => {
  await page.goto("/");
  const name = page.locator(".file-name").first();
  await expect(name).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("font-size", "16px");
  await expect(name).toHaveCSS("font-size", "14px");
  const brand = page.locator(
    isCompact(page) ? ".topbar .site-brand" : ".sidebar .site-brand",
  );
  await expect(brand).toHaveCSS("font-size", "18px");
  await expect(brand).toHaveCSS("font-weight", "600");
  const search = homeSearchEntry(page);
  await expect(search).toBeVisible();
  await expect(search).toHaveCSS(
    "font-size",
    isCompact(page) ? "16px" : "14px",
  );
  await page.addStyleTag({ content: ":root { font-size: 125%; }" });
  await expect(name).toHaveCSS("font-size", "17.5px");
  await expect(brand).toHaveCSS("font-size", "22.5px");
  await expect(search).toHaveCSS(
    "font-size",
    isCompact(page) ? "20px" : "17.5px",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize().width);
});

test("album dates use one rem on every viewport and follow the root preference", async ({
  page,
}) => {
  await page.goto("/album/");
  const date = page.locator(".album-date").first();
  await expect(date).toBeVisible();
  await expect(date).toHaveCSS("font-size", "16px");
  await page.addStyleTag({ content: ":root { font-size: 125%; }" });
  await expect(date).toHaveCSS("font-size", "20px");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize().width);
});
