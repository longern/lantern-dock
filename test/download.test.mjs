import { test } from "node:test";
import assert from "node:assert/strict";
import { receiveFile, createDownloadFile } from "../src/lib/download.js";

const file = { path: "/a.txt", name: "a.txt", size: 0 };
const signal = () => new AbortController().signal;
test("fallback download preserves bytes and reports file progress", async () => {
  const progress = [];
  const blob = await receiveFile({ get: async () => new Response("hello", { headers: { "Content-Length": "5", "Content-Type": "text/plain" } }) }, file,
    { signal: signal(), budget: 5, onProgress: value => progress.push(value) });
  assert.equal(await blob.text(), "hello");
  assert.equal(blob.type, "text/plain");
  assert.deepEqual(progress.at(-1), { received: 5, total: 5 });
});
test("oversized declared responses are cancelled before buffering", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Length": "100" } });
  await assert.rejects(receiveFile({ get: async () => response }, file, { signal: signal(), budget: 5, onProgress() {}, limitCode: "DOWNLOAD_BATCH_MEMORY_LIMIT" }), { code: "DOWNLOAD_BATCH_MEMORY_LIMIT" });
  assert.equal(cancelled, true);
});
test("unknown lengths cannot exceed the remaining batch memory budget", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; } });
  await assert.rejects(receiveFile({ get: async () => new Response(body) }, file, { signal: signal(), budget: 5, onProgress() {} }), { code: "DOWNLOAD_MEMORY_LIMIT" });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
test("cancelling an idle body releases its pending read", async () => {
  const controller = new AbortController();
  const body = new ReadableStream({});
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = receiveFile({ get: async () => new Response(body) }, file, { signal: controller.signal, budget: 10, onProgress: started });
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(body.locked, false);
});
test("native destinations stream directly without the fallback memory cap", async () => {
  const writes = [];
  const result = await receiveFile({ get: async () => new Response("abcdef") }, file, { signal: signal(), budget: 0, sink: { write: async chunk => writes.push(chunk) }, onProgress() {} });
  assert.equal(result, null);
  assert.equal(new TextDecoder().decode(writes[0]), "abcdef");
});
test("destination collisions preserve existing files and directories", async () => {
  const created = [];
  const directory = { async getFileHandle(name, options) {
    if (options?.create) { created.push(name); return { name }; }
    if (name === "a.txt") return { name };
    if (name === "a (1).txt") throw new DOMException("Directory", "TypeMismatchError");
    throw new DOMException("Missing", "NotFoundError");
  } };
  assert.equal((await createDownloadFile(directory, "a.txt", signal())).name, "a (2).txt");
  assert.deepEqual(created, ["a (2).txt"]);
  await assert.rejects(createDownloadFile(directory, "../a.txt", signal()), { code: "INVALID_PATH" });
});
test("aborted downloads never issue a file request", async () => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  await assert.rejects(receiveFile({ get: async () => { called = true; } }, file, { signal: controller.signal, budget: 10, onProgress() {} }), { name: "AbortError" });
  assert.equal(called, false);
});
