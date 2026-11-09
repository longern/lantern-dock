import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPaths } from "../src/lib/selection.js";

const order = ["/folder/", "/a.txt", "/b.txt", "/c.txt", "/d.txt"];
const empty = () => ({ paths: new Set(), anchor: null, mode: null });
const paths = state => [...state.paths].sort();

test("ordinary selection replaces and modifier selection toggles files and folders", () => {
  let state = selectPaths(empty(), order, order[0]);
  state = selectPaths(state, order, order[2], { toggle: true });
  assert.deepEqual(paths(state), [order[2], order[0]].sort());
  state = selectPaths(state, order, order[0], { toggle: true });
  assert.deepEqual(paths(state), [order[2]]);
  state = selectPaths(state, order, order[4]);
  assert.deepEqual(paths(state), [order[4]]);
});

test("Shift replaces a range and keeps its original anchor while reversing direction", () => {
  let state = selectPaths(empty(), order, order[2]);
  state = selectPaths(state, order, order[4], { range: true });
  assert.deepEqual(paths(state), order.slice(2).sort());
  state = selectPaths(state, order, order[0], { range: true });
  assert.deepEqual(paths(state), order.slice(0, 3).sort());
  assert.equal(state.anchor, order[2]);
});

test("Ctrl/Command+Shift extends a range without removing disjoint selections", () => {
  let state = selectPaths(empty(), order, order[0]);
  state = selectPaths(state, order, order[3], { toggle: true });
  state = selectPaths(state, order, order[4], { toggle: true, range: true });
  assert.deepEqual(paths(state), [order[0], order[3], order[4]].sort());
});

test("ranges follow the visible sort order and cannot select absent resources", () => {
  const sorted = [order[4], order[0], order[2]];
  let state = selectPaths(empty(), sorted, order[4]);
  state = selectPaths(state, sorted, order[2], { range: true });
  assert.deepEqual(paths(state), sorted.slice().sort());
  assert.equal(selectPaths(state, sorted, order[1]), state);
});

test("missing anchors start a new range at the current target", () => {
  const state = selectPaths({ paths: new Set([order[0]]), anchor: "/deleted", mode: "desktop" }, order, order[3], { range: true });
  assert.deepEqual(paths(state), [order[3]]);
  assert.equal(state.anchor, order[3]);
});

test("touch mode remains active when its last item is deselected", () => {
  let state = selectPaths(empty(), order, order[0], { mode: "touch" });
  state = selectPaths(state, order, order[0], { mode: "touch", toggle: true });
  assert.equal(state.paths.size, 0);
  assert.equal(state.mode, "touch");
  const desktop = selectPaths(selectPaths(empty(), order, order[0]), order, order[0], { toggle: true });
  assert.equal(desktop.mode, null);
});
