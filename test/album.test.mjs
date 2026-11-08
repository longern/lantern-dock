import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { groupMediaByDate } from "../src/lib/album.js";

const now = new Date(2026, 10, 7, 12);
const stamp = (day, hour = 12, year = 2026, month = 10) => new Date(year, month, day, hour).toISOString();
const photo = (name, modified) => ({ name, path: "/" + name, kind: "image", isDirectory: false, modified });

test("album groups by modification day newest first, not visits or input order", () => {
  const old = { ...photo("old.png", stamp(3)), visitedAt: 999999 };
  const morning = photo("morning.png", stamp(7, 8));
  const latest = { ...photo("latest.png", stamp(7, 16)), visitedAt: 1 };
  const input = [old, morning, latest];
  const groups = groupMediaByDate(input, now);
  assert.deepEqual(groups.map(({ key }) => key), ["2026-11-07", "2026-11-03"]);
  assert.deepEqual(groups[0].items, [latest, morning]);
  assert.deepEqual(groups[1].items, [old]);
  assert.deepEqual(input, [old, morning, latest], "grouping must not mutate entries");
});

test("images and videos share date groups and chronological order, including unknown dates", () => {
  const image = photo("photo.png", stamp(7, 12));
  const video = { ...photo("clip.mp4", stamp(7, 13)), kind: "video" };
  const older = { ...photo("old.webm", stamp(6)), kind: "video" };
  const unknown = { ...photo("undated.mov", ""), kind: "video" };
  const groups = groupMediaByDate([image, older, unknown, video, { ...image, kind: "audio" }], now);
  assert.deepEqual(groups.map(({ label }) => label), ["今天", "昨天", "日期未知"]);
  assert.deepEqual(groups.map(({ items }) => items), [[video, image], [older], [unknown]]);
  assert.deepEqual(groupMediaByDate([video], now)[0].items, [video]);
});

test("date headings distinguish today, yesterday, older days and years", () => {
  const groups = groupMediaByDate([
    photo("today.png", stamp(7)), photo("yesterday.png", stamp(6)),
    photo("older.png", stamp(3)), photo("last-year.png", stamp(3, 12, 2025)),
  ], now);
  assert.deepEqual(groups.map(({ label }) => label), ["今天", "昨天", "11月3日", "2025年11月3日"]);
});

test("every non-current year is explicit, including yesterday across New Year and future dates", () => {
  const groups = groupMediaByDate([
    photo("new-year.png", stamp(31, 12, 2025, 11)),
    photo("today.png", stamp(1, 12, 2026, 0)),
    photo("future.png", stamp(1, 12, 2027, 0)),
  ], new Date(2026, 0, 1, 12));
  assert.deepEqual(groups.map(({ label }) => label), ["2027年1月1日", "今天", "2025年12月31日"]);
  assert.equal(groupMediaByDate([photo("yesterday.png", stamp(1, 12, 2026, 0))], new Date(2026, 0, 2, 12))[0].label, "昨天");
});

test("missing or invalid dates stay together at the end without inventing a date", () => {
  const unknown = [undefined, null, "", "invalid", 0, "0", "2026-02-30T08:00:00Z", "Mon, 30 Feb 2026 08:00:00 GMT"]
    .map((value, index) => photo(`unknown-${index}.png`, value));
  const groups = groupMediaByDate([...unknown, photo("valid.png", stamp(3))], now);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].key, "unknown");
  assert.equal(groups[1].label, "日期未知");
  assert.deepEqual(groups[1].items, unknown);
  assert.equal(groupMediaByDate([photo("epoch.png", "1970-01-01T00:00:00Z")], now)[0].items.length, 1);
});

test("standard HTTP dates and ISO timestamps retain the same actual modification time", () => {
  const values = ["2026-11-07T08:00:00Z", "Sat, 07 Nov 2026 08:00:00 GMT", "Saturday, 07-Nov-26 08:00:00 GMT", "Sat Nov  7 08:00:00 2026"];
  const groups = groupMediaByDate(values.map((value, index) => photo(`${index}.png`, value)), now);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 4);
  assert.notEqual(groups[0].key, "unknown");
});

test("equal timestamps sort deterministically and non-media entries are excluded", () => {
  const a = photo("photo-2.png", stamp(7));
  const b = photo("photo-10.png", stamp(7));
  const groups = groupMediaByDate([b, { ...a, isDirectory: true }, { ...b, kind: "text" }, a], now);
  assert.deepEqual(groups[0].items, [a, b]);
  assert.deepEqual(groupMediaByDate([], now), []);
});

test("day grouping follows the browser-local timezone including daylight-saving boundaries", () => {
  const run = (zone, dates, current) => JSON.parse(execFileSync(process.execPath, ["--import", "./test/helpers/locale.mjs", "--input-type=module", "-e", `
    import { groupMediaByDate } from './src/lib/album.js';
    const photos = ${JSON.stringify(dates)}.map((modified, index) => ({ name: String(index), path: '/' + index, kind: 'image', modified }));
    console.log(JSON.stringify(groupMediaByDate(photos, new Date(${JSON.stringify(current)})).map(({key,label}) => ({key,label}))));
  `], { encoding: "utf8", env: { ...process.env, TZ: zone } }));
  assert.deepEqual(run("Asia/Shanghai", ["2026-11-06T16:30:00Z", "2026-11-06T15:30:00Z"], "2026-11-07T04:00:00Z"), [
    { key: "2026-11-07", label: "今天" }, { key: "2026-11-06", label: "昨天" },
  ]);
  assert.deepEqual(run("America/New_York", ["2026-03-09T03:30:00Z", "2026-03-08T04:30:00Z"], "2026-03-09T16:00:00Z"), [
    { key: "2026-03-08", label: "昨天" }, { key: "2026-03-07", label: "3月7日" },
  ]);
  assert.deepEqual(run("America/New_York", ["2026-11-07"], "2026-11-07T17:00:00Z"), [
    { key: "2026-11-07", label: "今天" },
  ]);
  assert.deepEqual(run("Asia/Shanghai", ["2025-12-31T15:30:00Z", "2025-12-31T16:30:00Z"], "2026-01-01T04:00:00Z"), [
    { key: "2026-01-01", label: "今天" }, { key: "2025-12-31", label: "2025年12月31日" },
  ]);
});
