import { expect } from "@playwright/test";
export async function flipAlbum(page, direction = 1) {
  if (page.viewportSize().width > 700) {
    await page
      .locator("#album-viewer")
      .getByRole("button", {
        name: direction > 0 ? "下一张照片或视频" : "上一张照片或视频",
        exact: true,
      })
      .click();
    return;
  }
  const name = await page.locator("#album-viewer-name").textContent();
  const cdp = await page.context().newCDPSession(page);
  const { width, height } = page.viewportSize();
  const point = (fraction) => ({
    x: width * (direction > 0 ? fraction : 1 - fraction),
    y: height / 2,
    id: 0,
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point(0.8)],
  });
  for (const fraction of [0.7, 0.6, 0.5, 0.4, 0.25, 0.1])
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point(fraction)],
    });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(page.locator("#album-viewer-name")).not.toHaveText(name);
  await cdp.detach();
}
