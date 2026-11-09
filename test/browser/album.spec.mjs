import { test, expect } from "@playwright/test";

const photo = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#728e97"/></svg>';
const listing = `<?xml version="1.0"?>
  <d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/photo.svg</d:href>
  <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${photo.length}</d:getcontentlength>
  <d:getcontenttype>image/svg+xml</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat></d:response></d:multistatus>`;

for (const service of ["unavailable", "unsupported", "broken-image"]) {
  test(`album keeps an accessible placeholder for ${service} thumbnails`, async ({ page }) => {
    let originalReads = 0;
    let failedThumbnailRequests = 0;
    await page.addInitScript(() => {
      window.albumImageErrors = 0;
      document.addEventListener("error", (event) => {
        if (event.target instanceof HTMLImageElement && event.target.closest(".album-preview"))
          window.albumImageErrors++;
      }, true);
    });
    await page.route("**/api/config", (route) => route.fulfill({ json: {
      backend: {
        name: "Album fixture", transport: "http", endpoint: "http://127.0.0.1:8788",
        rootPath: "/dav/", auth: "none", gatewayAuth: false, certificates: [],
      },
    } }));
    await page.route("**/api/capabilities", async (route) => {
      if (service === "unavailable") {
        await route.fulfill({ status: 404 });
        failedThumbnailRequests++;
        return;
      }
      await route.fulfill({ json: { version: 1, services: { images: {
        enabled: true, protocol: "http://iiif.io/api/image", version: 3, href: "/api/iiif/3",
      } } } });
    });
    await page.route("**/api/iiif/3/**", async (route) => {
      if (service === "unsupported") {
        await route.fulfill({ status: 415 });
        failedThumbnailRequests++;
        return;
      }
      if (route.request().url().endsWith("/info.json")) return route.fulfill({ json: {
        id: "http://127.0.0.1:8788/api/iiif/3/cGhvdG8uc3Zn", type: "ImageService3",
        protocol: "http://iiif.io/api/image", profile: "level0", width: 384, height: 256,
        sizes: [{ width: 384, height: 256 }],
      } });
      return route.fulfill({ contentType: "image/jpeg", body: "not an image" });
    });
    await page.route("**/dav/**", (route) => {
      if (route.request().method() === "PROPFIND")
        return route.fulfill({ status: 207, contentType: "application/xml", body: listing });
      originalReads++;
      return route.fulfill({ contentType: "image/svg+xml", body: photo });
    });
    await page.goto("/");
    await expect(page.locator(".file-item")).toHaveCount(1);
    await page.getByRole("navigation", { name: "文件分类", exact: true })
      .getByRole("button", { name: "相册", exact: true }).click();
    const gallery = page.locator("#file-list");
    const open = gallery.getByRole("button", { name: "预览 photo.svg", exact: true });
    if (service === "broken-image")
      await expect.poll(() => page.evaluate(() => window.albumImageErrors)).toBeGreaterThan(0);
    else
      await expect.poll(() => failedThumbnailRequests).toBeGreaterThan(0);
    await expect(open.locator(".thumbnail-slot svg")).toBeVisible();
    await expect(gallery.locator(".file-info,.favorite-button")).toHaveCount(0);
    await expect(gallery.locator(".album-date")).toHaveText("日期未知");
    await expect(gallery.locator(".album-item")).toHaveText("");
    expect(originalReads).toBe(0);
    await open.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#album-viewer-name")).toHaveText("photo.svg");
    if (service !== "broken-image") {
      await expect(page.locator(".album-media[data-current=true] .album-image-high.is-sharp")).toBeVisible();
      await expect.poll(() => originalReads).toBe(1);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("#album-viewer")).toHaveCount(0);
    await expect(open).toBeFocused();
  });
}
