import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRoute,
  filesHref,
  albumHref,
  libraryLocation,
  safeReturnPath,
  uploadHref,
} from "../shared/routes.js";

test("resource URLs preserve filenames and distinguish directories without depending on the NAS mount", () => {
  const name = encodeURIComponent("海边 #1? 100%.jpg");
  const href = filesHref("照片/" + name);
  assert.equal(href, "/files/" + encodeURIComponent("照片") + "/" + name);
  assert.equal(parseRoute(href).file, encodeURIComponent("照片") + "/" + name);
  assert.equal(
    parseRoute(filesHref("folder.jpg", { directory: true })).file,
    null,
  );
  assert.equal(parseRoute(filesHref("README")).file, "README");
  assert.equal(parseRoute(albumHref("照片")).surface, "album");
  assert.equal(parseRoute("/files/").directory, "");
  for (const path of [
    "/files/a%2Fb.jpg",
    "/files/a%5Cb.jpg",
    "/files/%00.jpg",
    "/files/%GG",
    "/files/a//b.jpg",
    "/unknown",
    "/album/photo.jpg",
  ])
    assert.equal(parseRoute(path).page, "not-found", path);
});
test("preview background is presentation state, while a copied URL can reconstruct its own directory", () => {
  const route = parseRoute("/files/trip/photo.jpg?view=album");
  assert.deepEqual(libraryLocation(route).directory, "trip/");
  assert.equal(libraryLocation(route).surface, "album");
  assert.equal(
    libraryLocation(route, { previewFrom: "/favorites" }).surface,
    "favorites",
  );
  assert.equal(
    libraryLocation(route, { previewFrom: "//evil.example" }).surface,
    "home",
  );
  assert.equal(parseRoute("/files/docs/?q=hello&type=video").query, "hello");
  assert.equal(parseRoute("/files/docs/?type=unknown").type, "");
});
test("login destinations stay on known site pages and never carry upload credentials", () => {
  for (const value of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/api/config",
    "/auth/callback",
    "/upload#token=secret",
    "/account\nLocation:x",
    "/missing",
  ])
    assert.equal(safeReturnPath(value), "/account", value);
  assert.equal(
    safeReturnPath("/files/a%20b.jpg?view=album"),
    "/files/a%20b.jpg?view=album",
  );
  assert.equal(
    safeReturnPath("/admin/inbox?link=public-id"),
    "/admin/inbox?link=public-id",
  );
});
test("the upload secret lives only in the fragment and old hashes are not routes", () => {
  const token = "a".repeat(43),
    url = new URL(uploadHref(token), "https://site.example");
  assert.equal(url.pathname, "/upload");
  assert.equal(url.search, "");
  assert.equal(parseRoute(url.href).token, token);
  assert.equal(parseRoute("/#/account").surface, "home");
  assert.equal(parseRoute("/account").page, "account");
});
