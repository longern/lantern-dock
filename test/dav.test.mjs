import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePath,
  withinRoot,
  kindFor,
  limitedBytes,
} from "../src/lib/dav.js";
test("canonical paths preserve encoding and stay inside a DAV mount", () => {
  assert.equal(
    normalizePath("/dav/%E7%85%A7%E7%89%87/a%20b.jpg"),
    "/dav/%E7%85%A7%E7%89%87/a%20b.jpg",
  );
  for (const p of [
    "/dav/%2e%2e/secret",
    "/dav/%2fsecret",
    "/dav/../secret",
    "/dav/\\secret",
    "/dav/a?x=1",
  ])
    assert.throws(() => normalizePath(p));
  assert.ok(withinRoot("/dav/a.jpg", "/dav/"));
  assert.ok(!withinRoot("/dav-private/a.jpg", "/dav/"));
  assert.equal(kindFor("PHOTO.JPG", false), "image");
});
test("preview limit checks both declared and streamed sizes", async () => {
  await assert.rejects(
    limitedBytes(
      new Response("abc", { headers: { "Content-Length": "999" } }),
      2,
    ),
    /限制/,
  );
  await assert.rejects(limitedBytes(new Response("abc"), 2), /限制/);
  assert.equal(
    new TextDecoder().decode(await limitedBytes(new Response("abc"), 3)),
    "abc",
  );
});
