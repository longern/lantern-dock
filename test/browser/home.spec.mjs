import { isCompact } from "../helpers/responsive.mjs";
import { favoriteItem } from "../helpers/favorite-item.mjs";
import { openItem } from "../helpers/open-item.mjs";
import {
  chooseListingOption,
  listingOptionsButton,
} from "../helpers/listing-options.mjs";
import { test, expect } from "@playwright/test";
import {
  closeFavorites,
  mainNavigation as nav,
  openFavorites,
} from "../helpers/navigation.mjs";

const home = (page) =>
  nav(page).getByRole("button", { name: "首页", exact: true });
const files = (page) => nav(page).getByRole("button", { name: /^文件/ });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-item")).toHaveCount(12);
  await expect(
    page.getByRole("searchbox", { includeHidden: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("searchbox")).toBeVisible();
  await expect(
    page.locator(".topbar").getByRole("button", {
      name: "连接设置",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
});

test("home and files are separate destinations, with breadcrumbs only in files", async ({
  page,
}) => {
  await expect(nav(page).getByRole("button").nth(0)).toHaveText("首页");
  await expect(nav(page).getByRole("button").nth(1)).toContainText("文件");
  await expect(home(page)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "文件路径" })).toHaveCount(
    0,
  );
  await expect(page.locator(".file-section-title")).toHaveCount(0);
  await files(page).click();
  await expect(
    page.getByRole("searchbox", { includeHidden: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "文件路径" }),
  ).toBeVisible();
  await expect(page.locator(".category-cards")).toHaveCount(0);
  await openItem(
    page.getByRole("button", { name: "打开文件夹 照片", exact: true }),
  );
  await expect(page.locator(".file-item")).toHaveCount(4);
  await expect(
    page.getByRole("searchbox", { includeHidden: true }),
  ).toHaveCount(0);
  await home(page).click();
  await expect(page.locator(".file-item")).toHaveCount(12);
  await expect(page.getByRole("navigation", { name: "文件路径" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("searchbox")).toHaveValue("");
});

test("leaving Home clears search for Files, Favorites, folders and sidebar categories", async ({
  page,
}) => {
  await favoriteItem(
    page.getByRole("button", { name: "预览 项目笔记.md", exact: true }),
  );
  for (const [mode, count] of [
    ["files", 12],
    ["favorites", 1],
  ]) {
    await page.getByRole("searchbox").fill("no-matching-file");
    await expect(page.locator(".file-item")).toHaveCount(0);
    if (mode === "favorites") await openFavorites(page);
    else await files(page).click();
    await expect(
      page.getByRole("searchbox", { includeHidden: true }),
    ).toHaveCount(0);
    await expect(
      page.locator(".topbar").getByRole("button", {
        name: "连接设置",
        exact: true,
        includeHidden: true,
      }),
    ).toHaveCount(0);
    await expect(page.locator(".file-item")).toHaveCount(count);
    await expect(page.locator(".empty-state")).toHaveCount(0);
    if (mode === "favorites") await closeFavorites(page);
    await home(page).click();
    await expect(page.getByRole("searchbox")).toHaveValue("");
    await expect(page.locator(".file-item")).toHaveCount(12);
  }
  await page.getByRole("searchbox").fill("照片");
  await openItem(
    page.getByRole("button", { name: "打开文件夹 照片", exact: true }),
  );
  await expect(
    page.getByRole("searchbox", { includeHidden: true }),
  ).toHaveCount(0);
  await expect(page.locator(".file-item")).toHaveCount(4);
  await page
    .getByRole("navigation", { name: "文件路径" })
    .getByRole("button", { name: "公开资源库", exact: true })
    .click();
  await expect(
    page.getByRole("searchbox", { includeHidden: true }),
  ).toHaveCount(0);
  await expect(page.locator(".file-item")).toHaveCount(12);
  await home(page).click();
  await expect(page.getByRole("searchbox")).toHaveValue("");

  await page.getByRole("searchbox").fill("no-matching-file");
  await page
    .getByRole("navigation", { name: "文件分类", exact: true })
    .getByRole("button", { name: "文档", exact: true })
    .click();
  await expect(
    page.getByRole("searchbox", { includeHidden: true }),
  ).toHaveCount(0);
  await expect(page.locator(".file-item")).toHaveCount(4);
  await home(page).click();
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect(page.locator(".file-item")).toHaveCount(12);
});

test("slash focuses Home search without navigating from other destinations", async ({
  page,
}) => {
  await home(page).focus();
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.getByRole("searchbox").fill("note");
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox")).toHaveValue("note/");
  for (const mode of ["files", "favorites"]) {
    const destination =
      mode === "favorites" ? await openFavorites(page) : files(page);
    if (mode === "files") await destination.click();
    await destination.focus();
    await page.keyboard.press("/");
    if (mode === "favorites") await expect(page).toHaveURL(/\/favorites$/);
    else await expect(destination).toHaveAttribute("aria-current", "page");
    await expect(destination).toBeFocused();
    await expect(
      page.getByRole("searchbox", { includeHidden: true }),
    ).toHaveCount(0);
    if (mode === "favorites") await closeFavorites(page);
  }
  await files(page).click();
  await openItem(
    page.getByRole("button", { name: "打开文件夹 照片", exact: true }),
  );
  const root = page
    .getByRole("navigation", { name: "文件路径" })
    .getByRole("button", { name: "公开资源库", exact: true });
  await root.focus();
  await page.keyboard.press("/");
  await expect(root).toBeFocused();
  await expect(
    page.getByRole("navigation", { name: "文件路径" }),
  ).toContainText("照片");
  await expect(page.locator(".file-item")).toHaveCount(4);
  await expect(
    page.getByRole("searchbox", { includeHidden: true }),
  ).toHaveCount(0);
  await home(page).click();
  await home(page).focus();
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox")).toBeFocused();
  await expect(page.getByRole("searchbox")).toHaveValue("");
});

test("home shows actual recent visits, persists them and does not fall back after an unmatched search", async ({
  page,
}) => {
  await chooseListingOption(page, "名称");
  await openItem(
    page.getByRole("button", { name: "预览 项目笔记.md", exact: true }),
  );
  await page.getByRole("button", { name: "关闭预览" }).click();
  await expect(page.locator(".file-section-title")).toHaveText("最近文件");
  await expect(page.locator("#file-list")).toHaveAttribute(
    "aria-label",
    "最近文件列表",
  );
  await expect(page.locator(".file-name")).toHaveText(["项目笔记.md"]);
  await files(page).click();
  await expect(page.locator(".file-item")).toHaveCount(12);
  await openItem(
    page.getByRole("button", { name: "预览 阅读清单.txt", exact: true }),
  );
  await page.getByRole("button", { name: "关闭预览" }).click();
  await home(page).click();
  await expect(page.locator(".file-name")).toHaveText([
    "阅读清单.txt",
    "项目笔记.md",
  ]);
  await expect(listingOptionsButton(page)).toHaveCount(0);
  await page.getByRole("searchbox").fill("山间");
  await expect(page.locator(".file-item")).toHaveCount(0);
  await expect(page.locator(".file-section-title")).toHaveText("最近文件");
  await expect(page.locator(".empty-state")).toContainText(
    "没有找到匹配的文件",
  );
  await expect(listingOptionsButton(page)).toHaveCount(0);
  await page
    .locator(".empty-state")
    .getByRole("button", { name: "清除搜索" })
    .click();
  await page.reload();
  await expect(page.locator(".file-name")).toHaveText([
    "阅读清单.txt",
    "项目笔记.md",
  ]);
  await files(page).click();
  await expect(page.locator(".file-item")).toHaveCount(12);
  await chooseListingOption(page, "大小");
  await home(page).click();
  await expect(page.locator(".file-name")).toHaveText([
    "阅读清单.txt",
    "项目笔记.md",
  ]);
  await expect(listingOptionsButton(page)).toHaveCount(0);
});

test("Home and Files headers have no divider above their collection cards", async ({
  page,
}) => {
  const headerRow = page.locator(
    isCompact(page) ? ".mobile-home-search,.mobile-file-tools" : ".topbar",
  );
  await expect(headerRow).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".category-cards")).toHaveCSS(
    "border-top-width",
    "0px",
  );
  await files(page).click();
  await expect(headerRow).toHaveCSS("border-bottom-width", "0px");
});

test("Home search stays 36px tall with and without the clear control after returning", async ({
  page,
}) => {
  for (const returnHome of [false, true]) {
    if (returnHome) {
      await files(page).click();
      await expect(
        page.getByRole("searchbox", { includeHidden: true }),
      ).toHaveCount(0);
      await home(page).click();
    }
    for (const value of ["", "笔记", ""]) {
      await page.getByRole("searchbox").fill(value);
      await expect(page.locator(".search-box")).toHaveCSS("height", "36px");
      const box = await page.locator(".search-box").boundingBox();
      expect(box.height).toBe(36);
      if (value) {
        const clear = await page.locator(".search-clear").boundingBox();
        expect(clear.y).toBeGreaterThanOrEqual(box.y);
        expect(clear.y + clear.height).toBeLessThanOrEqual(box.y + box.height);
      }
    }
  }
});

test("mobile Files search opens from the header, focuses and survives query reloads", async ({
  page,
}, testInfo) => {
  test.skip(!isCompact(page), "Mobile Files search");
  await files(page).click();
  const header = page.locator(".topbar");
  await expect(header.locator(".mobile-brand")).toHaveText("文件");
  await expect(header.getByRole("link", { name: "LanternDock" })).toHaveCount(
    0,
  );
  const searchButton = header.getByRole("button", {
    name: "搜索文件",
    exact: true,
  });
  const closeSearch = header.getByRole("button", {
    name: "关闭搜索",
    exact: true,
  });
  await expect(searchButton).toHaveAttribute("aria-expanded", "false");
  const searchBounds = await searchButton.boundingBox();
  const menuBounds = await listingOptionsButton(header).boundingBox();
  expect(menuBounds.x - (searchBounds.x + searchBounds.width)).toBe(4);
  const tools = page.locator(".mobile-file-tools");
  const toolsBounds = await tools.boundingBox();
  const contentY = (await page.locator(".content").boundingBox()).y;
  expect(toolsBounds.height).toBe(40);
  await searchButton.tap();
  const search = page.getByRole("searchbox");
  await expect(search).toBeFocused();
  await expect(page.getByRole("navigation", { name: "文件路径" })).toHaveCount(
    0,
  );
  expect(await tools.boundingBox()).toEqual(toolsBounds);
  expect((await page.locator(".content").boundingBox()).y).toBe(contentY);
  await expect(closeSearch).toHaveAttribute("aria-expanded", "true");
  await search.fill("照片");
  await expect(page.locator(".file-item")).toHaveCount(1);
  await page.reload();
  await expect(search).toBeVisible();
  await expect(search).toHaveValue("照片");
  await expect(search).not.toBeFocused();
  await expect(page.locator(".file-item")).toHaveCount(1);
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await expect(search).toBeFocused();
  await expect(page.locator(".file-item")).toHaveCount(12);
  await expect(page.locator(".search-box")).toHaveCSS("height", "36px");
  const field = await page.locator(".search-box").boundingBox();
  expect(field.y).toBe(toolsBounds.y + 2);
  expect(await tools.boundingBox()).toEqual(toolsBounds);
  expect((await page.locator(".content").boundingBox()).y).toBe(contentY);
  expect(
    await tools.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("files-search.png") });
  await search.fill("照片");
  await header.locator(".mobile-brand").click();
  await expect(search).toBeVisible();
  await expect(search).toHaveValue("照片");
  await closeSearch.tap();
  await expect(search).toHaveCount(0);
  await expect(searchButton).toBeFocused();
  await expect(
    page.getByRole("navigation", { name: "文件路径" }),
  ).toBeVisible();
  expect(await tools.boundingBox()).toEqual(toolsBounds);
  expect((await page.locator(".content").boundingBox()).y).toBe(contentY);
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.locator(".file-item")).toHaveCount(12);
  await searchButton.tap();
  await expect(search).toHaveValue("");
  await search.fill("照片");
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(searchButton).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.locator(".file-item")).toHaveCount(12);
  await openItem(
    page.getByRole("button", { name: "打开文件夹 照片", exact: true }),
  );
  await expect(search).toHaveCount(0);
  await searchButton.tap();
  await expect(search).toBeFocused();
  await home(page).click();
  await expect(header.locator(".mobile-brand")).toHaveText("LanternDock");
  await files(page).click();
  await expect(search).toHaveCount(0);
});

test("mobile headers keep page titles and listing actions without a navigation drawer", async ({
  page,
}) => {
  for (const destination of [home(page), files(page)]) {
    await destination.click();
    const header = page.locator(".topbar");
    await expect(
      header.getByRole("link", {
        name: "我的账户",
        exact: true,
        includeHidden: true,
      }),
    ).toHaveCount(0);
    await expect(header.locator(".account-entry")).toHaveCount(0);
    await expect(
      header.getByRole("button", { name: "连接设置", includeHidden: true }),
    ).toHaveCount(0);
    if (isCompact(page)) {
      await expect(header).toHaveCSS("display", "flex");
      await expect(listingOptionsButton(header)).toBeVisible();
      await expect(page.locator("#sidebar,#navigation-toggle")).toHaveCount(0);
    }
    expect(
      await header.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  }
  await page.evaluate(() =>
    localStorage.setItem(
      "lantern-dock:demo::/:recent",
      JSON.stringify([
        {
          path: "/%E9%A1%B9%E7%9B%AE%E7%AC%94%E8%AE%B0.md",
          name: "项目笔记.md",
          kind: "text",
          isDirectory: false,
          size: 1248,
          visitedAt: Date.now(),
        },
      ]),
    ),
  );
  await page.reload();
  await home(page).click();
  await expect(page.locator("#file-list .file-name")).toHaveText([
    "项目笔记.md",
  ]);
  const recentHeader = page.locator(".topbar");
  await expect(listingOptionsButton(recentHeader)).toHaveCount(0);
  if (isCompact(page)) {
    await expect(recentHeader).toHaveCSS("display", "flex");
  }
});

test("desktop account entry opens a keyboard-accessible account and settings menu", async ({
  page,
}) => {
  test.skip(isCompact(page), "Desktop sidebar account entry");
  const trigger = page.locator("#account-menu-trigger");
  const menu = page.getByRole("menu", { name: /^我的账户(?: · .+)?$/ });
  const account = menu.getByRole("menuitem", {
    name: "我的账户",
    exact: true,
  });
  const settings = menu.getByRole("menuitem", {
    name: "连接设置",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("data-placement", "top");
  await expect(account).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(settings).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(account).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/account$/);
});

test("mobile home card is edge-to-edge, fills the screen and grows with its contents without negative margins", async ({
  page,
}, testInfo) => {
  test.skip(!isCompact(page), "Mobile card layout");
  // One recent file exercises the otherwise empty space below short lists.
  await openItem(
    page.getByRole("button", { name: "预览 项目笔记.md", exact: true }),
  );
  await page.getByRole("button", { name: "关闭预览" }).click();
  const inspect = () =>
    page.locator(".home-content").evaluate((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        left: box.left,
        right: box.right,
        bottom: box.bottom,
        width: innerWidth,
        viewportHeight: innerHeight,
        height: box.height,
        background: style.backgroundColor,
        radii: [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomLeftRadius,
          style.borderBottomRightRadius,
        ],
        margins: [
          style.marginTop,
          style.marginRight,
          style.marginBottom,
          style.marginLeft,
        ].map(parseFloat),
        overflow: [
          document.documentElement,
          node,
          ...node.querySelectorAll(".file-toolbar,.file-open"),
        ]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.className),
      };
    });
  const short = await inspect();
  expect(short.left).toBe(0);
  expect(short.right).toBe(short.width);
  expect(short.bottom).toBeGreaterThanOrEqual(short.viewportHeight);
  expect(short.background).toBe("rgb(255, 255, 255)");
  expect(short.radii).toEqual(["20px", "20px", "0px", "0px"]);
  expect(short.margins.every((value) => value >= 0)).toBe(true);
  expect(short.overflow).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("home-recent.png"),
    fullPage: false,
  });
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.endsWith(":recent"),
    );
    const first = JSON.parse(localStorage.getItem(key))[0];
    localStorage.setItem(
      key,
      JSON.stringify(
        Array.from({ length: 30 }, (_, index) => ({
          ...first,
          path: `/note-${index}.md`,
          name: `笔记 ${index}.md`,
          visitedAt: Date.now() - index,
        })),
      ),
    );
  });
  await page.reload();
  await expect(page.locator(".file-item")).toHaveCount(30);
  const long = await inspect();
  expect(long.height).toBeGreaterThan(short.height);
  expect(long.overflow).toEqual([]);
});

test("file sections omit the toolbar and counts, with balanced recent title and full-width selection", async ({
  page,
}, testInfo) => {
  await expect(
    page.locator(
      ".file-toolbar,.file-stats,#item-count,.nav-count,.file-section-title",
    ),
  ).toHaveCount(0);
  await page.evaluate(() =>
    localStorage.setItem(
      "lantern-dock:demo::/:recent",
      JSON.stringify([
        {
          name: "项目笔记.md",
          path: "/项目笔记.md",
          kind: "text",
          isDirectory: false,
          size: 1248,
          visitedAt: Date.now(),
        },
      ]),
    ),
  );
  await page.reload();
  const title = page.getByRole("heading", { name: "最近文件", exact: true });
  await expect(title).toBeVisible();
  const metrics = await title.evaluate((node) => {
    const card = node.closest(".collection-card").getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      top: rect.top - card.top,
      left: rect.left - card.left + parseFloat(style.paddingLeft),
      right: card.right - rect.right + parseFloat(style.paddingRight),
      height: rect.height,
      line: parseFloat(style.lineHeight),
      size: style.fontSize,
      weight: style.fontWeight,
    };
  });
  expect(metrics).toEqual({
    top: 16,
    left: 16,
    right: 16,
    height: 24,
    line: 24,
    size: "16px",
    weight: "600",
  });
  await page.locator("#file-list .file-open").first().focus();
  await page.keyboard.press("Space");
  const toolbar = page.getByRole("toolbar", {
    name: "所选项目操作",
    exact: true,
  });
  await expect(toolbar).toBeVisible();
  expect(
    await toolbar.evaluate((node) => !!node.closest(".browser-header")),
  ).toBe(true);
  const edges = await page
    .locator("#file-list .file-item[data-selected=true]")
    .evaluate((node) => {
      const row = node.getBoundingClientRect(),
        card = node.closest(".collection-card").getBoundingClientRect();
      return {
        left: row.left - card.left,
        right: card.right - row.right,
        padding: getComputedStyle(node.querySelector("button")).paddingLeft,
      };
    });
  expect(edges).toEqual({ left: 0, right: 0, padding: "16px" });
  expect(
    await page
      .locator(".browser-header")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await expect(
    page.locator(
      ".file-toolbar,.file-stats,#item-count,.nav-count,.selection-panel",
    ),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("recent-section.png") });
  await toolbar.getByRole("button", { name: "取消选择", exact: true }).click();
  await expect(toolbar).toHaveCount(0);
});
