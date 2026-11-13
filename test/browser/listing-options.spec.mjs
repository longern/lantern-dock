import {
  closeHomeSearch,
  homeSearchDialog,
  homeSearchEntry,
  openHomeSearch,
} from "../helpers/home-search.mjs";
import { isCompact } from "../helpers/responsive.mjs";
import { isModalPreview } from "../helpers/responsive.mjs";
import { favoriteItem } from "../helpers/favorite-item.mjs";
import { openItem } from "../helpers/open-item.mjs";
import { test, expect } from "@playwright/test";
import {
  closeFavorites,
  mainNavigation,
  openFavorites,
} from "../helpers/navigation.mjs";
import {
  chooseListingOption,
  expectListingOptions,
  listingOptionsButton,
  listingOptionsMenu,
  openListingOptions,
} from "../helpers/listing-options.mjs";

const recentKey = "lantern-dock:demo::/:recent";
const names = ["阅读清单.txt", "项目笔记.md"];
const history = names.map((name, index) => ({
  path: `/${encodeURIComponent(name)}`,
  name,
  kind: "text",
  isDirectory: false,
  size: 100,
  visitedAt: 200 - index * 100,
}));
const fileNames = (page) => page.locator("#file-list .file-name");
const preview = (page, name) =>
  page.getByRole("button", { name: `预览 ${name}`, exact: true });
const dialog = (page) => page.locator("#preview-dialog");
const goFiles = (page) =>
  mainNavigation(page).getByRole("button", { name: /^文件/ }).click();
const goHome = (page) =>
  mainNavigation(page)
    .getByRole("button", { name: "首页", exact: true })
    .click();

async function seedRecent(page) {
  await page.addInitScript(
    ({ key, history }) => localStorage.setItem(key, JSON.stringify(history)),
    {
      key: recentKey,
      history,
    },
  );
  await page.goto("/");
  await expect(fileNames(page)).toHaveText(names);
}

// Hold real CSS animations and timer fallbacks independently. No sleeps or
// assumptions about machine speed are needed to observe the opening frame.
async function holdMotion(page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.addStyleTag({
    content:
      ".preview-dialog[open] { animation-play-state: paused !important; }",
  });
}
async function finishMotion(page) {
  await dialog(page).evaluate((node) =>
    node.getAnimations().forEach((animation) => animation.finish()),
  );
  await page.clock.runFor(500);
}

// Use DOM activation only in these timing tests: Playwright's normal click
// waits for a paused animated target to become stable before acting.
async function activate(locator) {
  await locator.evaluate((node) => node.click());
}

test("Files and Favorites own their right-edge header actions instead of the list toolbar", async ({
  page,
}) => {
  await page.goto("/");
  await expect(fileNames(page)).toHaveCount(12);
  for (const destination of ["fallback", "files", "favorites"]) {
    if (destination === "files") await goFiles(page);
    if (destination === "favorites") await openFavorites(page);
    const header = page.locator(
      destination === "favorites" ? ".favorites-heading" : ".topbar",
    );
    const trigger = listingOptionsButton(header);
    await expect(trigger).toHaveCount(1);
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveCSS("width", "48px");
    await expect(trigger).toHaveCSS("height", "48px");
    await expect(trigger).toHaveCSS("margin-right", "-12px");
    await expect(
      listingOptionsButton(page.locator(".file-toolbar")),
    ).toHaveCount(0);
    await expect(listingOptionsButton(page)).toHaveCount(1);
    // Favorites can still be sliding into place after becoming visible.
    await expect
      .poll(async () => {
        const bounds = await trigger.boundingBox();
        return (
          !!bounds &&
          bounds.x >= 0 &&
          bounds.x + bounds.width <= page.viewportSize().width
        );
      })
      .toBe(true);
    const menu = await openListingOptions(page);
    const menuBounds = await menu.boundingBox();
    expect(menuBounds.x).toBeGreaterThanOrEqual(0);
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(
      page.viewportSize().width,
    );
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test("fallback files expose one menu with keyboard navigation and dismissal", async ({
  page,
}) => {
  await page.goto("/");
  await expect(fileNames(page)).toHaveCount(12);
  await expect(page.locator(".view-tools select,.view-switch")).toHaveCount(0);
  const trigger = listingOptionsButton(page);
  await expect(trigger).toHaveCount(1);
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const menu = listingOptionsMenu(page);
  await expect(menu).toBeVisible();
  const items = menu.locator('[role^="menuitem"]');
  await expect(menu.getByRole("menuitemradio")).toHaveCount(5);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await openListingOptions(page);
  // On mobile the anchored menu covers the middle of the search field.
  await homeSearchEntry(page).click({ position: { x: 4, y: 12 } });
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toBeFocused();
  await closeHomeSearch(page);
  await openListingOptions(page);
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await openListingOptions(page);
  await trigger.click();
  await expect(menu).toHaveCount(0);
});

test("recent files stay a newest-first list without changing Files or Favorites preferences", async ({
  page,
}) => {
  await seedRecent(page);
  await goFiles(page);
  await chooseListingOption(page, "大小");
  await chooseListingOption(page, "网格视图");
  await favoriteItem(
    page.getByRole("button", { name: "预览 项目笔记.md", exact: true }),
  );
  await goHome(page);
  await expect(page.locator("#file-list")).toHaveClass(/list-layout/);
  await expect(fileNames(page)).toHaveText(names);
  await expect(listingOptionsButton(page)).toHaveCount(0);
  await expect(page.locator(".view-tools select,.view-switch")).toHaveCount(0);
  await (await openHomeSearch(page)).fill("not-found");
  await expect(
    isCompact(page)
      ? homeSearchDialog(page).locator(".file-name")
      : fileNames(page),
  ).toHaveCount(0);
  await closeHomeSearch(page);
  await expect(listingOptionsButton(page)).toHaveCount(0);
  await goFiles(page);
  await expect(page.locator("#file-list")).not.toHaveClass(/list-layout/);
  await expectListingOptions(page, ["大小", "网格视图"]);
  await openFavorites(page);
  await expectListingOptions(page, ["名称", "网格视图"]);
  await chooseListingOption(page, "修改时间");
  await chooseListingOption(page, "列表视图");
  await expect(page.locator("#file-list")).toHaveClass(/list-layout/);
  await closeFavorites(page);
  await goHome(page);
  await expect(fileNames(page)).toHaveText(names);
  await expect(page.locator("#file-list")).toHaveClass(/list-layout/);
  await expect(listingOptionsButton(page)).toHaveCount(0);
  await goFiles(page);
  // Sort belongs to each destination, but the chosen view is shared.
  await expectListingOptions(page, ["大小", "列表视图"]);
  await openFavorites(page);
  await expectListingOptions(page, ["修改时间", "列表视图"]);
});

test("Favorites menu Escape does not dismiss its parent or a later nested preview", async ({
  page,
}) => {
  await page.goto("/");
  await favoriteItem(
    page.getByRole("button", { name: "预览 项目笔记.md", exact: true }),
  );
  await openFavorites(page);
  await openListingOptions(page);
  await page.keyboard.press("Escape");
  await expect(listingOptionsMenu(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/favorites$/);
  await expect(listingOptionsButton(page)).toBeFocused();
  await openItem(preview(page, names[1]));
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/favorites$/);
  await expect(preview(page, names[1])).toBeFocused();
  await openListingOptions(page);
  await expect(listingOptionsMenu(page)).toBeVisible();
  const bounds = await listingOptionsMenu(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(
    page.viewportSize().width,
  );
});

test("recent visits persist immediately but reorder only after preview entrance", async ({
  page,
}) => {
  await seedRecent(page);
  await holdMotion(page);
  await activate(preview(page, names[1]));
  await expect(dialog(page)).toHaveAttribute("data-state", "open");
  expect(
    await dialog(page).evaluate((node) => node.getAnimations().length),
  ).toBeGreaterThan(0);
  await page.clock.runFor(1000);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key))[0].name,
        recentKey,
      ),
    )
    .toBe(names[1]);
  await expect(fileNames(page)).toHaveText(names);
  await finishMotion(page);
  await expect(fileNames(page)).toHaveText([...names].reverse());
  await activate(page.getByRole("button", { name: "关闭预览", exact: true }));
  await finishMotion(page);
  await expect(dialog(page)).toHaveCount(0);
  await expect(preview(page, names[1])).toBeFocused();
});

test("closing before entrance completes releases recent history only after exit", async ({
  page,
}) => {
  await seedRecent(page);
  await holdMotion(page);
  await activate(preview(page, names[1]));
  await expect(fileNames(page)).toHaveText(names);
  await activate(page.getByRole("button", { name: "关闭预览", exact: true }));
  await expect(dialog(page)).toHaveAttribute("data-state", "closed");
  await expect(fileNames(page)).toHaveText(names);
  await finishMotion(page);
  await expect(dialog(page)).toHaveCount(0);
  await expect(fileNames(page)).toHaveText([...names].reverse());
  await activate(preview(page, names[0]));
  await expect(fileNames(page)).toHaveText([...names].reverse());
  await finishMotion(page);
  await expect(fileNames(page)).toHaveText(names);
});

test("desktop preview replacement and interrupted close cannot release a stale recent snapshot", async ({
  page,
}) => {
  test.skip(
    isModalPreview(page),
    "Only nonmodal previews allow background file activation",
  );
  await seedRecent(page);
  await holdMotion(page);
  await activate(preview(page, names[1]));
  await page.clock.runFor(1);
  await activate(preview(page, names[0]));
  await expect(dialog(page).locator("#preview-name")).toContainText(names[0]);
  await expect(fileNames(page)).toHaveText(names);
  await finishMotion(page);
  await expect(fileNames(page)).toHaveText(names);
  // Clicking the already open file must not leave a new unreleased snapshot.
  await activate(preview(page, names[0]));
  await activate(page.getByRole("button", { name: "关闭预览", exact: true }));
  await expect(dialog(page)).toHaveAttribute("data-state", "closed");
  await activate(preview(page, names[1]));
  await expect(dialog(page)).toHaveAttribute("data-state", "open");
  await expect(fileNames(page)).toHaveText(names);
  await finishMotion(page);
  await expect(dialog(page)).toHaveAttribute("data-state", "open");
  await expect(fileNames(page)).toHaveText([...names].reverse());
});

test("reduced motion completes repeated recent visits without leaving a frozen listing", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedRecent(page);
  for (const name of [names[1], names[0], names[1]]) {
    await openItem(preview(page, name));
    await expect(fileNames(page).first()).toHaveText(name);
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  }
});

test("the first visit keeps the fallback directory visible until preview entrance completes", async ({
  page,
}) => {
  await page.goto("/");
  await expect(fileNames(page)).toHaveCount(12);
  await chooseListingOption(page, "网格视图");
  await holdMotion(page);
  await activate(preview(page, names[1]));
  await expect(fileNames(page)).toHaveCount(12);
  await expect(page.locator(".file-section-title")).toHaveCount(0);
  await expect(page.locator("#file-list")).not.toHaveClass(/list-layout/);
  await finishMotion(page);
  await expect(fileNames(page)).toHaveText([names[1]]);
  await expect(page.locator(".file-section-title")).toHaveText("最近文件");
  await expect(page.locator("#file-list")).toHaveClass(/list-layout/);
  await expect(listingOptionsButton(page)).toHaveCount(0);
});

test("scrolled Favorites can reopen the menu inside the viewport and select an option", async ({
  page,
}) => {
  const favorites = Array.from({ length: 40 }, (_, index) => ({
    ...history[0],
    path: `/favorite-${index}.txt`,
    name: `收藏 ${index}.txt`,
  }));
  await page.addInitScript(
    (items) =>
      localStorage.setItem(
        "lantern-dock:demo::/:favorites",
        JSON.stringify(items),
      ),
    favorites,
  );
  await page.goto("/favorites");
  await expect(fileNames(page)).toHaveCount(40);
  for (let pass = 0; pass < 2; pass++) {
    await page.locator("#file-list .file-item").last().scrollIntoViewIfNeeded();
    const menu = await openListingOptions(page);
    const bounds = await menu.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize().width,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      page.viewportSize().height,
    );
    expect(
      await menu.evaluate(
        (node) =>
          typeof node.showPopover !== "function" ||
          node.matches(":popover-open"),
      ),
    ).toBe(true);
    await menu
      .getByRole("menuitemradio", {
        name: pass ? "列表视图" : "网格视图",
        exact: true,
      })
      .click();
    await expect(menu).toHaveCount(0);
    await expect(listingOptionsButton(page)).toBeFocused();
    await expectListingOptions(page, [pass ? "列表视图" : "网格视图"]);
    await expect(page).toHaveURL(/\/favorites$/);
  }
});
