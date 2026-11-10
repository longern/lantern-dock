import test from "node:test";
import assert from "node:assert/strict";
import { breakpoints } from "../src/lib/breakpoints.js";
import { resolveBreakpointMedia } from "../scripts/breakpoint-media.mjs";

test("named media queries use MUI's exclusive upper bounds and reject invalid ranges", () => {
  assert.equal(breakpoints.up("md"), "(min-width: 900px)");
  assert.equal(breakpoints.down("sm"), "(max-width: 599.95px)");
  assert.equal(
    breakpoints.only("lg"),
    "(min-width: 1200px) and (max-width: 1535.95px)",
  );
  assert.equal(breakpoints.only("xl"), "(min-width: 1536px)");
  assert.throws(() => breakpoints.down("tablet"), /Unknown breakpoint/);
  assert.throws(() => breakpoints.up("toString"), /Unknown breakpoint/);
  assert.throws(
    () => breakpoints.between("lg", "sm"),
    /Invalid breakpoint range/,
  );
});

test("CSS aliases compile from the shared definitions, preserving unrelated media conditions", () => {
  assert.equal(
    resolveBreakpointMedia("(--between-md-lg)"),
    breakpoints.between("md", "lg"),
  );
  assert.equal(
    resolveBreakpointMedia("(--up-xl), (--down-sm) and (hover: hover)"),
    `${breakpoints.up("xl")}, ${breakpoints.down("sm")} and (hover: hover)`,
  );
  assert.equal(
    resolveBreakpointMedia("(prefers-reduced-motion: reduce)"),
    "(prefers-reduced-motion: reduce)",
  );
  assert.throws(
    () => resolveBreakpointMedia("(--between-sm)"),
    /Unknown breakpoint/,
  );
  assert.throws(
    () => resolveBreakpointMedia("(--down-unknown)"),
    /Unknown breakpoint/,
  );
});
