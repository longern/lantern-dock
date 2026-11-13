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
            ? [
                { width: 384, height: 216 },
                { width: 640, height: 360 },
              ]
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
      headers: state.thumbnailHeaders || headers,
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
  await page.goto(state.files ? "/files/" : "/");
  if (state.files) return state;
  await page
    .getByRole("navigation", { name: "文件分类", exact: true })
    .getByRole("button", { name: "相册", exact: true })
    .click();
  if (state.lazyThumbnails) {
    await expect(page.locator(".album-preview").first()).toBeVisible();
    return state;
  }
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

test("file preview keeps the displayed thumbnail while a larger image loads", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
    gates.add(resolve);
  });
  const state = await install(page, {
    files: true,
    thumbnailHeaders: { "Cache-Control": "no-store" },
    highResponse: async (route, body) => {
      await gate;
      await route.fulfill({ contentType: "image/jpeg", body });
    },
  });
  const file = page.getByRole("button", {
    name: "预览 first.png",
    exact: true,
  });
  const listingImage = file.locator(".thumbnail-slot img");
  await expect
    .poll(() => listingImage.evaluate((image) => image.naturalWidth))
    .toBeGreaterThan(0);
  const lowWidth = await listingImage.evaluate((image) => image.naturalWidth);

  await openItem(file);
  const preview = page.locator("#preview-dialog");
  await expect.poll(() => state.high.length).toBe(1);
  await expect(preview.getByText("正在加载预览…")).toHaveCount(0);
  const image = preview.locator(".preview-image img");
  await expect(image).toHaveJSProperty("naturalWidth", lowWidth);
  const lowURL = await image.getAttribute("src");
  expect(lowURL).not.toBe(await listingImage.getAttribute("src"));
  const lowBounds = await preview.locator(".preview-image").boundingBox();

  release();
  const sharp = preview.locator(".preview-image-sharp");
  await expect(sharp).toHaveJSProperty("naturalWidth", 1600);
  await expect(sharp).toHaveCSS("animation-duration", "0.18s");
  await expect(image).toHaveCount(1);
  const highBounds = await preview.locator(".preview-image").boundingBox();
  expect(highBounds.width).toBeCloseTo(lowBounds.width, 2);
  expect(highBounds.height).toBeCloseTo(lowBounds.height, 2);
  expect(state.originals).toEqual([]);
});

test("the original thumbnail opens immediately and stays in the body layer until the preview fades in", async ({
  page,
}, testInfo) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
    gates.add(resolve);
  });
  const state = await install(page, {
    thumbnailHeaders: { "Cache-Control": "no-store" },
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
  const origin = source.locator("img");
  await origin.evaluate((img) => (window.openingThumbnail = img));
  const lifted = page
    .locator(".album-thumbnail-transition-picture > img")
    .first();
  const before = await source.boundingBox();
  await page.evaluate(() => {
    window.albumOpenFrames = [];
    const sample = () => {
      const media = document.querySelector('.album-media[data-current="true"]');
      if (media) {
        const r = media.getBoundingClientRect();
        const thumbnail = document.querySelector(
          ".album-thumbnail-transition-picture > img",
        );
        window.albumOpenFrames.push({
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          placeholder: !!media.querySelector(".album-media-placeholder"),
          lifted:
            thumbnail === window.openingThumbnail &&
            thumbnail.complete &&
            thumbnail.naturalWidth > 0,
          crop:
            thumbnail &&
            (parseFloat(
              getComputedStyle(thumbnail.parentElement).clipPath.split(" ")[1],
            ) ||
              0),
        });
      }
      if (window.albumOpenFrames.length < 45) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  try {
    await openItem(source);
    await expect(viewer(page)).toBeVisible();
    await expect(lifted).toBeVisible();
    expect(
      await lifted.evaluate(
        (img) => img === window.openingThumbnail && img.complete,
      ),
    ).toBe(true);
    await expect(current(page).locator(".album-image-high")).toHaveCount(0);
    await expect.poll(() => state.high.length).toBe(1);
    await expect
      .poll(() =>
        current(page).evaluate((node) =>
          Math.abs(
            node.getBoundingClientRect().width -
              Math.min(innerWidth, innerHeight * 1.5),
          ),
        ),
      )
      .toBeLessThan(1);
    expect((await source.boundingBox()).width).toBeCloseTo(before.width, 3);
    expect(state.originals).toEqual([]);
    await page.waitForFunction(() => window.albumOpenFrames.length >= 35);
    const frames = await page.evaluate(() => window.albumOpenFrames);
    expect(frames.every((frame) => frame.lifted && !frame.placeholder)).toBe(
      true,
    );
    expect(
      frames.some(
        (r) => r.width > before.width + 3 && r.width < frames.at(-1).width - 3,
      ),
    ).toBe(true);
    const first = frames[0];
    expect(first.crop).toBeCloseTo(64, 0);
    expect(frames.some(({ crop }) => crop > 1 && crop < 63)).toBe(true);
    // Cover-cropped square expands into a complete 3:2 photograph, without stretching.
    expect(
      Math.abs(frames.at(-1).width / frames.at(-1).height - 1.5),
    ).toBeLessThan(0.01);
    expect(frames.at(-1).crop).toBeLessThan(0.5);
    await page.evaluate(() => {
      window.albumSharpFrames = [];
      const sample = () => {
        const image = document.querySelector(".album-image-high");
        if (image)
          window.albumSharpFrames.push({
            opacity: Number(getComputedStyle(image).opacity),
            low: !!document.querySelector(
              ".album-thumbnail-transition-picture > img",
            ),
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
  await expect(current(page).locator(".album-image-low")).toHaveCSS(
    "opacity",
    "0",
  );
  await expect(lifted).toHaveCount(0);
  expect(await origin.evaluate((img) => img === window.openingThumbnail)).toBe(
    true,
  );
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

test("a preview that decodes mid-zoom stays aligned with the moving thumbnail", async ({
  page,
}) => {
  await install(page, {
    highResponse: async (route, high) => {
      // Deliver the preview just after the zoom starts moving.
      await page.waitForFunction(() => {
        const box = document
          .querySelector('.album-media[data-current="true"]')
          ?.getBoundingClientRect();
        return box?.width > window.albumThumbnailWidth + 5;
      });
      await route.fulfill({ contentType: "image/jpeg", body: high });
    },
  });
  const source = page.locator(".album-preview").first();
  await source.locator("img").evaluate((thumbnail) => {
    window.albumThumbnailWidth = thumbnail.getBoundingClientRect().width;
    window.albumFadeFrames = [];
    const sample = () => {
      const preview = document.querySelector(".album-image-high");
      const picture = thumbnail.closest(".album-thumbnail-transition-picture");
      if (preview && picture) {
        const low = thumbnail.getBoundingClientRect();
        const high = preview.getBoundingClientRect();
        const media = document.querySelector(
          '.album-media[data-current="true"]',
        );
        const opacity = Number(getComputedStyle(preview).opacity);
        window.albumLastLiftedBox = high.toJSON();
        if (opacity > 0 && opacity < 1) {
          window.albumFadingPreview = preview;
          window.albumFadeFrames.push({
            sharedCrop: preview.parentElement === picture,
            offset: Math.max(
              ...["left", "top", "right", "bottom"].map((edge) =>
                Math.abs(low[edge] - high[edge]),
              ),
            ),
            width: media.getBoundingClientRect().width,
            target: Math.min(innerWidth, innerHeight * 1.5),
          });
        }
      }
      if (!preview?.closest(".album-image-preview"))
        requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await openItem(source);
  const preview = current(page).locator(".album-image-high.is-sharp");
  await expect(preview).toBeVisible();
  const frames = await page.evaluate(() => window.albumFadeFrames);
  expect(frames.some(({ width, target }) => width < target - 2)).toBe(true);
  expect(
    frames.every(({ sharedCrop, offset }) => sharedCrop && offset < 0.5),
  ).toBe(true);
  const handoff = await preview.evaluate((node) => {
    const before = window.albumLastLiftedBox;
    const after = node.getBoundingClientRect();
    return {
      sameNode: node === window.albumFadingPreview,
      offset: Math.max(
        ...["left", "top", "right", "bottom"].map((edge) =>
          Math.abs(before[edge] - after[edge]),
        ),
      ),
    };
  });
  expect(handoff.sameNode).toBe(true);
  expect(handoff.offset).toBeLessThan(1);
});

test("failed high-resolution loading keeps the thumbnail and download action usable", async ({
  page,
}) => {
  const state = await install(page, {
    highResponse: (route) => route.fulfill({ status: 503 }),
  });
  await openItem(page.locator(".album-preview").first());
  await expect(
    page.locator(".album-thumbnail-transition-picture > img"),
  ).toBeVisible();
  await expect(current(page).getByRole("status")).toContainText(
    "无法预览此图片",
  );
  await expect(button(page, "下载")).toBeEnabled();
  expect(state.originals).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  await expect(page.locator("body > .album-thumbnail-transition")).toHaveCount(
    0,
  );
  await expect(
    page.locator(".album-preview").first().locator("img"),
  ).toBeVisible();
});

test("album videos show a cover and request video bytes only after pressing play", async ({
  page,
}) => {
  const state = await install(page);
  let releaseVideo;
  const videoGate = new Promise((resolve) => {
    releaseVideo = resolve;
    gates.add(resolve);
  });
  await page.route("**/dav/clip.mp4", async (route) => {
    await videoGate;
    await route.fallback();
  });
  await openItem(page.locator(".album-preview").first());
  await expect(
    current(page).locator(".album-image-high.is-sharp"),
  ).toBeVisible();
  expect(state.originals).toEqual([]);
  await expect(viewer(page).locator("video")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#album-viewer-name")).toHaveText("clip.mp4");
  const player = viewer(page).locator("video");
  const cover = current(page).locator(".album-video-cover-sharp");
  await expect(cover).toBeVisible();
  expect(state.originals).toEqual([]);
  await expect(player).not.toHaveAttribute("src", /.+/);
  await expect(viewer(page).getByRole("slider")).toHaveCount(0);
  await button(page, "播放视频").click();
  await expect(viewer(page).locator(".album-video-loading")).toBeVisible();
  await expect(cover).toBeVisible();
  releaseVideo();
  await expect(player).toBeVisible();
  await expect
    .poll(() => player.evaluate((node) => node.readyState))
    .toBeGreaterThanOrEqual(1);
  await player.evaluate((node) => {
    window.albumOldVideo = node;
  });
  await expect
    .poll(() => player.evaluate((node) => node.currentTime))
    .toBeGreaterThan(0.1);
  await expect(cover).toHaveCount(0);
  await player.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#album-viewer-name")).toHaveText("clip.mp4");
  await button(page, "关闭预览").focus();
  await page.keyboard.press("ArrowRight");
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

for (const scenario of ["video", "live", "live with a pending preview"]) {
  test(`the ${scenario} tile indicator follows the cover and fades during zoom`, async ({
    page,
  }) => {
    const isLive = scenario !== "video";
    const pending = scenario === "live with a pending preview";
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
      if (pending) gates.add(resolve);
    });
    await install(page, {
      ...(isLive ? liveFixture : {}),
      ...(pending && {
        highResponse: async (route, body) => {
          await gate;
          await route
            .fulfill({ contentType: "image/jpeg", body })
            .catch(() => {});
        },
      }),
    });
    const path = isLive ? "/dav/live.jpg" : "/dav/clip.mp4";
    const tile = page.locator(`.album-preview[data-path="${path}"]`);
    const indicator = tile.locator(".album-indicator");
    await expect(indicator).toBeVisible();
    await tile.evaluate(async (node) => {
      const animations = node.closest("dialog")?.getAnimations() || [];
      await Promise.allSettled(
        animations.map((animation) => animation.finished),
      );
    });
    await tile.scrollIntoViewIfNeeded();
    await tile.evaluate((node, isLive) => {
      window.indicatorFrames = { opening: [], closing: [] };
      const sample = () => {
        const moving = document.querySelector(".album-indicator[data-motion]");
        if (moving) {
          const media = moving.parentElement.getBoundingClientRect();
          const badge = moving.getBoundingClientRect();
          const style = getComputedStyle(moving);
          // Check the inset in layout pixels so compositor sampling cannot
          // compare a badge and its container at different animation times.
          const inset = (6 * parseFloat(style.width)) / 22;
          window.indicatorFrames[moving.dataset.motion]?.push({
            mediaWidth: media.width,
            opacity: Number(style.opacity),
            offset: Math.max(
              Math.abs(parseFloat(isLive ? style.left : style.right) - inset),
              Math.abs(parseFloat(isLive ? style.top : style.bottom) - inset),
            ),
            gridHidden:
              !node.isConnected ||
              getComputedStyle(node.querySelector(".album-indicator"))
                .visibility === "hidden",
            badge: badge.toJSON(),
          });
        }
        if (!window.indicatorFinished) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, isLive);
    await openItem(tile);
    const moving = page.locator(".album-indicator[data-motion]");
    if (isLive)
      await expect(
        page.locator(
          ".album-thumbnail-transition-indicators > .album-indicator",
        ),
      ).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.indicatorFrames.opening.some(({ opacity }) => opacity === 0),
        ),
      )
      .toBe(true);
    if (!pending) await expect(moving).toHaveCount(0);
    await button(page, "关闭预览").click();
    await expect(viewer(page)).toHaveCount(0);
    await expect(indicator).toBeVisible();
    if (pending) release();
    const target = await indicator.boundingBox();
    const frames = await page.evaluate(() => {
      window.indicatorFinished = true;
      return window.indicatorFrames;
    });
    for (const phase of ["opening", "closing"]) {
      const samples = frames[phase];
      expect(samples.some(({ opacity }) => opacity > 0 && opacity < 1)).toBe(
        true,
      );
      expect(
        samples.filter(({ offset, gridHidden }) => offset >= 1 || !gridHidden),
        phase,
      ).toEqual([]);
      expect(
        samples.some(
          ({ mediaWidth, badge }) =>
            Math.abs(mediaWidth - samples[0].mediaWidth) > 20 &&
            Math.abs(badge.width - samples[0].badge.width) > 3,
        ),
      ).toBe(true);
    }
    const last = frames.closing.at(-1);
    expect(last.opacity).toBeCloseTo(1, 1);
    for (const property of ["x", "y", "width"])
      expect(Math.abs(last.badge[property] - target[property])).toBeLessThan(2);
  });
}

test("closing an album video crops the paused frame and fades into its grid thumbnail", async ({
  page,
}) => {
  await install(page);
  const tile = page.locator('.album-preview[data-path="/dav/clip.mp4"]');
  await openItem(tile);
  await expect(button(page, "播放视频")).toHaveCSS(
    "animation-duration",
    "0.15s",
  );
  await button(page, "播放视频").click();
  const player = current(page).locator("video");
  await expect(player).toBeVisible();
  const exitThumbnail = current(page).locator(".album-video-exit-thumbnail");
  await expect
    .poll(() => exitThumbnail.evaluate((node) => node.naturalWidth))
    .toBeGreaterThan(0);
  const thumbnail = await exitThumbnail.evaluate((node) => node.currentSrc);
  await player.evaluate((node) => {
    node.muted = true;
    return node.play();
  });
  await expect
    .poll(() => player.evaluate((node) => node.currentTime))
    .toBeGreaterThan(0.1);
  await player.evaluate((node) => {
    window.closingVideo = node;
    window.videoExitFrames = [];
    const dialog = node.closest("dialog");
    const sample = () => {
      if (!dialog.open || !node.isConnected) return;
      if (dialog.dataset.state === "closed") {
        const box = node.getBoundingClientRect();
        const poster = dialog.querySelector(".album-video-exit-thumbnail");
        const indicator = dialog.querySelector(".album-video-indicator");
        window.videoExitFrames.push({
          ratio: box.width / box.height,
          fit: getComputedStyle(node).objectFit,
          paused: node.paused,
          ready: node.readyState >= 2,
          poster: poster?.currentSrc,
          opacity: poster ? Number(getComputedStyle(poster).opacity) : 0,
          indicator: indicator
            ? Number(getComputedStyle(indicator).opacity)
            : 0,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await button(page, "关闭预览").click();
  await expect(viewer(page)).toHaveCount(0);
  const frames = await page.evaluate(() => window.videoExitFrames);
  expect(frames.length).toBeGreaterThan(2);
  expect(
    frames.every(
      (frame) => frame.paused && frame.ready && frame.fit === "cover",
    ),
  ).toBe(true);
  expect(
    frames.some(
      (frame) =>
        frame.ratio > 1.05 &&
        frame.ratio < 1.7 &&
        frame.poster === thumbnail &&
        frame.opacity > 0 &&
        frame.opacity < 1,
    ),
  ).toBe(true);
  expect(frames.at(-1).ratio).toBeCloseTo(1, 1);
  expect(frames.at(-1).opacity).toBeCloseTo(1, 1);
  expect(frames.at(-1).indicator).toBeCloseTo(1, 1);
  expect(
    await page.evaluate(() => window.closingVideo.hasAttribute("src")),
  ).toBe(false);
  await expect(tile).toBeFocused();
});

test("album video controls seek on release, set playback speed, and stay above the toolbar while playing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.playbackControlEntries = 0;
    document.addEventListener("animationstart", (event) => {
      if (event.target.matches(".album-video-controls"))
        window.playbackControlEntries++;
    });
  });
  await install(page);
  await openItem(page.locator('.album-preview[data-path="/dav/clip.mp4"]'));
  const toolbar = viewer(page).locator(".album-viewer-actions");
  const playbackControls = viewer(page).locator(".album-video-controls");
  await expect(toolbar).toBeVisible();
  await expect(playbackControls).toHaveCount(0);
  await button(page, "播放视频").click();
  const player = viewer(page).locator("video");
  await expect.poll(() => player.evaluate((node) => node.duration)).toBe(8);
  const slider = viewer(page).getByRole("slider", { name: "播放进度" });
  await expect(slider).toBeVisible();
  await expect(playbackControls).toHaveCSS("animation-duration", "0.15s");
  await player.evaluate((node) => {
    node.pause();
    node.currentTime = 0;
  });
  const track = await slider.locator(".album-video-track").boundingBox();
  const touch = await page.evaluate(
    () => matchMedia("(pointer: coarse)").matches,
  );
  const cdp = touch ? await page.context().newCDPSession(page) : null;
  const pointer = async (type, fraction) => {
    const x = track.x + track.width * fraction;
    const y = track.y + track.height / 2;
    if (cdp)
      await cdp.send("Input.dispatchTouchEvent", {
        type: { down: "touchStart", move: "touchMove", up: "touchEnd" }[type],
        touchPoints: type === "up" ? [] : [{ x, y }],
      });
    else {
      await page.mouse.move(x, y);
      if (type === "down") await page.mouse.down();
      if (type === "up") await page.mouse.up();
    }
  };
  const time = () => player.evaluate((node) => node.currentTime);
  try {
    await pointer("down", 0.25);
    expect(await time()).toBe(0);
    await pointer("up", 0.25);
    await expect.poll(time).toBeCloseTo(2, 0);

    await pointer("down", 0.7);
    await pointer("move", 0.9);
    expect(await time()).toBeCloseTo(2, 0);
    await expect(slider.locator(".album-video-target")).toHaveText("0:03");
    await pointer("up", 0.9);
    await expect.poll(time).toBeCloseTo(3.6, 0);

    await pointer("down", 0.7);
    await pointer("move", 0.5);
    expect(await time()).toBeCloseTo(3.6, 0);
    await pointer("up", 0.5);
    await expect.poll(time).toBeCloseTo(2, 0);
  } finally {
    await cdp?.detach();
  }
  await expect(page.locator("#album-viewer-name")).toHaveText("clip.mp4");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(time).toBeCloseTo(7, 0);
  await page.keyboard.press("Home");
  await expect.poll(time).toBe(0);

  await button(page, "视频选项").click();
  const menu = viewer(page).getByRole("menu");
  await expect(
    menu.getByRole("menuitemradio", { name: "1×", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "1.5×", exact: true }).click();
  await expect
    .poll(() => player.evaluate((node) => node.playbackRate))
    .toBe(1.5);
  await player.evaluate((node) => {
    node.playbackRate = 1;
  });
  await button(page, "静音").click();
  await expect(button(page, "取消静音")).toBeVisible();
  await button(page, "播放视频").click();
  const controls = viewer(page).locator(".album-viewer-controls");
  // The previous idle timer hid all controls after three seconds of playback.
  await expect.poll(time, { timeout: 6500 }).toBeGreaterThan(3.2);
  await expect(controls).not.toHaveAttribute("inert", "");
  await expect(toolbar.getByRole("button").first()).toHaveAccessibleName(
    "分享",
  );
  const toolbarBox = await toolbar.boundingBox();
  const progressBox = await viewer(page)
    .locator(".album-video-controls")
    .boundingBox();
  expect(progressBox.y + progressBox.height).toBeLessThan(toolbarBox.y);
  await button(page, "暂停视频").click();
  await expect(button(page, "播放视频")).toBeVisible();
  await expect(playbackControls).toHaveCSS("opacity", "1");
  await expect(toolbar).toBeVisible();
  await button(page, "播放视频").click();
  await expect(button(page, "暂停视频")).toBeVisible();
  await expect(playbackControls).toHaveCSS("opacity", "1");
  await expect(toolbar).toBeVisible();
  expect(await page.evaluate(() => window.playbackControlEntries)).toBe(1);
});

test("album sharing offers the supported actions in order and copies the album link and image", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      value: async (data) => {
        window.sharedMedia = data;
      },
    });
    Object.defineProperty(navigator, "canShare", { value: () => true });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        async writeText(url) {
          window.copiedMedia = url;
        },
        async write([image]) {
          const png = await image.getType("image/png");
          window.copiedImage = [png.type, png.size];
        },
      },
    });
  });
  await install(page);
  await openItem(page.locator(".album-preview").first());
  const toolbar = viewer(page).locator(".album-viewer-actions");
  const trigger = toolbar.getByRole("button", { name: "分享", exact: true });
  const share = page.getByRole("dialog", { name: "分享", exact: true });
  const url = new URL("/files/first.png?view=album", page.url()).href;
  await expect(toolbar.getByRole("button").first()).toHaveAccessibleName(
    "分享",
  );
  const layout = await toolbar.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const buttons = [...node.children].map((button) =>
      button.getBoundingClientRect().toJSON(),
    );
    return {
      left: bounds.left + parseFloat(style.paddingLeft),
      right: bounds.right - parseFloat(style.paddingRight),
      buttons,
    };
  });
  if (isCompact(page)) {
    const columnWidth = (layout.right - layout.left) / layout.buttons.length;
    for (const [index, button] of layout.buttons.entries())
      expect(button.left + button.width / 2).toBeCloseTo(
        layout.left + columnWidth * (index + 0.5),
        1,
      );
  } else {
    expect(layout.buttons[0].left - layout.left).toBeCloseTo(
      layout.right - layout.buttons.at(-1).right,
      1,
    );
    for (const [index, button] of layout.buttons.slice(1).entries())
      expect(button.left - layout.buttons[index].right).toBeCloseTo(8, 1);
  }
  await expect(
    viewer(page)
      .locator(".album-viewer-header")
      .getByRole("button", { name: "复制链接" }),
  ).toHaveCount(0);
  const favorite = toolbar.locator(".album-favorite");
  await expect(favorite).toHaveAttribute("aria-pressed", "false");
  await favorite.click();
  await expect(favorite).toHaveAttribute("aria-pressed", "true");
  await expect(favorite.locator("svg")).toHaveCSS("fill", "rgb(255, 82, 110)");
  await trigger.click();
  await expect(share.locator(".album-share-actions button")).toHaveText([
    "分享",
    "复制链接",
    "复制图片",
    "二维码分享",
  ]);
  expect(
    await share.evaluate((node) => node.classList.contains("file-info-drawer")),
  ).toBe(isCompact(page));
  await share.getByRole("button", { name: "二维码分享" }).click();
  await expect(share.getByRole("img", { name: "二维码分享" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(share).toHaveCount(0);
  await expect(viewer(page)).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await share.getByRole("button", { name: "复制图片" }).click();
  await expect(share).toHaveCount(0);
  expect(await page.evaluate(() => window.copiedImage)).toEqual([
    "image/png",
    expect.any(Number),
  ]);
  await trigger.click();
  await share.getByRole("button", { name: "复制链接" }).click();
  await expect(share).toHaveCount(0);
  expect(await page.evaluate(() => window.copiedMedia)).toBe(url);
  await trigger.click();
  await share.getByRole("button", { name: "分享", exact: true }).click();
  await expect(share).toHaveCount(0);
  expect(await page.evaluate(() => window.sharedMedia)).toEqual({
    title: "first.png",
    url,
  });
  await page.keyboard.press("ArrowRight");
  await expect(viewer(page).locator("#album-viewer-name")).toHaveText(
    "clip.mp4",
  );
  await trigger.click();
  await expect(share.getByRole("button", { name: "复制图片" })).toHaveCount(0);
  await expect(viewer(page).locator("video")).not.toHaveAttribute("src", /.+/);
});

test("the video timeline shows the latest target while the seek is buffering", async ({
  page,
}) => {
  await install(page);
  await openItem(page.locator('.album-preview[data-path="/dav/clip.mp4"]'));
  await button(page, "播放视频").click();
  const player = viewer(page).locator("video");
  await expect.poll(() => player.evaluate((node) => node.duration)).toBe(8);
  await expect(
    viewer(page).getByRole("slider", { name: "播放进度" }),
  ).toBeVisible();
  await player.evaluate((node) => node.pause());
  await player.evaluate((node) => {
    let actual = 0;
    let seeking = false;
    Object.defineProperties(node, {
      seeking: { get: () => seeking },
      currentTime: {
        get: () => actual,
        set: () => {
          seeking = true;
          node.dispatchEvent(new Event("timeupdate"));
        },
      },
    });
    node.finishSeek = (time) => {
      actual = time;
      seeking = false;
      node.dispatchEvent(new Event("seeked"));
    };
  });
  const slider = viewer(page).getByRole("slider", { name: "播放进度" });
  const track = slider.locator(".album-video-track");
  const { width, height } = await track.boundingBox();
  for (const fraction of [0.25, 0.75]) {
    await track.click({ position: { x: width * fraction, y: height / 2 } });
    expect(await player.evaluate((node) => node.currentTime)).toBe(0);
    await expect
      .poll(async () => Number(await slider.getAttribute("aria-valuenow")))
      .toBeCloseTo(8 * fraction, 0);
  }
  await player.evaluate((node) => node.finishSeek(5.5));
  await expect(slider).toHaveAttribute("aria-valuenow", "5.5");
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

test("closing before a delayed image completes animates the original thumbnail back into its tile", async ({
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
  const source = page.locator(".album-preview").first();
  await source
    .locator("img")
    .evaluate((img) => (window.openingThumbnail = img));
  const lifted = page.locator(".album-thumbnail-transition-picture > img");
  try {
    await openItem(source);
    await expect(lifted).toBeVisible();
    await expect.poll(() => state.high.length).toBe(1);
    await expect
      .poll(() =>
        current(page).evaluate((media) => media.getBoundingClientRect().width),
      )
      .toBeCloseTo(
        Math.min(page.viewportSize().width, page.viewportSize().height * 1.5),
        0,
      );
    await source.evaluate((tile) => {
      const image = window.openingThumbnail;
      const picture = image.parentElement;
      const dialog = document.querySelector("#album-viewer");
      window.albumExitFrames = [];
      const target = tile.getBoundingClientRect();
      const sample = () => {
        if (!dialog.open || image.parentElement !== picture) return;
        const box = image.getBoundingClientRect();
        const [y, x = y] = getComputedStyle(picture)
          .clipPath.slice(6, -1)
          .split(" ")
          .map(parseFloat);
        const scale = box.width / image.naturalWidth;
        const left = box.left + x * scale;
        const top = box.top + y * scale;
        const width = box.width - 2 * x * scale;
        const height = box.height - 2 * y * scale;
        window.albumExitFrames.push({
          width,
          crop: x,
          distance: Math.max(
            Math.abs(left - target.left),
            Math.abs(top - target.top),
            Math.abs(width - target.width),
            Math.abs(height - target.height),
          ),
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
    await expect(lifted).toHaveCount(0);
    const frames = await page.evaluate(() => window.albumExitFrames);
    const final = frames.at(-1);
    expect(
      frames.some(
        ({ width, crop }) =>
          width < frames[0].width - 5 &&
          width > final.width + 5 &&
          crop > 1 &&
          crop < 63,
      ),
    ).toBe(true);
    expect(final.distance).toBeLessThan(2);
    expect(
      await source
        .locator("img")
        .evaluate((img) => img === window.openingThumbnail),
    ).toBe(true);
  } finally {
    release();
  }
  await expect
    .poll(() => page.evaluate(() => window.albumOwnedURLs.size))
    .toBe(baseline);
  await expect(page.locator(".PhotoView-Portal")).toHaveCount(0);
});

test("closing during sharpening fades back to the lifted thumbnail from the current opacity", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const animations = HTMLElement.prototype.getAnimations;
    HTMLElement.prototype.getAnimations = function (...args) {
      const result = animations.apply(this, args);
      if (
        this.matches(".album-thumbnail-transition-picture > .album-image-high")
      ) {
        const fade = result.find(
          (animation) => animation.animationName === "album-original-in",
        );
        if (fade && !window.interruptedSharpening) {
          window.interruptedSharpening = this;
          fade.pause();
          fade.currentTime = 45;
        }
      }
      return result;
    };
  });
  await install(page);
  await openItem(page.locator(".album-preview").first());
  await page.waitForFunction(() => window.interruptedSharpening);
  const preview = page.locator(
    ".album-thumbnail-transition-picture > .album-image-high",
  );
  const before = await preview.evaluate((node) => {
    const read = () => Number(getComputedStyle(node).opacity);
    window.interruptedFrames = [];
    const sample = () => {
      if (!node.isConnected) return;
      window.interruptedFrames.push(read());
      requestAnimationFrame(sample);
    };
    sample();
    return read();
  });
  expect(before).toBeGreaterThan(0.1);
  expect(before).toBeLessThan(0.9);
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  const frames = await page.evaluate(() => window.interruptedFrames);
  expect(
    frames.some((opacity) => opacity > 0.05 && opacity < before - 0.05),
  ).toBe(true);
  expect(frames.at(-1)).toBeCloseTo(0, 2);
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

test("a photo and its black bars share the same reversible swipe fade", async ({
  page,
}) => {
  test.skip(!isCompact(page), "Touch devices only");
  await install(page, {
    highResponse: (route) => route.fulfill({ status: 503 }),
  });
  await openItem(page.locator(".album-preview").first());
  const media = current(page);
  const backdrop = page.locator(".album-thumbnail-transition-mask");
  await expect(media.getByRole("status")).toContainText("无法预览此图片");
  await expect
    .poll(async () => (await media.boundingBox()).width)
    .toBeCloseTo(page.viewportSize().width, 0);
  const cdp = await page.context().newCDPSession(page);
  const original = await media.boundingBox();
  const x = original.x + original.width / 2;
  const drag = (type, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: y === undefined ? [] : [{ x, y }],
    });
  const opacity = () =>
    backdrop.evaluate((node) => {
      const color = getComputedStyle(node).backgroundColor;
      return color.startsWith("rgba")
        ? Number(color.split(",").at(-1).slice(0, -1))
        : 1;
    });
  try {
    for (const start of [original.y + original.height / 2, original.y - 24]) {
      await drag("touchStart", start);
      for (const offset of [25, 60, 105, 150])
        await drag("touchMove", start + offset);
      await expect.poll(opacity).toBeLessThan(0.85);
      await expect
        .poll(async () => (await media.boundingBox()).y)
        .toBeGreaterThan(original.y + 30);
      for (const offset of [110, 70, 25, 0])
        await drag("touchMove", start + offset);
      await expect.poll(opacity).toBeGreaterThan(0.85);
      await drag("touchEnd");
      await expect
        .poll(async () => Math.abs((await media.boundingBox()).y - original.y))
        .toBeLessThan(2);
      await expect(viewer(page)).toBeVisible();
    }
  } finally {
    await cdp.detach();
  }
});

for (const mode of ["preview", "thumbnail", "offscreen photo"]) {
  test(`fast and slow dismissals return the ${mode} to the same tile`, async ({
    page,
  }) => {
    test.skip(!isCompact(page), "Touch devices only");
    const pending = mode === "thumbnail";
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
      gates.add(resolve);
    });
    await install(page, {
      lazyThumbnails: mode === "offscreen photo",
      items:
        mode === "offscreen photo"
          ? Array.from({ length: 30 }, (_, index) => ({
              name: `photo-${index}.jpg`,
              modified: new Date(
                Date.UTC(2026, 10, 13) - index * 86400000,
              ).toISOString(),
            }))
          : undefined,
      highResponse: pending
        ? async (route, high) => {
            await gate;
            await route
              .fulfill({ contentType: "image/jpeg", body: high })
              .catch(() => {});
          }
        : undefined,
    });
    const tiles = page.locator(".album-preview");
    const tile = tiles.nth(mode === "offscreen photo" ? 4 : 0);
    const landing = mode === "offscreen photo" ? tiles.nth(5) : tile;
    const cdp = await page.context().newCDPSession(page);
    try {
      for (const slow of [false, true]) {
        if (mode === "offscreen photo")
          await tile.evaluate((node) =>
            node.scrollIntoView({ block: "center", behavior: "instant" }),
          );
        await openItem(tile);
        if (mode === "offscreen photo") {
          await flipAlbum(page);
          await expect(page.locator("#album-viewer-name")).toHaveText(
            "photo-5.jpg",
          );
          await landing.evaluate((node) => {
            node.closest("dialog").scrollTop = 0;
          });
          expect((await landing.boundingBox()).y).toBeGreaterThan(
            page.viewportSize().height,
          );
        }
        const preview = pending
          ? page.locator(".album-thumbnail-transition-picture > img")
          : current(page).locator(".album-image-high.is-sharp");
        await expect(preview).toBeVisible();
        if (!pending)
          await expect
            .poll(() =>
              current(page)
                .locator(".album-image-low")
                .evaluate((node) => node.naturalWidth)
                .catch(() => 0),
            )
            .toBeGreaterThan(0);

        const media = current(page);
        await expect
          .poll(async () => (await media.boundingBox()).width)
          .toBeCloseTo(page.viewportSize().width, 0);
        const box = await media.boundingBox();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        const touch = (type, offset) =>
          cdp.send("Input.dispatchTouchEvent", {
            type,
            touchPoints: offset === undefined ? [] : [{ x, y: y + offset }],
          });
        await preview.evaluate((node) => {
          const dialog = document.querySelector("#album-viewer");
          const media = dialog.querySelector(
            '.album-media[data-current="true"]',
          );
          const picture = node.closest(".album-thumbnail-transition-picture");
          window.photoDismissalFrames = [];
          const sample = () => {
            if (!dialog.open || !node.isConnected) return;
            const box = node.getBoundingClientRect();
            const [vertical, horizontal = vertical] = picture
              ? getComputedStyle(picture)
                  .clipPath.slice(6, -1)
                  .split(" ")
                  .map(parseFloat)
              : [0];
            const scale = box.width / node.naturalWidth;
            const insetX = horizontal * scale;
            const insetY = vertical * scale;
            const thumbnail = media.querySelector(".album-image-low");
            if (dialog.dataset.state === "closed")
              window.photoDismissalFrames.push({
                x: box.x + insetX,
                y: box.y + insetY,
                width: box.width - insetX * 2,
                height: box.height - insetY * 2,
                opacity: Number(getComputedStyle(picture || media).opacity),
                thumbnailOpacity: thumbnail
                  ? Number(getComputedStyle(thumbnail).opacity)
                  : null,
              });
            requestAnimationFrame(sample);
          };
          sample();
        });
        await touch("touchStart", 0);
        for (const offset of [30, 80, 140, 200]) {
          if (slow) await page.waitForTimeout(100);
          await touch("touchMove", offset);
        }
        await touch("touchEnd");
        await expect(viewer(page)).toHaveCount(0);
        const frames = await page.evaluate(() => window.photoDismissalFrames);
        expect(frames.length).toBeGreaterThan(4);
        const target = await landing.boundingBox();
        expect(target.y).toBeGreaterThanOrEqual(0);
        expect(target.y + target.height).toBeLessThanOrEqual(
          page.viewportSize().height,
        );
        const last = frames.at(-1);
        expect(last.x, JSON.stringify({ slow, target, last })).toBeCloseTo(
          target.x,
          0,
        );
        expect(last.y).toBeCloseTo(target.y, 0);
        expect(last.width).toBeCloseTo(target.width, 0);
        expect(last.height).toBeCloseTo(target.height, 0);
        expect(frames.every(({ opacity }) => opacity === 1)).toBe(true);
        if (!pending) {
          expect(
            frames.some(
              ({ thumbnailOpacity, width }) =>
                thumbnailOpacity > 0 &&
                thumbnailOpacity < 1 &&
                width > target.width + 1,
            ),
          ).toBe(true);
          expect(last.thumbnailOpacity).toBeCloseTo(1, 2);
        }
      }
    } finally {
      release();
      await cdp.detach();
    }
  });
}

test("video swipes follow the finger and can be reversed before dismissal", async ({
  page,
}) => {
  test.skip(!isCompact(page), "Touch devices only");
  await install(page);
  const trigger = page.locator('.album-preview[data-path="/dav/clip.mp4"]');
  const cdp = await page.context().newCDPSession(page);
  const { width, height } = page.viewportSize();
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  try {
    for (const direction of [-1, 1]) {
      await openItem(trigger);
      const player = viewer(page).locator("video");
      const surface =
        direction < 0 ? current(page).locator(".album-video-cover") : player;
      if (direction > 0) await button(page, "播放视频").click();
      else await expect(player).not.toHaveAttribute("src", /.+/);
      await expect
        .poll(async () => (await surface.boundingBox())?.width)
        .toBeCloseTo(width, 0);
      const x = width / 2;
      const y = height / 2;
      const original = await surface.boundingBox();
      const startY = direction > 0 ? original.y - 24 : y;
      const backdrop = viewer(page).locator(".PhotoView-Slider__Backdrop");
      const drag = async (offsets) => {
        for (const offset of offsets)
          await touch("touchMove", [[x, startY + direction * offset]]);
      };
      if (direction > 0) {
        const initialWidth = (await player.boundingBox()).width;
        await touch("touchStart", [
          [x - 30, y],
          [x + 30, y],
        ]);
        await touch("touchMove", [
          [x - 70, y],
          [x + 70, y],
        ]);
        await touch("touchEnd", []);
        expect((await player.boundingBox()).width).toBeCloseTo(initialWidth, 0);
        await player.evaluate((node) => {
          node.muted = true;
          return node.play();
        });
      }
      await touch("touchStart", [[x, startY]]);
      await drag([25, 60, 105, 150, 200]);
      await expect
        .poll(
          async () =>
            direction * ((await surface.boundingBox()).y - original.y),
        )
        .toBeGreaterThan(40);
      const opacity = () =>
        backdrop.evaluate((node) => {
          const color = getComputedStyle(node).backgroundColor;
          return color.startsWith("rgba")
            ? Number(color.split(",").at(-1).slice(0, -1))
            : 1;
        });
      await expect.poll(opacity).toBeLessThan(0.85);
      await drag([160, 115, 70, 25, 0]);
      await expect.poll(opacity).toBeGreaterThan(0.85);
      await touch("touchEnd", []);
      await expect
        .poll(async () =>
          Math.abs((await surface.boundingBox()).y - original.y),
        )
        .toBeLessThan(2);
      await expect.poll(opacity).toBe(1);
      await expect(viewer(page)).toBeVisible();
      if (direction > 0)
        expect(await player.evaluate((node) => node.paused)).toBe(false);

      await touch("touchStart", [[x, startY]]);
      await drag([25, 60, 105, 150, 200]);
      await touch("touchEnd", []);
      await expect(viewer(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  } finally {
    await cdp.detach();
  }
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

test("native live playback fades out its waiting indicator when playback starts", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
    gates.add(resolve);
  });
  await install(page, { ...liveFixture, liveVideoGate: () => gate });
  await openItem(page.locator(".album-preview").first());
  await button(page, "播放动态照片").click();
  const status = current(page).locator(".album-live-status");
  await expect(status).toHaveText("正在加载动态照片");
  await expect(status.locator(".album-live-spinner")).toBeVisible();
  await expect(status.getByRole("progressbar")).toHaveCount(0);
  release();
  await expect(current(page).locator("video")).toHaveClass(/is-playing/);
  await expect(status).toHaveClass(/is-fading/);
  await expect(status).toBeHidden();
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
