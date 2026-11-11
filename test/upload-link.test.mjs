import test from "node:test";
import assert from "node:assert/strict";
import { clipboardUploadHref } from "../src/lib/upload-link.js";

const origin = "https://site.example";
const token = "a_-".repeat(14) + "A";
const href = "/upload#token=" + token;

test("clipboard upload links are recognized inside copied messages and keep secrets in the fragment", () => {
  for (const text of [
    origin + href,
    `请上传到：${origin}${href}。`,
    `Upload files here (${origin}${href}).`,
    `https://unrelated.example/\n${origin}${href}`,
    `${origin}/upload#token=invalid\n${origin}${href}`,
  ])
    assert.equal(clipboardUploadHref(text, origin), href, text);
  assert.equal(
    clipboardUploadHref(
      `${origin}/upload?tracking=example#token=${token}`,
      origin,
    ),
    href,
  );
});

test("clipboard navigation rejects other sites, credentials, malformed tokens and unrelated routes", () => {
  for (const text of [
    "",
    "ordinary clipboard text",
    `https://other.example${href}`,
    `http://site.example${href}`,
    `https://site.example.evil.example${href}`,
    `https://user:secret@site.example${href}`,
    `${origin}/files/#token=${token}`,
    `${origin}/upload?token=${token}`,
    `${origin}/upload#token=${token}extra`,
    `javascript:alert(1)`,
    href,
  ])
    assert.equal(clipboardUploadHref(text, origin), null, text);
});
