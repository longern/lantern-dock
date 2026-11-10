import { test, expect } from "@playwright/test";
import { breakpoints } from "../helpers/responsive.mjs";
import { openItem } from "../helpers/open-item.mjs";

test("CSS and runtime layouts agree at sm, md, lg and xl boundaries", async ({
  page,
}) => {
  test.skip(
    test.info().project.name !== "desktop",
    "Resize one mouse viewport across all boundaries",
  );
  await page.goto("/files/");
  await expect(page.locator("#file-list .file-item")).toHaveCount(12);
  const widths = ["sm", "md", "lg", "xl"].flatMap((key) => [
    breakpoints.values[key] - 1,
    breakpoints.values[key],
  ]);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 960 });
    const compact = width < breakpoints.values.md;
    await expect(page.locator("#sidebar")).toHaveCount(compact ? 0 : 1);
    await expect(page.locator(".mobile-tabs"))[
      compact ? "toBeVisible" : "toBeHidden"
    ]();
    await expect(page.locator(".list-head"))[
      width < breakpoints.values.sm ? "toBeHidden" : "toBeVisible"
    ]();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await openItem(
    page.getByRole("button", { name: "预览 项目笔记.md", exact: true }),
  );
  for (const width of widths) {
    await page.setViewportSize({ width, height: 960 });
    await expect
      .poll(() =>
        page
          .locator("#preview-dialog")
          .evaluate((node) => node.matches(":modal")),
      )
      .toBe(width < breakpoints.values.lg);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
});
