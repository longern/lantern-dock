import { isCompact, isPhone } from "../helpers/responsive.mjs";
import {
  albumOptionsButton,
  albumOptionsMenu,
  openAlbumOptions,
  chooseAlbumView,
  refreshAlbum,
} from "../helpers/album-options.mjs";
import { openItem } from "../helpers/open-item.mjs";
import { flipAlbum } from "../helpers/album-navigation.mjs";
import { holdItem } from "../helpers/hold-item.mjs";
import { mainNavigation } from "../helpers/navigation.mjs";
import { chooseListingOption } from "../helpers/listing-options.mjs";
import { listingOptionsButton } from "../helpers/listing-options.mjs";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ timezoneId: "Asia/Shanghai" });
const thumbnail = await readFile(
  new URL("../fixtures/album-thumbnail.jpg", import.meta.url),
);
const videoBytes = await readFile(
  new URL("../fixtures/video.mp4", import.meta.url),
);
const videoRequests = new WeakMap();
const photos = [
  ...Array.from({ length: 6 }, (_, index) => ({
    name: `today-${index}.png`,
    modified: `2026-11-07T${String(15 - index).padStart(2, "0")}:00:00+08:00`,
  })),
  { name: "yesterday-early.png", modified: "2026-11-06T09:00:00+08:00" },
  { name: "yesterday-late.png", modified: "2026-11-06T22:00:00+08:00" },
  { name: "older.png", modified: "2026-11-03T10:00:00+08:00" },
  { name: "last-year.png", modified: "2025-11-03T10:00:00+08:00" },
  { name: "missing-date.png", modified: "" },
  { name: "invalid-date.png", modified: "invalid" },
  { name: "clip.mp4", modified: "2026-11-07T14:30:00+08:00" },
  { name: "undated.mp4", modified: "" },
];
const labels = ["今天", "昨天", "11月3日", "2025年11月3日", "日期未知"];
const album = (page) =>
  page
    .getByRole("navigation", { name: "文件分类", exact: true })
    .getByRole("button", { name: "相册", exact: true });
const albumSurface = (page) =>
  page.locator(isCompact(page) ? "#album-page-dialog" : ".main-area");
function listing(items) {
  const responses = items
    .map(
      ({ name, modified }) => `<d:response><d:href>/dav/${name}</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1024</d:getcontentlength>
    <d:getlastmodified>${modified}</d:getlastmodified><d:getcontenttype>${name.endsWith(".mp4") ? "video/mp4" : "image/png"}</d:getcontenttype>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
    )
    .join("");
  return `<d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`;
}

async function replaceListing(page, items) {
  await page.route("**/dav/**", (route) =>
    route.request().method() === "PROPFIND"
      ? route.fulfill({
          status: 207,
          contentType: "application/xml",
          body: listing(items),
        })
      : route.fallback(),
  );
  await refreshAlbum(albumSurface(page));
}

test.beforeEach(async ({ page }) => {
  const requests = [];
  videoRequests.set(page, requests);
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname.startsWith("/dav/") &&
      request.url().endsWith(".mp4")
    )
      requests.push(request.url());
  });
  await page.clock.setFixedTime(new Date("2026-11-07T12:00:00+08:00"));
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        backend: {
          name: "Photo dates fixture",
          transport: "http",
          endpoint: "http://127.0.0.1:8788",
          rootPath: "/dav/",
          auth: "none",
          certificates: [],
        },
      },
    }),
  );
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({
      json: {
        version: 1,
        services: {
          images: {
            enabled: true,
            protocol: "http://iiif.io/api/image",
            version: 3,
            href: "/api/iiif/3",
          },
        },
      },
    }),
  );
  await page.route("**/api/iiif/3/**", (route) => {
    const url = route.request().url();
    return url.endsWith("/info.json")
      ? route.fulfill({
          json: {
            id: url.slice(0, -"/info.json".length),
            type: "ImageService3",
            protocol: "http://iiif.io/api/image",
            profile: "level0",
            width: 2400,
            height: 1600,
            sizes: [{ width: 384, height: 256 }],
          },
        })
      : route.fulfill({ contentType: "image/jpeg", body: thumbnail });
  });
  await page.route("**/dav/**", (route) => {
    if (
      route.request().method() === "GET" &&
      route.request().url().endsWith(".mp4")
    ) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(
        route.request().headers().range || "",
      );
      if (!range)
        return route.fulfill({ contentType: "video/mp4", body: videoBytes });
      const start = Number(range[1]);
      const end = Math.min(
        Number(range[2] || videoBytes.length - 1),
        videoBytes.length - 1,
      );
      if (start >= videoBytes.length)
        return route.fulfill({
          status: 416,
          headers: { "Content-Range": `bytes */${videoBytes.length}` },
        });
      return route.fulfill({
        status: 206,
        contentType: "video/mp4",
        body: videoBytes.subarray(start, end + 1),
        headers: {
          "Content-Range": `bytes ${start}-${end}/${videoBytes.length}`,
          "Accept-Ranges": "bytes",
        },
      });
    }
    if (route.request().method() !== "PROPFIND")
      return route.fulfill({ contentType: "image/jpeg", body: thumbnail });
    return route.fulfill({
      status: 207,
      contentType: "application/xml",
      body: listing(photos),
    });
  });
  await page.goto("/");
  await expect(page.locator(".file-item")).toHaveCount(14);
  await album(page).click();
  await expect(albumSurface(page).locator("#file-list")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(
    albumSurface(page).getByRole("searchbox", { includeHidden: true }),
  ).toHaveCount(0);
});

test("photos form dated groups with real thumbnails and responsive edge-to-edge columns", async ({
  page,
}, testInfo) => {
  await expect(page.locator(".album-date")).toHaveText(labels);
  await expect(page.locator(".album-group")).toHaveCount(5);
  await expect(
    page.locator(".album-group").nth(0).locator(".album-item"),
  ).toHaveCount(7);
  await expect(
    page.locator(".album-group").first().getByRole("button").nth(1),
  ).toHaveAttribute("aria-label", "预览视频 clip.mp4");
  await expect(
    page.locator(".album-group").nth(1).getByRole("button"),
  ).toHaveCount(2);
  await expect(
    page.locator(".album-group").nth(1).getByRole("button").first(),
  ).toHaveAttribute("aria-label", "预览 yesterday-late.png");
  await expect(
    page
      .getByRole("region", { name: "日期未知", exact: true })
      .getByRole("button", { name: "预览视频 undated.mp4", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("按修改日期 · 新到旧", { exact: true }),
  ).toHaveCount(0);
  await expect(listingOptionsButton(albumSurface(page))).toHaveCount(0);
  await expect(albumOptionsButton(albumSurface(page))).toHaveCount(1);
  await expect(
    albumSurface(page).getByRole("button", { name: "刷新目录", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator("#file-list .file-info,#file-list .favorite-button"),
  ).toHaveCount(0);
  const first = page.locator(".album-preview").first();
  await expect(first.locator("img")).toBeVisible();
  await expect
    .poll(() => first.locator("img").evaluate((image) => image.naturalWidth))
    .toBe(384);
  for (const grid of await page.locator(".album-layout").all())
    await expect(grid).toHaveCSS("gap", "4px");
  if (isCompact(page))
    await albumSurface(page).evaluate(async (node) => {
      await Promise.all(
        node
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
  const boxes = await page
    .locator(".album-group")
    .first()
    .locator(".album-preview")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  expect(boxes.every((box) => Math.abs(box.width - box.height) < 1)).toBe(true);
  if (isCompact(page)) {
    expect(boxes[0].x).toBe(0);
    const columns = isPhone(page) ? 4 : 6;
    expect(
      Math.abs(
        boxes[columns - 1].x +
          boxes[columns - 1].width -
          page.viewportSize().width,
      ),
    ).toBeLessThan(1);
    expect(boxes.slice(0, columns).every((box) => box.y === boxes[0].y)).toBe(
      true,
    );
    expect(
      Math.abs(boxes[columns].y - boxes[0].y - boxes[0].height - 4),
    ).toBeLessThan(1);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("album-date-groups.png"),
    fullPage: true,
  });
});

test("refreshed listings prune empty groups and preview closes back to the same photo", async ({
  page,
}) => {
  await replaceListing(
    page,
    photos.filter(({ name }) => name.startsWith("yesterday")),
  );
  await expect(page.locator(".album-date")).toHaveText(["昨天"]);
  const photo = albumSurface(page).getByRole("button", {
    name: "预览 yesterday-late.png",
    exact: true,
  });
  await photo.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".album-media[data-current=true] img").first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#album-viewer")).toHaveCount(0);
  await expect(photo).toBeFocused();
  await replaceListing(page, []);
  await expect(page.locator(".album-group")).toHaveCount(0);
  await expect(
    albumSurface(page).getByRole("heading", { name: "暂无照片", exact: true }),
  ).toBeVisible();
  await expect(
    albumSurface(page).getByRole("searchbox", { includeHidden: true }),
  ).toHaveCount(0);
  await expect(
    albumSurface(page).getByRole("button", { name: "清除搜索", exact: true }),
  ).toHaveCount(0);
  await replaceListing(page, photos);
  await expect(page.locator(".album-date")).toHaveText(labels);
});

test("relative date headings update when returning after midnight", async ({
  page,
}) => {
  await expect(page.locator(".album-date")).toHaveText(labels);
  await page.clock.setFixedTime(new Date("2026-11-08T08:00:00+08:00"));
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.locator(".album-date")).toHaveText([
    "昨天",
    "11月6日",
    ...labels.slice(2),
  ]);
});

test("after the year changes every earlier date heading includes its year", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2027-01-01T08:00:00+08:00"));
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.locator(".album-date")).toHaveText([
    "2026年11月7日",
    "2026年11月6日",
    "2026年11月3日",
    "2025年11月3日",
    "日期未知",
  ]);
});

test("refresh moves photos into their updated date groups without duplicates", async ({
  page,
}) => {
  const updated = photos.map((item) =>
    item.name === "today-0.png"
      ? { ...item, modified: "2026-11-06T23:00:00+08:00" }
      : item.name === "missing-date.png"
        ? { ...item, modified: "2026-11-07T09:30:00+08:00" }
        : item,
  );
  await page.route("**/dav/**", (route) =>
    route.request().method() === "PROPFIND"
      ? route.fulfill({
          status: 207,
          contentType: "application/xml",
          body: listing(updated),
        })
      : route.fallback(),
  );
  await refreshAlbum(albumSurface(page));
  const yesterday = page.getByRole("region", { name: "昨天", exact: true });
  await expect(yesterday.getByRole("button")).toHaveCount(3);
  await expect(yesterday.getByRole("button").first()).toHaveAttribute(
    "aria-label",
    "预览 today-0.png",
  );
  await expect(
    page
      .getByRole("region", { name: "今天", exact: true })
      .getByRole("button", { name: "预览 missing-date.png", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "日期未知", exact: true })
      .getByRole("button"),
  ).toHaveCount(2);
  await expect(page.locator(".album-item")).toHaveCount(14);
});

test("a video-only album opens the existing player without autoplay and restores focus", async ({
  page,
}) => {
  await replaceListing(
    page,
    photos.filter(({ name }) => name === "clip.mp4"),
  );
  await expect(page.locator(".album-date")).toHaveText(["今天"]);
  await expect(page.locator(".album-item")).toHaveCount(1);
  await expect(page.locator(".album-video-indicator")).toHaveCount(1);
  await expect(page.locator("#file-list video")).toHaveCount(0);
  const open = page.getByRole("button", {
    name: "预览视频 clip.mp4",
    exact: true,
  });
  await expect(open.locator(".thumbnail-slot img")).toBeVisible();
  expect(videoRequests.get(page)).toHaveLength(0);
  await open.focus();
  await page.keyboard.press("Enter");
  const video = page.locator("#album-viewer video");
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((node) => node.readyState))
    .toBeGreaterThanOrEqual(1);
  expect(
    await video.evaluate((node) => ({
      paused: node.paused,
      autoplay: node.autoplay,
      controls: node.controls,
    })),
  ).toEqual({ paused: true, autoplay: false, controls: false });
  await video.evaluate((node) => {
    node.muted = true;
    return node.play();
  });
  await expect
    .poll(() => video.evaluate((node) => node.currentTime))
    .toBeGreaterThan(0.2);
  await page.keyboard.press("Escape");
  await expect(page.locator("#album-viewer")).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(page.locator(".album-item")).toHaveCount(1);
});

test("unavailable video posters stay playable placeholders without eager original reads", async ({
  page,
}) => {
  let failedPosterRequests = 0;
  await page.route("**/api/iiif/3/**", async (route) => {
    await route.fulfill({ status: 415 });
    if (route.request().url().includes("/Y2xpcC5tcDQ/")) failedPosterRequests++;
  });
  await replaceListing(
    page,
    photos.filter(({ name }) => name === "clip.mp4"),
  );
  const open = page.getByRole("button", {
    name: "预览视频 clip.mp4",
    exact: true,
  });
  await expect.poll(() => failedPosterRequests).toBeGreaterThan(0);
  await expect(open.locator(".thumbnail-slot img")).toHaveCount(0);
  await expect(open.locator(".thumbnail-slot svg")).toBeVisible();
  await expect(open.locator(".album-video-indicator")).toBeVisible();
  expect(videoRequests.get(page)).toHaveLength(0);
});

test("video-only albums are not empty, while truly empty albums have no date groups", async ({
  page,
}) => {
  let items = photos.filter(({ name }) => name === "clip.mp4");
  await page.route("**/dav/**", (route) =>
    route.request().method() === "PROPFIND"
      ? route.fulfill({
          status: 207,
          contentType: "application/xml",
          body: listing(items),
        })
      : route.fallback(),
  );
  await refreshAlbum(albumSurface(page));
  await expect(page.locator(".album-item")).toHaveCount(1);
  await expect(page.locator(".album-date")).toHaveText(["今天"]);
  await expect(page.locator(".empty-state")).toHaveCount(0);
  items = [];
  await refreshAlbum(albumSurface(page));
  await expect(page.locator(".album-group,.album-item")).toHaveCount(0);
  await expect(
    albumSurface(page).getByRole("heading", { name: "暂无照片", exact: true }),
  ).toBeVisible();
});

test("separate sidebar image and video filters do not mix file types", async ({
  page,
}) => {
  test.skip(
    isCompact(page),
    "Dedicated sidebar filters are desktop only; mobile uses Home categories",
  );
  for (const [label, count] of [
    ["图片", 12],
    ["视频", 2],
  ]) {
    await page
      .getByRole("navigation", { name: "文件类型", exact: true })
      .getByRole("button", { name: label, exact: true })
      .click();
    await expect(page.locator(".filter-chip")).toHaveCount(0);
    await expect(page.locator(".file-item")).toHaveCount(count);
    await expect(page.locator(".album-video-indicator")).toHaveCount(0);
    if (label === "图片")
      await expect(page.locator(".album-item")).toHaveCount(12);
    else
      await expect(page.locator(".file-name")).toHaveText([
        "clip.mp4",
        "undated.mp4",
      ]);
  }
});

test("a failed refresh preserves the date groups and offers retry below them", async ({
  page,
}) => {
  const scope = albumSurface(page);
  const groups = scope.locator(".album-date");
  const dates = await groups.allTextContents();
  await page.route("**/dav/**", (route) => route.fulfill({ status: 503 }));
  await refreshAlbum(scope);
  const footer = scope.locator(".album-paging");
  await expect(
    footer.getByText("暂时无法更新照片。", { exact: true }),
  ).toBeVisible();
  await expect(footer.getByRole("button", { name: "重试" })).toBeVisible();
  await expect(groups).toHaveText(dates);
  await expect(scope.locator(".album-item")).toHaveCount(14);
  await expect(scope.locator("#file-list")).toHaveAttribute(
    "aria-busy",
    "false",
  );
});

test("album menu switches to a continuous chronological grid and keeps viewer order", async ({
  page,
}, testInfo) => {
  const scope = albumSurface(page);
  const before = await page
    .locator(".album-preview")
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.path));
  let listings = 0;
  page.on("request", (request) => {
    if (request.method() === "PROPFIND") listings++;
  });
  const menu = await openAlbumOptions(scope);
  await expect(
    menu.getByRole("menuitemradio", { name: "按日期分组", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    menu.getByRole("menuitem", { name: "刷新", exact: true }),
  ).toBeEnabled();
  await menu.locator(".listing-options-surface").evaluate(async (node) => {
    await Promise.all(
      node
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path: testInfo.outputPath("album-options.png") });
  await menu
    .getByRole("menuitemradio", { name: "连续排列", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".album-date,.album-group")).toHaveCount(0);
  await expect(page.locator(".album-layout")).toHaveCount(1);
  expect(
    await page
      .locator(".album-preview")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.path)),
  ).toEqual(before);
  expect(listings).toBe(0);
  await expect(page.locator(".album-item")).toHaveCount(14);
  await page.screenshot({ path: testInfo.outputPath("album-continuous.png") });
  await openItem(
    scope.getByRole("button", { name: "预览 today-0.png", exact: true }),
  );
  await expect(page.locator("#album-viewer-name")).toHaveText("today-0.png");
  await flipAlbum(page, 1);
  await expect(page.locator("#album-viewer-name")).toHaveText("clip.mp4");
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(page.locator("#album-viewer")).toHaveCount(0);
  await chooseAlbumView(scope, "按日期分组");
  await expect(page.locator(".album-date")).toHaveText(labels);
  expect(
    await page
      .locator(".album-preview")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.path)),
  ).toEqual(before);
});

test("album view is retained when returning and is independent of the file list view", async ({
  page,
}) => {
  await chooseAlbumView(albumSurface(page), "连续排列");
  if (isCompact(page)) await page.locator("#album-back").click();
  else
    await mainNavigation(page)
      .getByRole("button", { name: "首页", exact: true })
      .click();
  await expect(page.locator("#album-page-dialog")).toHaveCount(0);
  await mainNavigation(page).getByRole("button", { name: /^文件/ }).click();
  await expect(page.locator("#file-list")).toHaveClass(/list-layout/);
  await chooseListingOption(page, "网格视图");
  await mainNavigation(page)
    .getByRole("button", { name: "首页", exact: true })
    .click();
  await album(page).click();
  await expect(page.locator(".album-date")).toHaveCount(0);
  await expect(page.locator(".album-layout")).toHaveCount(1);
  const menu = await openAlbumOptions(albumSurface(page));
  await expect(
    menu.getByRole("menuitemradio", { name: "连续排列", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await menu.press("Escape");
  if (isCompact(page)) await page.locator("#album-back").click();
  else
    await mainNavigation(page)
      .getByRole("button", { name: "首页", exact: true })
      .click();
  await mainNavigation(page).getByRole("button", { name: /^文件/ }).click();
  await expect(page.locator("#file-list")).not.toHaveClass(/list-layout/);
});

test("refresh is a menu action and keyboard navigation skips it while loading", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/dav/**", async (route) => {
    if (route.request().method() !== "PROPFIND") return route.fallback();
    requested = true;
    await gate;
    return route
      .fulfill({
        status: 207,
        contentType: "application/xml",
        body: listing(photos),
      })
      .catch(() => {});
  });
  try {
    const scope = albumSurface(page);
    let menu = await openAlbumOptions(scope);
    await menu.press("End");
    await expect(
      menu.getByRole("menuitem", { name: "刷新", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => requested).toBe(true);
    await expect(menu).toHaveCount(0);
    menu = await openAlbumOptions(scope);
    await expect(
      menu.getByRole("menuitem", { name: "正在查找新照片", exact: true }),
    ).toBeDisabled();
    await menu.press("End");
    await expect(
      menu.getByRole("menuitemradio", { name: "连续排列", exact: true }),
    ).toBeFocused();
    await menu.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(albumOptionsButton(scope)).toBeFocused();
    if (isCompact(page)) await expect(scope).toBeVisible();
  } finally {
    release();
  }
  await expect(albumSurface(page).locator("#file-list")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(albumSurface(page).locator(".album-item")).toHaveCount(14);
});

test("changing the album view preserves the selected files", async ({
  page,
}) => {
  const scope = albumSurface(page);
  const first = scope.locator(".album-preview").first();
  const path = await first.getAttribute("data-path");
  if (isCompact(page)) await holdItem(page, first);
  else await first.click({ modifiers: ["ControlOrMeta"] });
  await expect(scope.locator(".album-item[data-selected=true]")).toHaveCount(1);
  await chooseAlbumView(scope, "连续排列");
  await expect(scope.locator(".album-item[data-selected=true]")).toHaveCount(1);
  await expect(
    scope.locator(".album-item[data-selected=true] .album-preview"),
  ).toHaveAttribute("data-path", path);
  await chooseAlbumView(scope, "按日期分组");
  await expect(
    scope.locator(".album-item[data-selected=true] .album-preview"),
  ).toHaveAttribute("data-path", path);
});
