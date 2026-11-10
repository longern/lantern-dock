import test from "node:test";
import assert from "node:assert/strict";
import { readRecords } from "../src/lib/records.js";

test("an unresolved backend key stays pending without accessing storage", () => {
  const state = readRecords("", "recent", {
    getItem() {
      throw new Error("must not read");
    },
  });
  assert.deepEqual(state, { status: "pending", items: [], error: null });
});

test("missing and explicitly empty records are confirmed empty", () => {
  for (const value of [null, "[]"]) {
    const state = readRecords("backend:", "recent", { getItem: () => value });
    assert.deepEqual(state, { status: "ready", items: [], error: null });
  }
});

test("record reads use the selected backend namespace and preserve visit timestamps", () => {
  const item = { path: "/photo.png", name: "photo.png", visitedAt: 20 };
  const state = readRecords("new-backend:", "recent", {
    getItem(key) {
      assert.equal(key, "new-backend:recent");
      return JSON.stringify([item]);
    },
  });
  assert.equal(state.status, "ready");
  assert.deepEqual(state.items, [item]);
});

test("storage errors and corrupt records are errors, never confirmed empty", () => {
  const cases = ["", "{", "null", "{}", "[null]", '[{"path":"/missing-name"}]'];
  const stores = cases.map((value) => ({ getItem: () => value }));
  stores.push({
    getItem() {
      throw new DOMException("denied", "SecurityError");
    },
  });
  for (const storage of stores) {
    const state = readRecords("backend:", "recent", storage);
    assert.equal(state.status, "error");
    assert(state.error instanceof Error);
    assert.deepEqual(state.items, []);
  }
});

test("a later successful read can recover from a temporary storage failure", () => {
  let blocked = true;
  const storage = {
    getItem() {
      if (blocked) throw new Error("temporarily denied");
      return "[]";
    },
  };
  assert.equal(readRecords("backend:", "recent", storage).status, "error");
  blocked = false;
  assert.equal(readRecords("backend:", "recent", storage).status, "ready");
});
