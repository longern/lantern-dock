import test from "node:test";
import assert from "node:assert/strict";
import { afterOverlayEntry } from "../src/lib/overlay-entry.js";

const pending = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("overlay entry waits for all actual surface animations, including a paused animation", async () => {
  const first = pending(), second = pending(), child = pending();
  const node = { getAnimations: () => [
    { effect: { target: node }, finished: first.promise },
    { effect: { target: node }, finished: second.promise },
    { effect: { target: {} }, finished: child.promise },
  ] };
  let entries = 0;
  afterOverlayEntry(node, () => entries++);
  await settle();
  assert.equal(entries, 0);
  first.resolve();
  await settle();
  assert.equal(entries, 0, "one finished animation cannot release the paused one");
  second.resolve();
  await settle();
  assert.equal(entries, 1, "child animations do not hold the surface open");
  await settle();
  assert.equal(entries, 1);
});

test("closing or replacing a preview cancels its stale entry callback", async () => {
  const animation = pending();
  const node = { getAnimations: () => [{ effect: { target: node }, finished: animation.promise }] };
  let entered = false;
  const cancel = afterOverlayEntry(node, () => { entered = true; });
  cancel();
  animation.resolve();
  await settle();
  assert.equal(entered, false);
});

test("removing an entry animation completes the active preview without an unhandled rejection", async () => {
  const animation = pending();
  const node = { getAnimations: () => [{ effect: { target: node }, finished: animation.promise }] };
  let entries = 0;
  afterOverlayEntry(node, () => entries++);
  animation.reject(new Error("Animation cancelled by reduced motion"));
  await settle();
  assert.equal(entries, 1);
});

test("reduced motion completes asynchronously without a fixed animation delay", async () => {
  let entries = 0;
  afterOverlayEntry({ getAnimations: () => [] }, () => entries++);
  assert.equal(entries, 0);
  await settle();
  assert.equal(entries, 1);
});

test("an immediately dismissed reduced-motion preview cannot finish a newer entry", async () => {
  let entries = 0;
  afterOverlayEntry({ getAnimations: () => [] }, () => entries++)();
  await settle();
  assert.equal(entries, 0);
});

test("engines without Web Animations use computed CSS timing and support cleanup", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  globalThis.getComputedStyle = () => ({
    animationName: "entry, none", animationDuration: "0.2s, 5s", animationDelay: "50ms",
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "getComputedStyle", original);
    else delete globalThis.getComputedStyle;
  });
  let entries = 0;
  afterOverlayEntry({}, () => entries++);
  t.mock.timers.tick(249);
  assert.equal(entries, 0);
  t.mock.timers.tick(1);
  assert.equal(entries, 1);
  const cancel = afterOverlayEntry({}, () => entries++);
  cancel();
  t.mock.timers.tick(1000);
  assert.equal(entries, 1);
});
