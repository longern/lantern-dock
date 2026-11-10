import test from "node:test";
import assert from "node:assert/strict";
import {
  AdminClient,
  adminAccess,
  createLinkInput,
  linkMetadata,
  linkState,
  localDateTime,
  uploadLinkURL,
} from "../src/lib/admin.js";

const identity = {
  status: "authenticated",
  user: { sub: "user", issuer: "https://site.example" },
};
const account = {
  user: { role: "admin" },
  capabilities: { adminLinks: true, adminInbox: true },
};
const link = {
  id: "link-id",
  title: "Event photos",
  expiresAt: "2030-01-02T00:00:00Z",
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
  maxFiles: 4,
  revoked: false,
  usedBytes: 128,
  usedFiles: 1,
};

test("admin access requires verified NAS role and explicit capabilities", () => {
  assert.equal(adminAccess(identity, { status: "ready", account }), "ready");
  assert.equal(
    adminAccess(identity, {
      status: "ready",
      account: { ...account, user: { role: "user" } },
    }),
    "forbidden",
  );
  assert.equal(
    adminAccess(identity, {
      status: "ready",
      account: { ...account, capabilities: {} },
    }),
    "unsupported",
  );
  assert.equal(
    adminAccess(identity, {
      status: "ready",
      account: { ...account, capabilities: { adminLinks: "true" } },
    }),
    "unsupported",
  );
  assert.equal(
    adminAccess(identity, { status: "loading", account }),
    "checking",
  );
  assert.equal(adminAccess(identity, { status: "idle" }), "checking");
  assert.equal(
    adminAccess(identity, {
      status: "error",
      error: { code: "NAS_NOT_CONFIGURED" },
    }),
    "not-configured",
  );
  assert.equal(
    adminAccess(identity, { status: "error", account }),
    "nas-error",
  );
  assert.equal(
    adminAccess(identity, {
      status: "error",
      error: { code: "LOGIN_REQUIRED" },
    }),
    "identity-error",
  );
  assert.equal(
    adminAccess(identity, { status: "error", error: { kind: "unauthorized" } }),
    "unverified",
  );
  assert.equal(
    adminAccess(identity, {
      status: "error",
      error: { kind: "identity-mismatch" },
    }),
    "unverified",
  );
  assert.equal(
    adminAccess({ status: "signed-out" }, { status: "ready", account }),
    "signed-out",
  );
  assert.equal(
    adminAccess({ status: "loading" }, { status: "ready", account }),
    "checking",
  );
  assert.equal(
    adminAccess({ status: "error" }, { status: "ready", account }),
    "identity-error",
  );
});

test("link metadata never retains secrets or unrecognized fields", () => {
  const value = linkMetadata({
    ...link,
    token: "secret",
    url: "https://site/#secret",
    token_hash: "secret",
  });
  assert.deepEqual(value, link);
  for (const patch of [
    { maxFiles: 0 },
    { usedBytes: -1 },
    { id: "../../secret" },
    { expiresAt: "invalid" },
    { revoked: "false" },
    { maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(() => linkMetadata({ ...link, ...patch }));
});

test("upload URL uses only a fragment and never persists source query parameters", () => {
  const token = "A".repeat(43);
  assert.equal(
    uploadLinkURL(token, "https://site.example/?secret=not-copied/admin"),
    `https://site.example/upload#token=${token}`,
  );
  for (const value of ["", "x", "A".repeat(44), "../../token", "#".repeat(43)])
    assert.throws(() => uploadLinkURL(value, "https://site.example"));
});

test("link state prioritizes revocation and expiry before usage", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(linkState(link, now), "active");
  assert.equal(
    linkState({ ...link, revoked: true, usedFiles: 4 }, now),
    "revoked",
  );
  assert.equal(linkState(link, Date.parse(link.expiresAt)), "expired");
  assert.equal(linkState({ ...link, usedFiles: 4 }, now), "full");
  assert.equal(linkState({ ...link, usedBytes: 4096 }, now), "full");
});

const input = {
  title: " Event photos ",
  expiresAt: "2030-01-02T00:00",
  maxFileMiB: "1",
  maxTotalMiB: "2",
  maxFiles: "5",
};
const now = Date.parse("2030-01-01T00:00:00Z");
test("create validation preserves local dates and checks byte-based titles and limits", () => {
  const value = createLinkInput(input, now);
  assert.equal(value.title, "Event photos");
  assert.equal(value.maxFileBytes, 1048576);
  assert.equal(value.maxTotalBytes, 2097152);
  assert.equal(value.maxFiles, 5);
  assert.equal(value.expiresAt, new Date(input.expiresAt).toISOString());
  assert.equal(localDateTime(new Date(2030, 0, 2, 13, 45)), "2030-01-02T13:45");
  for (const patch of [
    { title: "" },
    { title: "\u0000name" },
    { title: "中".repeat(67) },
    { expiresAt: "invalid" },
    { expiresAt: "2020-01-01" },
    { maxFileMiB: "0" },
    { maxFiles: "1.5" },
    { maxFiles: "-1" },
    { maxTotalMiB: "0.5" },
    { maxTotalMiB: "Infinity" },
  ])
    assert.throws(() => createLinkInput({ ...input, ...patch }, now));
});

function fixture(body, status = 200, userAccount = account) {
  const calls = [];
  const transport = {
    config: { transport: "http", endpoint: "https://nas.example/dav/" },
    close() {
      calls.push({ close: true });
    },
    async request(path, options) {
      calls.push({ path, ...options });
      return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  const client = new AdminClient(userAccount, {
    transport,
    async grant(signal, scope) {
      calls.push({ scope, signal });
      return { access_token: "scoped-secret" };
    },
    async proof(method, uri, token) {
      calls.push({ method, uri, token });
      return "proof";
    },
  });
  return { client, calls };
}

test("each admin request obtains its operation scope and DPoP proof directly to NAS", async () => {
  const { client, calls } = fixture({
    links: [{ ...link, token: "must-be-dropped" }],
    nextOffset: 100,
  });
  const signal = new AbortController().signal;
  const result = await client.links({ signal });
  assert.deepEqual(result, { items: [link], nextOffset: 100 });
  assert.equal(calls[0].scope, "links:read");
  assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(calls[1], {
    method: "GET",
    uri: "https://nas.example/api/admin/links?limit=100&offset=0",
    token: "scoped-secret",
  });
  assert.equal(calls[2].headers.Authorization, "DPoP scoped-secret");
  assert.equal(calls[2].headers.DPoP, "proof");
  assert.equal(calls[2].signal.aborted, false);
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("create and revoke use write scope; URL is exposed only on creation", async () => {
  globalThis.location = { href: "https://site.example/admin" };
  const { client, calls } = fixture({ link, token: "A".repeat(43) }, 201);
  const body = createLinkInput(input, now);
  const created = await client.create(body);
  assert.deepEqual(created, {
    link,
    url: `https://site.example/upload#token=${"A".repeat(43)}`,
  });
  assert.equal(calls[0].scope, "links:write");
  assert.equal(calls[2].method, "POST");
  assert.equal(calls[2].body, JSON.stringify(body));
  const revoked = fixture(null, 204);
  await revoked.client.revoke("link-id");
  assert.equal(revoked.calls[0].scope, "links:write");
  assert.equal(revoked.calls[2].method, "DELETE");
  assert.equal(revoked.calls[2].path, "/api/admin/links/link-id");
});

test("inbox and download use private scoped endpoints without bearer tokens in URLs", async () => {
  const upload = {
    id: "upload-id",
    linkId: "link-id",
    linkTitle: "Photos",
    name: "image.jpg",
    size: 123,
    status: "complete",
    createdAt: "2030-01-01T00:00:00Z",
  };
  const { client, calls } = fixture({ uploads: [upload], nextOffset: null });
  assert.deepEqual(await client.inbox({ linkId: "link-id", offset: 100 }), {
    items: [upload],
    nextOffset: null,
  });
  assert.equal(calls[0].scope, "inbox:read");
  assert.equal(
    calls[2].path,
    "/api/admin/inbox?limit=100&offset=100&linkId=link-id",
  );
  await client.download("upload-id");
  assert.equal(calls[3].scope, "inbox:read");
  assert.equal(calls[5].path, "/api/admin/inbox/upload-id/download");
  assert.throws(() => client.download("../private"));
});

test("unverified roles and unsupported capabilities never request a grant", async () => {
  for (const userAccount of [
    { ...account, user: { role: "user" } },
    { ...account, capabilities: {} },
  ]) {
    const { client, calls } = fixture({}, 200, userAccount);
    await assert.rejects(client.links());
    await assert.rejects(client.create({}));
    assert.equal(calls.length, 0);
  }
});

test("aborted and closed clients do not send requests, including abort during grant", async () => {
  const { client, calls } = fixture({ links: [], nextOffset: null });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.links({ signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(calls.length, 0);
  const pending = new AbortController();
  client.grant = async () => {
    pending.abort();
    return { access_token: "token" };
  };
  await assert.rejects(client.links({ signal: pending.signal }), {
    name: "AbortError",
  });
  assert.equal(calls.length, 0);
  client.close();
  await assert.rejects(client.links(), { name: "AbortError" });
  assert.deepEqual(calls, [{ close: true }]);
});

test("NAS errors preserve status for fresh authorization and never retry writes", async () => {
  const { client, calls } = fixture(
    { code: "ADMIN_REQUIRED", error: "Administrator access required" },
    403,
  );
  await assert.rejects(
    client.create({}),
    (error) => error.status === 403 && error.code === "ADMIN_REQUIRED",
  );
  assert.equal(
    calls.filter((call) => call.method === "POST" && call.path).length,
    1,
  );
  const broken = fixture({ links: [], nextOffset: "100" });
  await assert.rejects(broken.client.links());
});

const tick = (duration = 20) =>
  new Promise((resolve) => setTimeout(resolve, duration));
test("metadata deadline covers stalled grants and never starts a late write", async () => {
  const { client, calls } = fixture({}, 201);
  client.timeout = 10;
  let release, signal;
  client.grant = (value) => {
    signal = value;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  await assert.rejects(client.create({}), { name: "TimeoutError" });
  assert.equal(signal.aborted, true);
  release({ access_token: "late-token" });
  await tick();
  assert.equal(calls.length, 0);
});

test("metadata deadline bounds a fetch that ignores abort and cancels its late body", async () => {
  const { client, calls } = fixture({}, 201);
  client.timeout = 10;
  let release,
    signal,
    cancelled = false;
  client.transport.request = async (_path, options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  await assert.rejects(client.create({}), { name: "TimeoutError" });
  assert.equal(signal.aborted, true);
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 201 },
    ),
  );
  await tick();
  assert.equal(cancelled, true);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("metadata deadline aborts a stalled JSON body and releases its reader", async () => {
  const { client } = fixture({}, 200);
  client.timeout = 10;
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"links":'));
    },
    cancel() {
      cancelled = true;
    },
  });
  client.transport.request = async () => new Response(body);
  await assert.rejects(client.links(), { name: "TimeoutError" });
  await tick();
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("client close and explicit abort bound stalled mutations without waiting for timeout", async () => {
  for (const action of ["close", "abort"]) {
    const { client } = fixture({}, 204);
    client.timeout = 1000;
    const controller = new AbortController();
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    client.transport.request = () => {
      started();
      return new Promise(() => {});
    };
    const request = client.revoke("link-id", controller.signal);
    await ready;
    action === "close" ? client.close() : controller.abort();
    await assert.rejects(request, { name: "AbortError" });
  }
});

test("successful metadata transactions clear deadlines; downloads have no metadata time limit", async () => {
  const { client } = fixture({ links: [], nextOffset: null });
  client.timeout = 10;
  let signal;
  client.transport.request = async (_path, options) => {
    signal = options.signal;
    return new Response(JSON.stringify({ links: [], nextOffset: null }));
  };
  await client.links();
  await tick(25);
  assert.equal(signal.aborted, false);
  let release;
  client.transport.request = async (_path, options) => {
    signal = options.signal;
    await new Promise((resolve) => {
      release = resolve;
    });
    return new Response("file");
  };
  const request = client.download("upload-id");
  await tick(25);
  assert.equal(signal.aborted, false);
  release();
  assert.equal(await (await request).text(), "file");
  client.close();
  assert.equal(signal.aborted, true);
});

test("OAuth authorization errors prefer the localized description over protocol constants", async () => {
  const { client } = fixture(
    {
      error: "insufficient_scope",
      error_description: "此操作需要收件管理权限。",
      code: "INSUFFICIENT_SCOPE",
    },
    403,
  );
  await assert.rejects(
    client.links(),
    (error) =>
      error.message === "此操作需要收件管理权限。" &&
      error.code === "INSUFFICIENT_SCOPE" &&
      error.status === 403,
  );
  const explicit = fixture(
    {
      message: "Localized message",
      error_description: "Localized detail",
      error: "access_denied",
    },
    403,
  );
  await assert.rejects(explicit.client.links(), {
    message: "Localized message",
  });
});
