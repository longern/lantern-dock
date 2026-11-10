import test from "node:test";
import assert from "node:assert/strict";
import {
  fileCategories,
  matchesCategory,
  categoryLabel,
} from "../src/lib/categories.js";
import { kindFor } from "../src/lib/dav.js";

const item = (name, isDirectory = false) => ({
  name,
  isDirectory,
  kind: kindFor(name, isDirectory),
});

test("album mixes images and videos while the separate type filters stay specific", () => {
  assert.equal(fileCategories[0].kind, "album");
  assert.equal(categoryLabel("album"), "相册");
  assert.equal(categoryLabel("image"), "图片");
  for (const name of ["photo.png", "clip.mp4", "movie.MOV", "recording.webm"])
    assert.equal(matchesCategory(item(name), "album"), true, name);
  for (const name of ["notes.md", "music.mp3", "archive.zip"])
    assert.equal(matchesCategory(item(name), "album"), false, name);
  assert.equal(matchesCategory(item("folder.mp4", true), "album"), false);
  assert.equal(matchesCategory(item("clip.mp4"), "image"), false);
  assert.equal(matchesCategory(item("photo.png"), "video"), false);
});

test("home categories have unique filters and match image, video and audio files", () => {
  assert.equal(new Set(fileCategories.map(({ kind }) => kind)).size, 5);
  for (const [name, kind] of [
    ["PHOTO.JPG", "image"],
    ["clip.mp4", "video"],
    ["song.flac", "audio"],
  ]) {
    assert.equal(matchesCategory(item(name), kind), true);
    assert.equal(matchesCategory(item(name), "text"), false);
  }
});

test("documents include PDF, plain text and office files without enabling binary previews", () => {
  for (const name of [
    "notes.md",
    "data.csv",
    "guide.PDF",
    "report.DOCX",
    "sheet.xlsx",
    "slides.pptx",
    "letter.odt",
    "memo.rtf",
  ])
    assert.equal(matchesCategory(item(name), "text"), true, name);
  assert.equal(kindFor("report.docx", false), "file");
  assert.equal(matchesCategory(item("backup.zip"), "text"), false);
});

test("books match ebook formats, not PDF documents or similarly named folders", () => {
  for (const name of [
    "novel.EPUB",
    "book.mobi",
    "reader.azw3",
    "book.fb2",
    "scan.djvu",
    "comic.cbz",
  ])
    assert.equal(matchesCategory(item(name), "book"), true, name);
  assert.equal(matchesCategory(item("guide.pdf"), "book"), false);
  assert.equal(matchesCategory(item("novel.epub", true), "book"), false);
  for (const { kind } of fileCategories)
    assert.equal(matchesCategory(item("folder", true), kind), false);
  assert.equal(matchesCategory(item("folder", true), ""), true);
  assert.equal(matchesCategory(item("unknown.bin"), ""), true);
});
