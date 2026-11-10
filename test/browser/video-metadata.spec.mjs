import { isCompact } from "../helpers/responsive.mjs";
import { openItem } from "../helpers/open-item.mjs";
import { test, expect } from "@playwright/test";
import {
  mainNavigation,
  openConnectionSettings,
} from "../helpers/navigation.mjs";
import { tailMoovMP4 } from "../helpers/mp4-fixture.mjs";

async function openFixture(page, fixture) {
  const requests = [];
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        backend: {
          name: "MP4 metadata fixture",
          transport: "http",
          endpoint: "http://127.0.0.1:8788",
          rootPath: "/dav/",
          auth: "none",
          gatewayAuth: false,
          certificates: [],
        },
      },
    }),
  );
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.route("**/dav/**", (route) => {
    const request = route.request();
    if (request.method() === "PROPFIND")
      return route.fulfill({
        status: 207,
        contentType: "application/xml",
        body: `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/metadata.mp4</d:href>
        <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${fixture.size}</d:getcontentlength>
        <d:getcontenttype>video/mp4</d:getcontenttype></d:prop>
        <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
      });
    const headers = request.headers();
    requests.push(headers);
    const match = /^bytes=(\d+)-(\d+)$/.exec(headers.range || "");
    if (!match) return route.fulfill({ status: 400 });
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), fixture.size - 1);
    if (start >= fixture.size) return route.fulfill({ status: 416 });
    return route.fulfill({
      status: 206,
      contentType: "video/mp4",
      body: fixture.read(start, end - start + 1),
      headers: {
        "Content-Range": `bytes ${start}-${end}/${fixture.size}`,
        "Accept-Ranges": "bytes",
        ETag: '"metadata-fixture"',
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "预览 metadata.mp4", exact: true }),
  ).toBeVisible();
  // A synthetic credential forces the same MSE path used by WebTransport,
  // without depending on a real NAS, UDP connection or private credentials.
  await openConnectionSettings(page);
  await page.getByLabel("访问方式", { exact: true }).selectOption("bearer");
  await page.getByLabel("访问令牌", { exact: true }).fill("fixture-only-token");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
  if (isCompact(page))
    await mainNavigation(page)
      .getByRole("button", { name: "首页", exact: true })
      .click();
  await openItem(
    page.getByRole("button", { name: "预览 metadata.mp4", exact: true }),
  );
  return requests;
}

test("QuickTime metadata in MP4 plays, seeks and reopens through MSE", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = await openFixture(
    page,
    tailMoovMP4({ metadataType: "©xyz" }),
  );
  const video = page.locator(".preview-content video");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() => video.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((element) => element.duration)).toBeCloseTo(8, 0);
  expect(
    await video.evaluate((element) => element.paused && !element.autoplay),
  ).toBe(true);
  await video.evaluate((element) => {
    element.muted = true;
    return element.play();
  });
  await expect
    .poll(() => video.evaluate((element) => element.currentTime))
    .toBeGreaterThan(0.2);
  await video.evaluate((element) => {
    element.currentTime = 6;
  });
  await expect
    .poll(() =>
      video.evaluate((element) => !element.seeking && element.currentTime > 6),
    )
    .toBe(true);
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(page.locator("#preview-dialog")).toHaveCount(0);
  const reads = requests.length;
  await openItem(
    page.getByRole("button", { name: "预览 metadata.mp4", exact: true }),
  );
  await expect
    .poll(() => video.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  expect(requests.length).toBeGreaterThan(reads);
  for (const headers of requests) {
    expect(headers.authorization).toBe("Bearer fixture-only-token");
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.range);
    expect(Number(end) - Number(start) + 1).toBeLessThanOrEqual(1024 * 1024);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("#preview-dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const [name, options, message] of [
  ["truncated index", { truncate: 128 }, "无法读取视频索引"],
  [
    "oversized child",
    { mutateMoov: (bytes) => bytes.writeUInt32BE(100 * 1024 * 1024, 8) },
    "视频文件无法解析（MP4Box",
  ],
])
  test(`${name} keeps a useful error and download action`, async ({ page }) => {
    await openFixture(page, tailMoovMP4({ metadataType: "©xyz", ...options }));
    await expect(page.locator(".preview-content [role=status]")).toContainText(
      message,
    );
    await expect(page.locator(".preview-content")).not.toContainText(
      "TypeError",
    );
    await expect(page.locator(".preview-content video")).toBeHidden();
    await expect(
      page
        .locator(".preview-actions")
        .getByRole("button", { name: "下载", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await expect(page.locator("#preview-dialog")).toHaveCount(0);
  });
