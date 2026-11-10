import test from "node:test";
import assert from "node:assert/strict";
import { beginLogin } from "../src/lib/identity.js";

test("dismissing sign-in while proof preparation is pending never sends the login request", async () => {
  // Isolate the cached browser key so this exercises cancellation before the
  // proof is ready, rather than only cancellation of an in-flight fetch.
  const { beginLogin: start } =
    await import("../src/lib/identity.js?proof-cancellation");
  const previous = Object.fromEntries(
    ["indexedDB", "location", "fetch"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  let readKey, finishRead;
  const reading = new Promise((resolve) => {
    readKey = resolve;
  });
  let requests = 0,
    redirects = 0;
  try {
    globalThis.indexedDB = {
      open() {
        const request = {
          result: {
            transaction: () => ({
              objectStore: () => ({
                get() {
                  const saved = { result: pair };
                  finishRead = () => saved.onsuccess();
                  readKey();
                  return saved;
                },
              }),
            }),
            close() {},
          },
        };
        queueMicrotask(() => request.onsuccess());
        return request;
      },
    };
    globalThis.location = {
      origin: "https://site.example",
      assign: () => redirects++,
    };
    globalThis.fetch = async () => {
      requests++;
      return Response.json({ url: "https://sso.example/authorize" });
    };
    const controller = new AbortController();
    const login = start(controller.signal);
    await reading;
    controller.abort();
    finishRead();
    await assert.rejects(login, { name: "AbortError" });
    assert.equal(requests, 0);
    assert.equal(redirects, 0);
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("abandoned account navigation cannot issue a late login redirect", async () => {
  const previous = Object.fromEntries(
    ["indexedDB", "location", "fetch"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const redirects = [];
  const requests = [];
  let opens = 0;
  const request = (result) => {
    const pending = { result };
    queueMicrotask(() => pending.onsuccess?.());
    return pending;
  };
  try {
    globalThis.indexedDB = {
      open() {
        opens++;
        return request({
          transaction: () => ({
            objectStore: () => ({ get: () => request(pair) }),
          }),
          close() {},
        });
      },
    };
    globalThis.location = {
      origin: "https://site.example",
      assign: (url) => redirects.push(url),
    };
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return Response.json({ url: "https://sso.example/authorize" });
    };

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await assert.rejects(beginLogin(alreadyCancelled.signal), {
      name: "AbortError",
    });
    assert.equal(
      opens,
      0,
      "an already cancelled action must not open identity storage",
    );
    assert.equal(requests.length, 0);

    let finish;
    let started;
    const pending = new Promise((resolve) => {
      started = resolve;
    });
    globalThis.fetch = (url, options) => {
      requests.push({ url, options });
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const cancelled = new AbortController();
    const login = beginLogin(cancelled.signal);
    await pending;
    assert.equal(requests[0].options.signal, cancelled.signal);
    cancelled.abort();
    // Even a response racing with cancellation must not navigate the new page.
    finish(Response.json({ url: "https://sso.example/authorize" }));
    await assert.rejects(login, { name: "AbortError" });
    assert.deepEqual(redirects, []);

    globalThis.fetch = async () =>
      Response.json({ url: "https://sso.example/authorize" });
    await beginLogin();
    assert.deepEqual(
      redirects,
      ["https://sso.example/authorize"],
      "existing callers without a signal still work",
    );
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
