import test from "node:test";
import assert from "node:assert/strict";
import { fileListing } from "../src/lib/file-listing.js";

const file = (name, visitedAt = 0, modified = "2020-01-01") => ({
  name, path: "/" + name, kind: "text", isDirectory: false, visitedAt, modified,
});
const directory = [file("directory-only.md"), file("another.md")];
const library = (overrides = {}) => ({
  mode: "home", entries: directory, sort: "recent", kind: "", query: "", ...overrides,
});
const records = (recent = [], favorites = []) => ({ recent, favorites });

test("home falls back to directory files only when recent history is empty", () => {
  const result = fileListing(library(), records());
  assert.equal(result.recent, false);
  assert.equal(result.usesDirectory, true);
  assert.equal(result.sort, "name");
  assert.deepEqual(result.entries.map((item) => item.name), ["another.md", "directory-only.md"]);
  assert.deepEqual(fileListing(library({ entries: [] }), records()).entries, []);
});

test("home uses visit history, ordered by last visit rather than filename or modification date", () => {
  const older = file("aaa.md", 10, "2030-01-01");
  const newer = file("zzz.md", 20, "2000-01-01");
  const history = [older, newer];
  const result = fileListing(library(), records(history));
  assert.equal(result.recent, true);
  assert.equal(result.usesDirectory, false);
  assert.deepEqual(result.entries, [newer, older]);
  assert.deepEqual(history, [older, newer], "sorting must not mutate stored records");
});

test("no search results in recent history do not trigger directory fallback", () => {
  const result = fileListing(library({ query: "directory-only" }), records([file("recent.md", 20)]));
  assert.equal(result.recent, true);
  assert.equal(result.usesDirectory, false);
  assert.deepEqual(result.entries, []);
});

test("file navigation and type filtering use directory entries, not recent history", () => {
  const recent = [file("recent.md", 20)];
  const result = fileListing(library({ mode: "all", kind: "text", query: "directory" }), records(recent));
  assert.equal(result.recent, false);
  assert.equal(result.usesDirectory, true);
  assert.deepEqual(result.entries.map((item) => item.name), ["directory-only.md"]);
});

test("favorites keep their own source and never fall back to directory files", () => {
  const favorite = file("favorite.md");
  assert.deepEqual(fileListing(library({ mode: "favorites" }), records([], [favorite])).entries, [favorite]);
  const empty = fileListing(library({ mode: "favorites" }), records([file("recent.md")]));
  assert.equal(empty.usesDirectory, false);
  assert.deepEqual(empty.entries, []);
});

test("home sorting remains selectable and handles missing visit timestamps stably", () => {
  const first = file("zzz.md");
  const second = file("aaa.md");
  assert.deepEqual(fileListing(library(), records([first, second])).entries, [first, second]);
  assert.deepEqual(fileListing(library({ sort: "name" }), records([first, second])).entries, [second, first]);
});
