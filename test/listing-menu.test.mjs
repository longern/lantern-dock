import test from "node:test";
import assert from "node:assert/strict";
import { captureListingMenuMotion, getListingMenuPlacement } from "../src/lib/listing-menu.js";

const viewport = { left: 0, top: 0, width: 1000, height: 800 };
const menu = { width: 208, height: 300 };

test("a menu below its trigger grows from the trigger center at its upper edge", () => {
  assert.deepEqual(getListingMenuPlacement({ left: 912, right: 960, top: 12, bottom: 60 }, menu, viewport), {
    left: 752, top: 66, placement: "bottom", originX: 184, originY: 0,
  });
});

test("a menu flipped above the trigger uses its bottom edge as the pivot", () => {
  assert.deepEqual(getListingMenuPlacement({ left: 912, right: 960, top: 740, bottom: 788 }, menu, viewport), {
    left: 752, top: 434, placement: "top", originX: 184, originY: 300,
  });
});

test("horizontal clamping moves the pivot with the trigger rather than keeping a top-right origin", () => {
  assert.deepEqual(getListingMenuPlacement({ left: 12, right: 60, top: 12, bottom: 60 }, menu, viewport), {
    left: 8, top: 66, placement: "bottom", originX: 28, originY: 0,
  });
});

test("visual viewport offsets and its right gutter are included in placement and origin", () => {
  const area = { left: 100, top: 200, width: 400, height: 600 };
  assert.deepEqual(getListingMenuPlacement({ left: 460, right: 508, top: 210, bottom: 258 }, menu, area), {
    left: 284, top: 264, placement: "bottom", originX: 200, originY: 0,
  });
});

test("vertical clamping recomputes a pivot inside the surface when neither side fits", () => {
  assert.deepEqual(getListingMenuPlacement(
    { left: 912, right: 960, top: 160, bottom: 208 },
    menu, { ...viewport, height: 400 },
  ), {
    left: 752, top: 8, placement: "top", originX: 184, originY: 152,
  });
});

test("a scrolled-off trigger uses the nearest visible corner rather than a distant pivot", () => {
  assert.deepEqual(getListingMenuPlacement({ left: -100, right: -52, top: -100, bottom: -52 }, menu, viewport), {
    left: 8, top: 8, placement: "bottom", originX: 0, originY: 0,
  });
  assert.deepEqual(getListingMenuPlacement({ left: 1100, right: 1148, top: 900, bottom: 948 }, menu, viewport), {
    left: 784, top: 492, placement: "top", originX: 208, originY: 300,
  });
});

test("fractional anchor and surface sizes do not round the animation origin away from the anchor", () => {
  const placed = getListingMenuPlacement(
    { left: 800.25, right: 848.75, top: 12.5, bottom: 60.5 },
    { width: 208.5, height: 300.25 }, viewport,
  );
  assert.equal(placed.left, 640.25);
  assert.equal(placed.originX, 184.25);
  assert.equal(placed.top, 66.5);
});

test("an interrupted animation snapshots its displayed opacity and transform for the next direction", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  const properties = new Map();
  const surface = { style: { setProperty: (name, value) => properties.set(name, value) } };
  globalThis.getComputedStyle = (node) => {
    assert.equal(node, surface);
    return { opacity: "0.63", transform: "matrix(0.926, 0, 0, 0.926, 0, 0)" };
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "getComputedStyle", previous);
    else delete globalThis.getComputedStyle;
  });
  captureListingMenuMotion(surface);
  assert.deepEqual([...properties], [
    ["--menu-from-opacity", "0.63"],
    ["--menu-from-transform", "matrix(0.926, 0, 0, 0.926, 0, 0)"],
  ]);
  assert.doesNotThrow(() => captureListingMenuMotion(null));
});
