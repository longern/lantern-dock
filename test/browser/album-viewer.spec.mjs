import { isCompact } from "../helpers/responsive.mjs";
import { openItem } from "../helpers/open-item.mjs";
import { flipAlbum } from "../helpers/album-navigation.mjs";
import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
});
const gates = new Set();
test.afterEach(() => {
  for (const release of gates) release();
  gates.clear();
});
const thumbnail = await readFile(
  new URL("../fixtures/album-thumbnail.jpg", import.meta.url),
);
const video = await readFile(new URL("../fixtures/video.mp4", import.meta.url));
const items = [
  { name: "first.png", modified: "2026-11-09T12:00:00Z" },
  { name: "clip.mp4", modified: "2026-11-08T12:00:00Z" },
  { name: "last.png", modified: "2026-11-07T12:00:00Z" },
];
const current = (page) => page.locator(".album-media[data-current=true]");
const liveFixture = {
  items: [
    { name: "live.jpg", modified: "2026-11-09T12:00:00Z" },
    { name: "paired.mov", modified: "2026-11-09T12:00:00Z" },
    items[2],
  ],
  live: [
    {
      image: "/dav/live.jpg",
      pairedVideo: "/dav/paired.mov",
      kind: "apple",
      video: `/api/media/bGl2ZS5qcGc/cGFpcmVkLm1vdg/${"a".repeat(64)}/video.mp4`,
      length: video.length,
      posterTime: 0,
    },
  ],
  expectedCount: 2,
};
const viewer = (page) => page.locator("#album-viewer");
const button = (page, name) =>
  viewer(page).getByRole("button", { name, exact: true });

async function originalRaster(page) {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2400;
    canvas.height = 1600;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#45638a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg").split(",")[1];
  });
  return Buffer.from(encoded, "base64");
}

async function install(page, options = {}) {
  const state = { high: [], originals: [], liveReads: [], ...options };
  // A real decoded high-resolution raster, generated without an extra dependency.
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1067;
    const context = canvas.getContext("2d");
    const gradient = context.createLinearGradient(0, 0, 1600, 1067);
    gradient.addColorStop(0, "#445c82");
    gradient.addColorStop(1, "#e8bb73");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1600, 1067);
    context.fillStyle = "#fff";
    context.font = "100px sans-serif";
    context.fillText("LanternDock", 100, 600);
    return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
  });
  const high = Buffer.from(png, "base64");
  await page.addInitScript(() => {
    window.albumOwnedURLs = new Set();
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = function (blob) {
      const url = create.call(this, blob);
      window.albumOwnedURLs.add(url);
      return url;
    };
    URL.revokeObjectURL = function (url) {
      window.albumOwnedURLs.delete(url);
      return revoke.call(this, url);
    };
  });
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        backend: {
          name: "Album viewer fixture",
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
          ...(state.live
            ? {
                media: {
                  enabled: true,
                  protocol: "lantern-dock-media",
                  version: 1,
                  href: "/api/media",
                },
              }
            : {}),
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
  await page.route("**/api/media/**", async (route) => {
    if (route.request().url().includes("index.json")) {
      await state.liveIndexGate?.();
      return route.fulfill({
        json: {
          version: 1,
          revision: "a".repeat(64),
          items: state.live || [],
          nextOffset: null,
        },
        headers: { "Cache-Control": "private, max-age=15" },
      });
    }
    state.liveReads.push(route.request().url());
    await state.liveVideoGate?.();
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers().range || "",
    );
    const start = range ? Number(range[1]) : 0,
      end = range
        ? Math.min(Number(range[2] || video.length - 1), video.length - 1)
        : video.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: "video/mp4",
      body: video.subarray(start, end + 1),
      headers: {
        "Accept-Ranges": "bytes",
        ...(range
          ? { "Content-Range": `bytes ${start}-${end}/${video.length}` }
          : {}),
      },
    });
  });
  await page.route("**/api/iiif/3/**", async (route) => {
    const url = route.request().url();
    const videoImage = url.includes("/Y2xpcC5tcDQ/");
    const headers = { "Cache-Control": "public, max-age=600" };
    if (url.endsWith("/info.json"))
      return route.fulfill({
        headers,
        json: {
          id: url.slice(0, -"/info.json".length),
          type: "ImageService3",
          protocol: "http://iiif.io/api/image",
          profile: "level0",
          width: videoImage ? 640 : 2400,
          height: videoImage ? 360 : 1600,
          sizes: videoImage
            ? [{ width: 384, height: 216 }]
            : [
                { width: 384, height: 256 },
                { width: 1600, height: 1067 },
              ],
        },
      });
    if (url.includes("/1600,1067/")) {
      state.high.push(url);
      if (state.highResponse) return state.highResponse(route, high);
      return route.fulfill({ headers, contentType: "image/jpeg", body: high });
    }
    return route.fulfill({
      headers,
      contentType: "image/jpeg",
      body: thumbnail,
    });
  });
  await page.route("**/dav/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: { DAV: "1" } });
    if (route.request().method() === "PROPFIND")
      return route.fulfill({
        status: 207,
        contentType: "application/xml",
        body: `<d:multistatus xmlns:d="DAV:">${(state.items || items).map((item) => `<d:response><d:href>/dav/${item.name}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${item.name.endsWith(".mp4") ? video.length : high.length}</d:getcontentlength><d:getlastmodified>${item.modified}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`,
      });
    state.originals.push(route.request().url());
    if (state.originalResponse && !route.request().url().endsWith(".mp4"))
      return state.originalResponse(route);
    if (!route.request().url().endsWith(".mp4"))
      return route.fulfill({ contentType: "image/jpeg", body: high });
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers().range || "",
    );
    if (!range) return route.fulfill({ contentType: "video/mp4", body: video });
    const start = Number(range[1]),
      end = Math.min(Number(range[2] || video.length - 1), video.length - 1);
    return route.fulfill({
      status: 206,
      contentType: "video/mp4",
      body: video.subarray(start, end + 1),
      headers: {
        "Content-Range": `bytes ${start}-${end}/${video.length}`,
        "Accept-Ranges": "bytes",
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "文件分类", exact: true })
    .getByRole("button", { name: "相册", exact: true })
    .click();
  await expect(page.locator(".album-preview img")).toHaveCount(
    state.expectedCount ?? (state.items || items).length,
  );
  await expect
    .poll(() =>
      page
        .locator(".album-preview img")
        .evaluateAll((images) =>
          images.every((image) => image.naturalWidth > 0),
        ),
    )
    .toBe(true);
  return state;
}

test("a cropped thumbnail opens immediately, then decoded high resolution fades over the retained low layer", async ({
  page,
}, testInfo) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
    gates.add(resolve);
  });
  const state = await install(page, {
    highResponse: async (route, high) => {
      await gate;
      await route.fulfill({
        headers: { "Cache-Control": "public, max-age=600" },
        contentType: "image/jpeg",
        body: high,
      });
    },
  });
  const source = page.locator(".album-preview").first();
  const before = await source.boundingBox();
  await page.evaluate(() => {
    window.albumOpenFrames = [];
    const sample = () => {
      const media = document.querySelector('.album-media[data-current="true"]');
      if (media) {
        const r = media.getBoundingClientRect();
        window.albumOpenFrames.push({
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        });
      }
      if (window.albumOpenFrames.length < 45) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  try {
    await openItem(source);
    await expect(viewer(page)).toBeVisible();
    await expect(current(page).locator(".album-image-low")).toBeVisible();
    await expect(current(page).locator(".album-image-high")).toHaveCount(0);
    await expect.poll(() => state.high.length).toBe(1);
    await expect
      .poll(() =>
        current(page).evaluate((node) =>
          Math.abs(node.getBoundingClientRect().width - innerWidth),
        ),
      )
      .toBeLessThan(1);
    expect((await source.boundingBox()).width).toBeCloseTo(before.width, 3);
    expect(state.originals).toEqual([]);
    await page.waitForFunction(() => window.albumOpenFrames.length >= 35);
    const frames = await page.evaluate(() => window.albumOpenFrames);
    expect(
      frames.some(
        (r) =>
          r.width > before.width + 3 && r.width < page.viewportSize().width - 3,
      ),
    ).toBe(true);
    // Cover-cropped square expands into a complete 3:2 photograph, without stretching.
    expect(
      Math.abs(frames.at(-1).width / frames.at(-1).height - 1.5),
    ).toBeLessThan(0.01);
    await page.evaluate(() => {
      window.albumSharpFrames = [];
      const sample = () => {
        const root = document.querySelector(
          '.album-media[data-current="true"]',
        );
        const image = root?.querySelector(".album-image-high");
        if (image)
          window.albumSharpFrames.push({
            opacity: Number(getComputedStyle(image).opacity),
            low: !!root.querySelector(".album-image-low"),
            decoded: image.naturalWidth,
          });
        if (window.albumSharpFrames.length < 35) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  } finally {
    release();
  }
  await expect(current(page).locator(".album-image-high")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(current(page).locator(".album-image-low")).toHaveCount(0);
  await page.waitForFunction(() => window.albumSharpFrames.length >= 35);
  const fade = await page.evaluate(() => window.albumSharpFrames);
  expect(
    fade.filter((frame) => !frame.low).every((frame) => frame.opacity === 1),
  ).toBe(true);
  expect(
    fade.some(
      (frame) =>
        frame.opacity > 0 &&
        frame.opacity < 1 &&
        frame.low &&
        frame.decoded === 1600,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("album-fullscreen.png") });
  await button(page, "关闭预览").click();
  await expect(viewer(page)).toHaveCount(0);
  await expect(source).toBeFocused();
});

test("failed high-resolution loading keeps the thumbnail and download action usable", async ({
  page,
}) => {
  const state = await install(page, {
    highResponse: (route) => route.fulfill({ status: 503 }),
  });
  await openItem(page.locator(".album-preview").first());
  await expect(current(page).locator(".album-image-low")).toBeVisible();
  await expect(current(page).getByRole("status")).toContainText(
    "无法预览此图片",
  );
  await expect(button(page, "下载")).toBeEnabled();
  expect(state.originals).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
});

test("mixed media pages start only the active video and stop it before returning to photos", async ({
  page,
}) => {
  const state = await install(page);
  await openItem(page.locator(".album-preview").first());
  await expect(
    current(page).locator(".album-image-high.is-sharp"),
  ).toBeVisible();
  expect(state.originals).toEqual([]);
  await expect(viewer(page).locator("video")).toHaveCount(0);
  await flipAlbum(page);
  await expect(page.locator("#album-viewer-name")).toHaveText("clip.mp4");
  const player = viewer(page).locator("video");
  await expect(player).toBeVisible();
  await expect
    .poll(() => player.evaluate((node) => node.readyState))
    .toBeGreaterThanOrEqual(1);
  expect(
    await player.evaluate((node) => ({
      paused: node.paused,
      autoplay: node.autoplay,
    })),
  ).toEqual({ paused: true, autoplay: false });
  await player.evaluate((node) => {
    window.albumOldVideo = node;
    node.muted = true;
    return node.play();
  });
  await expect
    .poll(() => player.evaluate((node) => node.currentTime))
    .toBeGreaterThan(0.1);
  await player.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#album-viewer-name")).toHaveText("clip.mp4");
  await flipAlbum(page);
  await expect(page.locator("#album-viewer-name")).toHaveText("last.png");
  await expect(viewer(page).locator("video")).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      paused: window.albumOldVideo.paused,
      src: window.albumOldVideo.getAttribute("src"),
    })),
  ).toEqual({ paused: true, src: null });
  await button(page, "关闭预览").click();
  await expect(viewer(page)).toHaveCount(0);
  await expect(page.locator(".album-preview").last()).toBeFocused();
});

test("focus stays modal, details dismiss independently, Back closes and cached images reopen cleanly", async ({
  page,
}) => {
  const state = await install(page);
  const baseline = await page.evaluate(() => window.albumOwnedURLs.size);
  const source = page.locator(".album-preview").first();
  await openItem(source);
  await expect(current(page).locator(".album-image-high.is-sharp")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(page.locator("#album-viewer-title")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(button(page, "关闭预览")).toBeFocused();
  await button(page, "文件详情").click();
  await expect(page.locator("#album-viewer-details")).toContainText(
    "2400 × 1600",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("#album-viewer-details")).toHaveCount(0);
  await expect(viewer(page)).toBeVisible();
  await button(page, "文件详情").focus();
  await page.keyboard.press("Tab");
  await expect(button(page, "关闭预览")).toBeFocused();
  await page.goBack();
  await expect(viewer(page)).toHaveCount(0);
  await expect(source).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.albumOwnedURLs.size))
    .toBe(baseline);
  await openItem(source);
  await expect(
    current(page).locator(".album-image-high.is-cached"),
  ).toBeVisible();
  expect(state.high).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.albumOwnedURLs.size))
    .toBe(baseline);
});

test("closing before a delayed image completes aborts its request and a late result cannot reopen the viewer", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
    gates.add(resolve);
  });
  const state = await install(page, {
    highResponse: async (route, high) => {
      await gate;
      await route
        .fulfill({ contentType: "image/jpeg", body: high })
        .catch(() => {});
    },
  });
  const baseline = await page.evaluate(() => window.albumOwnedURLs.size);
  try {
    await openItem(page.locator(".album-preview").first());
    await expect.poll(() => state.high.length).toBe(1);
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
  } finally {
    release();
  }
  await expect
    .poll(() => page.evaluate(() => window.albumOwnedURLs.size))
    .toBe(baseline);
  await expect(page.locator(".PhotoView-Portal")).toHaveCount(0);
});

test("reduced motion disables zoom and sharpening animations without trapping dismissal", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await install(page);
  await openItem(page.locator(".album-preview").first());
  await expect(current(page).locator(".album-image-high.is-sharp")).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await expect(viewer(page).locator(".PhotoView-Slider__Backdrop")).toHaveCSS(
    "opacity",
    "1",
  );
  if (!isCompact(page)) {
    await button(page, "放大").click();
    await expect(button(page, "缩小")).toBeEnabled();
  } else {
    await expect(button(page, "放大")).toHaveCount(0);
    await expect(button(page, "缩小")).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  await expect(page.locator(".album-preview").first()).toBeFocused();
});

test("longer albums keep only adjacent media mounted and resize without overflowing", async ({
  page,
}) => {
  const photos = Array.from({ length: 8 }, (_, index) => ({
    name: `photo-${index}.png`,
    modified: items[0].modified,
  }));
  const state = await install(page, { items: photos });
  const baseline = await page.evaluate(() => window.albumOwnedURLs.size);
  await openItem(page.locator(".album-preview").first());
  for (let index = 0; index < photos.length; index++) {
    await expect(page.locator("#album-viewer-name")).toHaveText(
      photos[index].name,
    );
    await expect(current(page).locator(".album-image-high.is-sharp")).toHaveCSS(
      "opacity",
      "1",
    );
    expect(await page.locator(".album-media").count()).toBeLessThanOrEqual(3);
    if (index < photos.length - 1) await flipAlbum(page);
  }
  if (!isCompact(page))
    await expect(button(page, "下一张照片或视频")).toBeDisabled();
  else await expect(page.locator(".album-viewer-pager")).toBeHidden();
  const changesParent = isCompact(page);
  await page.setViewportSize({ width: 1024, height: 600 });
  if (changesParent) {
    // Moving from the mobile page dialog to the desktop page releases the old
    // native modal before another viewer is opened from the new thumbnail.
    await expect(viewer(page)).toHaveCount(0);
    await openItem(page.locator(".album-preview").last());
  }
  await expect
    .poll(() =>
      current(page).evaluate((node) => {
        const r = node.getBoundingClientRect();
        return (
          Math.abs(r.height - innerHeight) < 1 &&
          Math.abs(r.width / r.height - 1.5) < 0.01
        );
      }),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#album-viewer-name")).toHaveText("photo-6.png");
  await expect(
    current(page).locator(".album-image-high.is-cached"),
  ).toBeVisible();
  expect(state.high).toHaveLength(8);
  expect(state.originals).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  // Resizing can reveal additional grid thumbnails; all viewer URLs are gone.
  await expect
    .poll(() => page.evaluate(() => window.albumOwnedURLs.size))
    .toBeLessThanOrEqual(baseline + photos.length);
});

test("touch swipes follow the finger and pinch zoom remains independent of paging", async ({
  page,
}) => {
  test.skip(!isCompact(page), "Touch devices only");
  await page.addInitScript(() =>
    Object.defineProperty(window, "devicePixelRatio", { value: 4 }),
  );
  const photo = await originalRaster(page);
  const state = await install(page, {
    items: items.filter((item) => !item.name.endsWith(".mp4")),
    originalResponse: (route) =>
      route.fulfill({ contentType: "image/jpeg", body: photo }),
  });
  await openItem(page.locator(".album-preview").first());
  await expect(current(page).locator(".album-image-high.is-sharp")).toHaveCSS(
    "opacity",
    "1",
  );
  expect(state.originals).toHaveLength(0);
  await expect(button(page, "查看原图")).toHaveCount(0);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  const w = page.viewportSize().width,
    y = page.viewportSize().height / 2;
  await expect(button(page, "放大")).toHaveCount(0);
  await expect(button(page, "缩小")).toHaveCount(0);
  const originalWidth = (await current(page).boundingBox()).width;
  await touch("touchStart", [
    [w * 0.35, y],
    [w * 0.65, y],
  ]);
  for (const offset of [0.04, 0.08, 0.12, 0.16])
    await touch("touchMove", [
      [w * (0.35 - offset), y],
      [w * (0.65 + offset), y],
    ]);
  await touch("touchEnd", []);
  await expect
    .poll(async () => (await current(page).boundingBox()).width)
    .toBeGreaterThan(originalWidth * 1.3);
  await expect(page.locator("#album-viewer-name")).toHaveText("first.png");
  const sharp = current(page).locator(".album-image-original");
  await expect(sharp).toBeVisible();
  expect(await sharp.evaluate((image) => image.naturalWidth)).toBe(2400);
  expect(state.originals).toHaveLength(1);
  const originalURL = await sharp.getAttribute("src");
  await touch("touchStart", [
    [w * 0.1, y],
    [w * 0.9, y],
  ]);
  for (const offset of [0.1, 0.2, 0.3, 0.36])
    await touch("touchMove", [
      [w * (0.1 + offset), y],
      [w * (0.9 - offset), y],
    ]);
  await touch("touchEnd", []);
  await expect
    .poll(async () =>
      Math.abs((await current(page).boundingBox()).width - originalWidth),
    )
    .toBeLessThan(1);
  await expect(sharp).toHaveAttribute("src", originalURL);
  await touch("touchStart", [[w * 0.8, y]]);
  for (const fraction of [0.7, 0.6, 0.5, 0.4, 0.25, 0.1])
    await touch("touchMove", [[w * fraction, y]]);
  await touch("touchEnd", []);
  await expect(page.locator("#album-viewer-name")).toHaveText("last.png");
  await expect(sharp).toHaveCount(0);
  expect(state.originals).toHaveLength(1);
  await expect
    .poll(() =>
      page.evaluate((src) => window.albumOwnedURLs.has(src), originalURL),
    )
    .toBe(false);
  await expect
    .poll(() =>
      current(page).evaluate((node) =>
        Math.abs(node.getBoundingClientRect().x),
      ),
    )
    .toBeLessThan(1);
  await touch("touchStart", [[w / 2, y]]);
  for (const offset of [30, 60, 100, 150, 200])
    await touch("touchMove", [[w / 2, y + offset]]);
  await touch("touchEnd", []);
  await expect(viewer(page)).toHaveCount(0);
  await cdp.detach();
});

test("desktop zoom keeps the preview after an original load fails and can retry", async ({
  page,
}) => {
  test.skip(isCompact(page), "Desktop zoom controls only");
  const photo = await originalRaster(page);
  let fail = true;
  const state = await install(page, {
    originalResponse: (route) =>
      fail
        ? route.fulfill({ status: 503 })
        : route.fulfill({ contentType: "image/jpeg", body: photo }),
  });
  await openItem(page.locator(".album-preview").first());
  await expect(current(page).locator(".album-image-high.is-sharp")).toHaveCSS(
    "opacity",
    "1",
  );
  expect(state.originals).toHaveLength(0);
  await expect(button(page, "查看原图")).toHaveCount(0);
  await button(page, "放大").click();
  await expect(current(page).getByRole("status")).toContainText("原图加载失败");
  await expect(current(page).locator(".album-image-high.is-sharp")).toHaveCSS(
    "opacity",
    "1",
  );
  fail = false;
  await button(page, "缩小").click();
  await expect(current(page).getByRole("status")).toHaveCount(0);
  await button(page, "放大").click();
  const image = current(page).locator(".album-image-original");
  await expect(image).toBeVisible();
  expect(await image.evaluate((node) => node.naturalWidth)).toBe(2400);
  expect(state.originals).toHaveLength(2);
  const url = await image.getAttribute("src");
  await button(page, "关闭预览").click();
  await expect(viewer(page)).toHaveCount(0);
  expect(
    await page.evaluate((src) => window.albumOwnedURLs.has(src), url),
  ).toBe(false);
});

test("verified live pairs merge only in the album and play on hold, stop on release and dispose on close", async ({
  page,
}) => {
  const state = await install(page, liveFixture);
  await expect(page.locator(".album-live-indicator")).toHaveCount(1);
  expect(state.liveReads).toEqual([]);
  await openItem(page.locator(".album-preview").first());
  const live = current(page).locator("video.album-live-video");
  await expect(live).toHaveCount(1);
  await page.waitForTimeout(400);
  expect(state.liveReads).toEqual([]);
  const box = await current(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(live).toHaveClass(/is-playing/);
  await expect
    .poll(() => live.evaluate((v) => v.currentTime))
    .toBeGreaterThan(0.1);
  await page.mouse.up();
  await expect(live).not.toHaveClass(/is-playing/);
  expect(await live.evaluate((v) => v.paused)).toBe(true);
  await button(page, "播放动态照片").focus();
  await page.keyboard.press("Enter");
  await expect(live).toHaveClass(/is-playing/);
  await live.evaluate((v) => {
    window.lastLivePlayer = v;
  });
  await button(page, "关闭预览").click();
  await expect(viewer(page)).not.toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.lastLivePlayer.paused &&
        !window.lastLivePlayer.getAttribute("src"),
    ),
  ).toBe(true);
});

test("live playback gesture yields to dragging and multiple pointers", async ({
  page,
}) => {
  const state = await install(page, liveFixture);
  await openItem(page.locator(".album-preview").first());
  await expect(viewer(page).locator(".album-live-label")).toBeVisible();
  await current(page).dispatchEvent("pointerdown", {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 120,
    clientY: 240,
  });
  await page
    .locator("body")
    .dispatchEvent("pointermove", { pointerId: 1, clientX: 145, clientY: 240 });
  await page.waitForTimeout(350);
  expect(state.liveReads).toEqual([]);
  await current(page).dispatchEvent("pointerdown", {
    pointerId: 2,
    isPrimary: true,
    button: 0,
    clientX: 120,
    clientY: 240,
  });
  await current(page).dispatchEvent("pointerdown", {
    pointerId: 3,
    isPrimary: false,
    button: 0,
    clientX: 160,
    clientY: 240,
  });
  await page.waitForTimeout(350);
  expect(state.liveReads).toEqual([]);
  await button(page, "播放动态照片").click();
  await expect(current(page).locator("video")).toHaveClass(/is-playing/);
  await flipAlbum(page);
  await expect(current(page)).toHaveAttribute(
    "data-media-path",
    "/dav/last.png",
  );
  await expect(page.locator("video.album-live-video")).toHaveCount(0);
});

test("a released hold cannot start playback when a delayed video arrives", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
    gates.add(resolve);
  });
  const state = await install(page, {
    ...liveFixture,
    liveVideoGate: () => gate,
  });
  await openItem(page.locator(".album-preview").first());
  await expect(current(page).locator("video.album-live-video")).toHaveCount(1);
  const box = await current(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => state.liveReads.length).toBeGreaterThan(0);
  await page.mouse.up();
  release();
  await expect
    .poll(() =>
      current(page)
        .locator("video")
        .evaluate((v) => v.readyState),
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(
    await current(page)
      .locator("video")
      .evaluate((v) => v.paused),
  ).toBe(true);
  await expect(current(page).locator("video")).not.toHaveClass(/is-playing/);
});

test("metadata arriving after opening enables LIVE without remounting the viewer", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
    gates.add(resolve);
  });
  await install(page, {
    ...liveFixture,
    expectedCount: 3,
    liveIndexGate: () => gate,
  });
  await openItem(page.locator(".album-preview").first());
  await expect(button(page, "播放动态照片")).toHaveCount(0);
  release();
  await expect(button(page, "播放动态照片")).toBeVisible();
  await button(page, "播放动态照片").click();
  await expect(current(page).locator("video")).toHaveClass(/is-playing/);
});

test("real touch holds play and touch release stops without blocking the gallery", async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, "Touch viewport");
  await install(page, liveFixture);
  await openItem(page.locator(".album-preview").first());
  await expect(viewer(page).locator(".album-live-label")).toBeVisible();
  await page.waitForTimeout(350);
  const box = await current(page).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 0 },
    ],
  });
  const player = current(page).locator("video");
  await expect(player).toHaveClass(/is-playing/);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(player).not.toHaveClass(/is-playing/);
  expect(await player.evaluate((v) => v.paused)).toBe(true);
  await button(page, "播放动态照片").click();
  await expect(player).toHaveClass(/is-playing/);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(player).not.toHaveClass(/is-playing/);
  expect(await player.evaluate((v) => v.paused)).toBe(true);
  await cdp.detach();
});
