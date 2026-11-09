import { openItem } from "../helpers/open-item.mjs";
import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { flipAlbum } from "../helpers/album-navigation.mjs";
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
});
const folder = encodeURIComponent("旅行 #?%"),
  name = encodeURIComponent("说明 #?%.txt");
const picture = await readFile(
  new URL("../fixtures/album-thumbnail.jpg", import.meta.url),
);
async function install(page, root = "/dav/") {
  const log = [];
  await page.addInitScript(() => {
    window.copiedLinks = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => window.copiedLinks.push(value) },
    });
  });
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        backend: {
          transport: "http",
          name: "Route fixture",
          endpoint: "http://127.0.0.1:8788",
          rootPath: root,
          auth: "none",
          gatewayAuth: false,
          certificates: [],
        },
      },
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ status: 404, json: { error: "No optional services" } }),
  );
  await page.route("**" + root + "**", (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    log.push({ path, method });
    if (method === "PROPFIND") {
      const entries =
        path === root
          ? [{ path: root + folder + "/", directory: true }]
          : path === root + folder + "/"
            ? [
                { path: root + folder + "/" + name },
                { path: root + folder + "/first.jpg" },
                { path: root + folder + "/last.jpg" },
                { path: root + folder + "/archive.jpg/", directory: true },
              ]
            : [];
      return route.fulfill({
        status: 207,
        contentType: "application/xml",
        body: `<d:multistatus xmlns:d="DAV:">${entries.map((item, index) => `<d:response><d:href>${item.path}</d:href><d:propstat><d:prop><d:resourcetype>${item.directory ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${picture.length}</d:getcontentlength><d:getlastmodified>${new Date(Date.UTC(2026, 10, 9 - index)).toUTCString()}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`,
      });
    }
    return route.fulfill({
      contentType: path.endsWith(".txt") ? "text/plain" : "image/jpeg",
      body: path.endsWith(".txt") ? "A shared document" : picture,
    });
  });
  return log;
}

test("folder navigation, reload, Back and Forward restore the URL's resource", async ({
  page,
}) => {
  await install(page);
  await page.goto("/files/");
  await openItem(page
    .getByRole("button", { name: "打开文件夹 旅行 #?%", exact: true }));
  await expect(page).toHaveURL(new RegExp(`/files/${folder}/$`));
  await page.reload();
  await expect(page.locator("#file-list .file-item")).toHaveCount(4);
  await openItem(page
    .getByRole("button", { name: "预览 说明 #?%.txt", exact: true }));
  await expect(page).toHaveURL(new RegExp(`/files/${folder}/${name}$`));
  await expect(page.locator(".preview-content pre")).toHaveText(
    "A shared document",
  );
  await page.goBack();
  await expect(page.locator("#preview-dialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/files/${folder}/$`));
  await page.goForward();
  await expect(page.locator("#preview-name")).toHaveText("说明 #?%.txt");
  await page.reload();
  await expect(page.locator(".preview-content pre")).toHaveText(
    "A shared document",
  );
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/files/${folder}/$`));
});

test("copied links use the portal and relative paths even with a custom DAV mount", async ({
  page,
}) => {
  const log = await install(page, "/custom/share/");
  await page.goto("/files/");
  const folderItem = page.getByRole("button", { name: "打开文件夹 旅行 #?%", exact: true });
  await folderItem.focus();
  await folderItem.press("Space");
  await page.getByRole("button", { name: "复制所选链接", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.copiedLinks.at(-1)))
    .toBe(`http://127.0.0.1:8788/files/${folder}/`);
  await page.goto(`/files/${folder}/${name}`);
  await expect(page.locator(".preview-content pre")).toHaveText(
    "A shared document",
  );
  await page.getByRole("button", { name: "复制链接", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.copiedLinks.at(-1)))
    .toBe(`http://127.0.0.1:8788/files/${folder}/${name}`);
  expect(
    log.some((item) => item.path === `/custom/share/${folder}/${name}`),
  ).toBe(true);
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/files/${folder}/$`));
});

test("a direct album photo link restores the gallery and paging replaces one preview entry", async ({
  page,
}) => {
  await install(page);
  await page.goto(`/album/${folder}/`);
  const grid =
    page.viewportSize().width <= 700
      ? page.locator("#album-page-dialog")
      : page.locator("#file-list");
  await openItem(grid
    .getByRole("button", { name: "预览 first.jpg", exact: true }));
  await expect(page).toHaveURL(
    new RegExp(`/files/${folder}/first.jpg\\?view=album$`),
  );
  if (page.viewportSize().width <= 700)
    await expect(page.locator(".album-viewer-pager")).toBeHidden();
  else await expect(page.locator(".album-viewer-pager")).toBeVisible();
  await expect(
    page.locator(".album-media[data-current=true] .album-image-high.is-sharp"),
  ).toHaveCSS("opacity", "1");
  const history = await page.evaluate(() => window.history.length);
  await flipAlbum(page);
  await expect(page).toHaveURL(
    new RegExp(`/files/${folder}/last.jpg\\?view=album$`),
  );
  expect(await page.evaluate(() => window.history.length)).toBe(history);
  // Forward during the closing animation must create a fresh media lifetime.
  await page.goBack();
  await page.goForward();
  await expect(page.locator("#album-viewer-name")).toHaveText("last.jpg");
  await expect(
    page.locator(".album-media[data-current=true] .album-image-high.is-sharp"),
  ).toHaveCSS("opacity", "1");
  await page.reload();
  await expect(page.locator("#album-viewer-name")).toHaveText("last.jpg");
  await page.goBack();
  await expect(page.locator("#album-viewer")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/album/${folder}/$`));
});

test("missing resources, directory canonicalization and unknown page paths stay explicit", async ({
  page,
}) => {
  const log = await install(page);
  await page.goto(`/files/${folder}/missing.txt`);
  await expect(page.getByRole("alert")).toContainText("该文件已不存在");
  expect(log.some((item) => item.path.endsWith("missing.txt"))).toBe(false);
  await page.getByRole("button", { name: "返回文件夹", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/files/${folder}/$`));
  await page.goto(`/files/${folder}/archive.jpg`);
  await expect(page).toHaveURL(new RegExp(`/files/${folder}/archive.jpg/$`));
  await page.goto("/not-a-page");
  await expect(
    page.getByRole("heading", { name: "页面不存在", exact: true }),
  ).toBeVisible();
});
