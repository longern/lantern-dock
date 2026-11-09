import { expect } from "@playwright/test";

export async function holdItem(page, item) {
  await item.scrollIntoViewIfNeeded();
  await item.evaluate(async node => {
    await Promise.all((node.closest("dialog")?.getAnimations() || []).map(animation => animation.finished.catch(() => {})));
  });
  const box = await item.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  try {
    const point = { x: box.x + Math.min(100, box.width / 2), y: box.y + box.height / 2, id: 0 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await expect(page.locator(".selection-panel")).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
}
