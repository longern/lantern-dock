import test from "node:test";
import assert from "node:assert/strict";
import { DAVClient } from "../src/lib/dav.js";

test("DAV only reports confirmed missing original files, not auth or server failures", async () => {
  for (const status of [200, 404, 410, 401, 403, 500]) {
    const missing = [];
    const calls = [];
    const client = new DAVClient(
      {
        request: async (path, options) => {
          calls.push({ path, options });
          return new Response(null, { status });
        },
      },
      { rootPath: "/dav/" },
    );
    client.onMissing = (path) => missing.push(path);
    const response = await client.read("/dav/a.txt", undefined, {}, "HEAD");
    assert.equal(response.status, status);
    assert.deepEqual(
      missing,
      [404, 410].includes(status) ? ["/dav/a.txt"] : [],
    );
    assert.equal(calls[0].options.cache, "no-store");
    client.dispose();
  }
});

test("aborted and out-of-root reads cannot invalidate recent records", async () => {
  const controller = new AbortController();
  const missing = [];
  const client = new DAVClient(
    {
      request: async () => {
        controller.abort();
        return new Response(null, { status: 404 });
      },
    },
    { rootPath: "/dav/" },
  );
  client.onMissing = (path) => missing.push(path);
  await client.read("/dav/a.txt", controller.signal);
  assert.deepEqual(missing, []);
  await assert.rejects(client.read("/api/images/a.jpg"), {
    code: "OUTSIDE_ROOT",
  });
  assert.deepEqual(missing, []);
  client.dispose();
});
