import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openItem } from "../helpers/open-item.mjs";
import { searchNamespace } from "../../src/lib/search.js";
import { isCompact } from "../helpers/responsive.mjs";
import {
  albumOptionsButton,
  openAlbumOptions,
  refreshAlbum,
} from "../helpers/album-options.mjs";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
});
const picture = await readFile(
  new URL("../fixtures/album-thumbnail.jpg", import.meta.url),
);
const escape = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const photos = Array.from({ length: 180 }, (_, index) => ({
  path: `/dav/2026/trip/day-${index % 3}/photo-${String(index).padStart(3, "0")}.jpg`,
  modified: new Date(Date.UTC(2026, 10, 9, 12) - index * 60000).toUTCString(),
}));
const response = (item) =>
  `<d:response><d:href>${escape(item.path)}</d:href><d:propstat><d:prop><d:resourcetype>${item.directory ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${picture.length}</d:getcontentlength><d:getcontenttype>${item.directory ? "httpd/unix-directory" : "image/jpeg"}</d:getcontenttype><d:getlastmodified>${item.modified || photos[0].modified}</d:getlastmodified><d:getetag>"${item.path}"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

async function install(page, options = {}) {
  const state = {
    supported: true,
    extended: true,
    status: "ready",
    revision: "revision-1",
    pageSize: 128,
    expire: false,
    calls: [],
    ...options,
  };
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        backend: {
          transport: "http",
          endpoint: new URL(route.request().url()).origin,
          rootPath: "/dav/",
          auth: "none",
        },
      },
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/dav/**", async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postData() || "";
    state.calls.push({ method, path, body });
    if (method === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          DAV: `1${state.extended ? `, <${searchNamespace}>` : ""}`,
          ...(state.supported ? { DASL: "<DAV:basicsearch>" } : {}),
        },
      });
    if (method === "PROPFIND") {
      const entries = new Map();
      for (const item of [
        ...photos,
        { path: "/dav/root.jpg", modified: photos[0].modified },
      ]) {
        if (!item.path.startsWith(path)) continue;
        const relative = item.path.slice(path.length);
        const slash = relative.indexOf("/");
        const result =
          slash < 0
            ? item
            : { path: path + relative.slice(0, slash + 1), directory: true };
        entries.set(result.path, result);
      }
      return route.fulfill({
        status: 207,
        contentType: "application/xml",
        body: `<d:multistatus xmlns:d="DAV:">${[...entries.values()].map(response).join("")}</d:multistatus>`,
      });
    }
    if (method === "SEARCH") {
      if (state.blockSearch)
        return route.fulfill({
          status: 405,
          body: "SEARCH not allowed by bridge",
        });
      const cursor = /<l:cursor>([^<]+)<\/l:cursor>/.exec(body)?.[1] || "";
      if (!cursor && state.searchUnavailable)
        return route.fulfill({ status: 503 });
      if (cursor && state.gate) await state.gate;
      if (cursor && state.expire) {
        state.expire = false;
        state.revision = "revision-2";
        return route.fulfill({
          status: 409,
          contentType: "application/xml",
          body: `<d:error xmlns:d="DAV:" xmlns:l="${searchNamespace}"><l:valid-cursor/></d:error>`,
        });
      }
      const offset = cursor ? Number(cursor.split("-").at(-1)) : 0;
      const source = (
        state.results ?? (state.status === "ready" ? photos : [])
      ).filter((item) => item.path.startsWith(path));
      const items = source.slice(offset, offset + state.pageSize);
      const more = offset + state.pageSize < source.length;
      return route.fulfill({
        status: 207,
        contentType: "application/xml",
        body: `<d:multistatus xmlns:d="DAV:" xmlns:l="${searchNamespace}">${items.map(response).join("")}${more || state.status === "scanning" ? `<d:response><d:href>${path}</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>` : ""}${state.extended && more ? `<l:next-cursor>page-${offset + state.pageSize}</l:next-cursor>` : ""}${state.extended ? `<l:index-state><l:status>${state.status}</l:status><l:revision>${state.revision}</l:revision></l:index-state>` : ""}</d:multistatus>`,
      });
    }
    return route.fulfill({ contentType: "image/jpeg", body: picture });
  });
  return state;
}
const albumScope = (page) =>
  isCompact(page)
    ? page.locator("#album-page-dialog")
    : page.locator(".main-area");
const items = (page) => albumScope(page).locator(".album-item");

test("recursive SEARCH pages load on scroll and ordinary file listings stay shallow", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/album/");
  await expect(items(page)).toHaveCount(128);
  expect(state.calls.filter((call) => call.method === "SEARCH")).toHaveLength(
    1,
  );
  expect(state.calls.some((call) => call.method === "GET")).toBe(false);
  await items(page).last().scrollIntoViewIfNeeded();
  await expect(items(page)).toHaveCount(180);
  expect(
    new Set(
      await items(page)
        .locator("button")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.path)),
    ).size,
  ).toBe(180);
  expect(state.calls.filter((call) => call.method === "SEARCH")).toHaveLength(
    2,
  );
  await refreshAlbum(albumScope(page));
  await expect(albumScope(page).locator("#file-list")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(items(page)).toHaveCount(180);
  await expect(
    page.getByText("当前服务器仅返回了部分照片。", { exact: true }),
  ).toHaveCount(0);
  const queries = state.calls.filter((call) => call.method === "SEARCH").length;
  await page.goto("/files/");
  await expect(page.locator("#file-list .file-item")).toHaveCount(2);
  expect(state.calls.filter((call) => call.method === "SEARCH")).toHaveLength(
    queries,
  );
});

test("folder albums confine recursive results to that subtree", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/album/2026/trip/day-2/");
  await expect(items(page)).toHaveCount(60);
  expect(
    (
      await items(page)
        .locator("button")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.path))
    ).every((path) => path.startsWith("/dav/2026/trip/day-2/")),
  ).toBe(true);
  const call = state.calls.find((call) => call.method === "SEARCH");
  expect(call.body).toContain("<d:href>/dav/2026/trip/day-2/</d:href>");
  expect(call.body).toContain("<d:depth>infinity</d:depth>");
});

test("standard SEARCH without extensions displays partial results without inventing another page", async ({
  page,
}) => {
  const state = await install(page, { extended: false, pageSize: 2 });
  await page.goto("/album/");
  await expect(items(page)).toHaveCount(2);
  await expect(
    page.getByText("当前服务器仅返回了部分照片。", { exact: true }),
  ).toBeVisible();
  expect(state.calls.filter((call) => call.method === "SEARCH")).toHaveLength(
    1,
  );
  expect(state.calls.find((call) => call.method === "SEARCH").body).not.toMatch(
    /<l:(?:cursor|refresh)/,
  );
  await expect(
    page.getByRole("button", { name: "加载更多", exact: true }),
  ).toHaveCount(0);
});

test("plain WebDAV remains usable and index progress does not show an empty-library error", async ({
  page,
}) => {
  await install(page, { supported: false, extended: false });
  await page.goto("/album/");
  await expect(items(page)).toHaveCount(1);
  await expect(
    page.getByText("当前服务器仅支持查看此文件夹中的照片。", { exact: true }),
  ).toBeVisible();
});

test("the first index is polled until ready without reporting no photos", async ({
  page,
}, testInfo) => {
  const state = await install(page, { status: "scanning" });
  await page.goto("/album/");
  const empty = albumScope(page).locator(".empty-state");
  await expect(empty).toHaveText("加载相册中");
  await expect(empty.locator("p")).toHaveCount(0);
  await expect
    .poll(() =>
      empty.evaluate((node) => {
        const heading = node.parentElement.querySelector(".album-heading");
        const dialog = node.closest(".album-page-dialog");
        const header = heading || dialog.querySelector(".page-dialog-header");
        const top = header.getBoundingClientRect().bottom;
        const bottom = dialog?.getBoundingClientRect().bottom ?? innerHeight;
        const spinner = node.querySelector(".page-loading-spinner");
        const title = node.querySelector("h2");
        return Math.abs(
          (spinner.getBoundingClientRect().top +
            title.getBoundingClientRect().bottom -
            top -
            bottom) /
            2,
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  await expect(empty.getByText("暂无照片", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("album-indexing.png") });
  state.status = "ready";
  state.revision = "revision-ready";
  await expect(items(page)).toHaveCount(128, { timeout: 10000 });
  await expect(empty).toHaveCount(0);
});

test("an incomplete index error offers retry without claiming the library is empty", async ({
  page,
}) => {
  const state = await install(page, { status: "error" });
  await page.goto("/album/");
  const empty = albumScope(page).locator(".empty-state");
  await expect(
    empty.getByText("暂时无法读取相册", { exact: true }),
  ).toBeVisible();
  state.status = "ready";
  state.revision = "recovered";
  await empty.getByRole("button", { name: "重试", exact: true }).click();
  await expect(items(page)).toHaveCount(128);
});

test("a background index update is silent and anchors the visible photo across revisions", async ({
  page,
}) => {
  const state = await install(page, { status: "scanning", results: photos });
  const scope = albumScope(page);
  await page.goto("/album/");
  await page.addStyleTag({ content: "* { overflow-anchor: none !important }" });
  await expect(items(page)).toHaveCount(128);
  await items(page).last().scrollIntoViewIfNeeded();
  await expect(items(page)).toHaveCount(180);
  await items(page).nth(140).scrollIntoViewIfNeeded();
  await expect(scope.getByText("加载相册中", { exact: true })).toHaveCount(0);
  await expect(albumOptionsButton(scope)).not.toHaveClass(/album-refreshing/);
  const { path, top } = await scope.locator("#file-list").evaluate((list) => {
    const header = list
      .closest("dialog, .main-area")
      .querySelector(".page-dialog-header, .browser-header");
    const boundary = header.getBoundingClientRect().bottom;
    const photo = [...list.querySelectorAll("button[data-path]")].find(
      (node) => node.getBoundingClientRect().bottom > boundary,
    );
    return { path: photo.dataset.path, top: photo.getBoundingClientRect().top };
  });
  state.results = [
    ...Array.from({ length: 18 }, (_, index) => ({
      path: `/dav/new-${index}.jpg`,
      modified: new Date(Date.UTC(2026, 10, 10)).toUTCString(),
    })),
    ...photos,
  ];
  state.status = "ready";
  state.revision = "updated";
  await expect(items(page)).toHaveCount(198, { timeout: 10000 });
  const anchor = scope.locator(`button[data-path="${path}"]`);
  const updatedTop = await anchor.evaluate(
    (node) => node.getBoundingClientRect().top,
  );
  expect(Math.abs(updatedTop - top)).toBeLessThanOrEqual(1);
});

test("manual refresh stays in the header and a request failure leaves the grid in place", async ({
  page,
}) => {
  const state = await install(page, { results: photos.slice(0, 20) });
  const scope = albumScope(page);
  await page.goto("/album/");
  await expect(items(page)).toHaveCount(20);
  const firstPhotoTop = () =>
    items(page)
      .first()
      .evaluate((node) => node.getBoundingClientRect().top);
  const top = await firstPhotoTop();
  state.status = "scanning";
  await refreshAlbum(scope);
  await expect(albumOptionsButton(scope)).toHaveClass(/album-refreshing/);
  const menu = await openAlbumOptions(scope);
  await expect(
    menu.getByRole("menuitem", { name: "正在查找新照片" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(await firstPhotoTop()).toBe(top);

  state.searchUnavailable = true;
  const footer = scope.locator(".album-paging");
  await expect(
    footer.getByText("暂时无法更新照片。", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(albumOptionsButton(scope)).not.toHaveClass(/album-refreshing/);
  await expect(items(page)).toHaveCount(20);
  expect(await firstPhotoTop()).toBe(top);

  state.searchUnavailable = false;
  state.status = "ready";
  await footer.getByRole("button", { name: "重试", exact: true }).click();
  await expect(footer).toHaveCount(0);
  await expect(items(page)).toHaveCount(20);
  expect(await firstPhotoTop()).toBe(top);
});

test("an older bridge that rejects SEARCH falls back without making the album unusable", async ({
  page,
}) => {
  const state = await install(page, { blockSearch: true });
  await page.goto("/album/");
  await expect(items(page)).toHaveCount(1);
  await expect(
    page.getByText("当前服务器仅支持查看此文件夹中的照片。", { exact: true }),
  ).toBeVisible();
  expect(state.calls.filter((call) => call.method === "SEARCH")).toHaveLength(
    1,
  );
});

test("a current-folder image filter and its viewer never start recursive SEARCH", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/files/?type=image");
  const photo = page.locator(".album-item .file-open");
  await expect(photo).toHaveCount(1);
  await openItem(photo);
  await expect(page.locator("#album-viewer")).toBeVisible();
  expect(state.calls.filter((call) => call.method === "SEARCH")).toHaveLength(
    0,
  );
});

test("an expired cursor preserves visible photos and offers an explicit refresh", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/album/");
  await expect(items(page)).toHaveCount(128);
  state.expire = true;
  await items(page).last().scrollIntoViewIfNeeded();
  await expect(
    page.getByText("图库已更新，请刷新后继续浏览。", { exact: true }),
  ).toBeVisible();
  await expect(items(page)).toHaveCount(128);
  await page
    .locator(".album-paging")
    .getByRole("button", { name: "重试", exact: true })
    .click();
  await expect(
    page.getByText("图库已更新，请刷新后继续浏览。", { exact: true }),
  ).toHaveCount(0);
  await expect(items(page)).toHaveCount(180);
  expect(
    state.calls.some(
      (call) => call.method === "SEARCH" && call.body.includes("<l:refresh/>"),
    ),
  ).toBe(true);
});

test("pages arriving while viewing a photo extend the full-screen gallery", async ({
  page,
}) => {
  const state = await install(page);
  let release;
  state.gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await page.goto("/album/");
    await expect(items(page)).toHaveCount(128);
    await items(page).last().scrollIntoViewIfNeeded();
    await openItem(items(page).last().locator("button"));
    await expect(page.locator("#album-viewer")).toBeVisible();
    release();
    await expect(items(page)).toHaveCount(180);
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/photo-128\.jpg/);
  } finally {
    release();
  }
});
