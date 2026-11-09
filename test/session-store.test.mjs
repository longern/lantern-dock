import test from "node:test";
import assert from "node:assert/strict";
import { createSessionStore } from "../src/lib/session-store.js";

const user = { sub: "site-user", issuer: "https://site.example", name: "Mina" };
const session = { authenticated: true, user };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Worker checks are shared across subscribers and NAS stays lazy", async () => {
  const pending = deferred();
  let checks = 0, nasChecks = 0;
  const store = createSessionStore({ readIdentity: () => { checks++; return pending.promise; }, readNAS: () => nasChecks++ });
  const stop = store.subscribe(() => {});
  const first = store.ensureIdentity();
  const second = store.refreshIdentity();
  assert.equal(first, second);
  stop(); // Navigating away from a consumer must not cancel a shared check.
  await tick();
  assert.equal(checks, 1);
  assert.equal(nasChecks, 0);
  pending.resolve(session);
  await first;
  await store.ensureIdentity();
  assert.equal(checks, 1);
  assert.equal(store.getSnapshot().identity.user, user);
  assert.equal(store.getSnapshot().nas.status, "idle");
  store.dispose();
});

test("NAS checks deduplicate, cache metadata only, and close the check transport", async () => {
  const pending = deferred();
  let checks = 0, closed = 0;
  const store = createSessionStore({ readIdentity: async () => session, readNAS: () => { checks++; return pending.promise; } });
  await store.ensureIdentity();
  const first = store.ensureNAS();
  const second = store.refreshNAS();
  assert.equal(first, second);
  await tick();
  assert.equal(checks, 1);
  pending.resolve({ user: { ...user, role: "admin" }, capabilities: { adminLinks: true }, transport: { close: () => closed++ } });
  await first;
  await store.ensureNAS();
  assert.equal(checks, 1);
  assert.equal(closed, 1);
  assert.equal(store.getSnapshot().nas.status, "ready");
  assert.equal(store.getSnapshot().nas.account.user.role, "admin");
  assert.equal("transport" in store.getSnapshot().nas.account, false);
  store.dispose();
});

test("simultaneous NAS callers awaiting Worker identity still share one NAS request", async () => {
  const identity = deferred();
  let checks = 0;
  const store = createSessionStore({ readIdentity: () => identity.promise, readNAS: async () => { checks++; return { user }; } });
  const first = store.ensureNAS(), second = store.ensureNAS();
  identity.resolve(session);
  await Promise.all([first, second]);
  assert.equal(checks, 1);
  store.dispose();
});

test("NAS outage and denied authorization never turn a Worker user into a guest", async () => {
  for (const [error, kind] of [[new TypeError("Failed to fetch"), "unavailable"], [Object.assign(new Error("Denied"), { status: 403 }), "unauthorized"]]) {
    const store = createSessionStore({ readIdentity: async () => session, readNAS: async () => { throw error; } });
    await store.ensureIdentity();
    await store.ensureNAS();
    assert.equal(store.getSnapshot().identity.status, "authenticated");
    assert.equal(store.getSnapshot().identity.user, user);
    assert.equal(store.getSnapshot().nas.status, "error");
    assert.equal(store.getSnapshot().nas.error.kind, kind);
    store.dispose();
  }
});

test("offline and unsuccessful session checks are distinct from confirmed signed-out", async () => {
  let online = false, checks = 0;
  const store = createSessionStore({ isOnline: () => online, readIdentity: async () => { checks++; return { authenticated: false }; } });
  await store.ensureIdentity();
  assert.equal(checks, 0);
  assert.equal(store.getSnapshot().identity.status, "error");
  assert.equal(store.getSnapshot().identity.error.kind, "offline");
  online = true;
  await store.refreshIdentity();
  assert.equal(store.getSnapshot().identity.status, "signed-out");
  store.dispose();
  const failed = createSessionStore({ readIdentity: async () => { throw new Error("Worker unavailable"); } });
  await failed.ensureIdentity();
  assert.equal(failed.getSnapshot().identity.status, "error");
  assert.equal(failed.getSnapshot().identity.error.kind, "unavailable");
  failed.dispose();
});

test("identity invalidation prevents late results from replacing the current user", async () => {
  const old = deferred();
  let checks = 0;
  const store = createSessionStore({ readIdentity: async () => ++checks === 1 ? old.promise : session });
  const first = store.ensureIdentity();
  await tick();
  store.invalidate();
  await store.refreshIdentity();
  old.resolve({ authenticated: true, user: { ...user, sub: "obsolete" } });
  await first;
  await tick();
  assert.equal(store.getSnapshot().identity.user.sub, user.sub);
  store.dispose();
});

test("logout is shared, clears NAS permissions immediately and ignores late NAS success", async () => {
  const account = deferred(), ended = deferred();
  let closed = 0, logouts = 0, changes = 0;
  const store = createSessionStore({
    readIdentity: async () => session, readNAS: () => account.promise,
    finishLogout: () => { logouts++; return ended.promise; }, onSessionChange: () => changes++,
  });
  await store.ensureIdentity();
  const nas = store.ensureNAS();
  await tick();
  const first = store.logout(), second = store.logout();
  assert.equal(first, second);
  assert.equal(store.getSnapshot().nas.status, "idle");
  assert.equal(store.getSnapshot().identity.status, "authenticated");
  await tick();
  assert.equal(logouts, 1);
  ended.resolve({});
  await first;
  account.resolve({ user: { ...user, role: "admin" }, transport: { close: () => closed++ } });
  await nas;
  await tick();
  assert.equal(closed, 1);
  assert.equal(changes, 1);
  assert.equal(store.getSnapshot().identity.status, "signed-out");
  assert.equal(store.getSnapshot().nas.account, null);
  store.dispose();
});

test("failed logout does not claim the cookie was removed; a recheck can recover", async () => {
  const store = createSessionStore({ readIdentity: async () => session, finishLogout: async () => { throw new Error("Offline"); } });
  await store.ensureIdentity();
  await assert.rejects(store.logout(), /Offline/);
  assert.equal(store.getSnapshot().identity.status, "authenticated");
  await store.ensureIdentity();
  assert.equal(store.getSnapshot().identity.status, "authenticated");
  store.dispose();
});

test("NAS identity mismatch is rejected without changing the Worker session", async () => {
  let closed = 0;
  const store = createSessionStore({ readIdentity: async () => session, readNAS: async () => ({ user: { ...user, sub: "other" }, transport: { close: () => closed++ } }) });
  await store.ensureIdentity();
  await store.ensureNAS();
  assert.equal(store.getSnapshot().nas.error.kind, "identity-mismatch");
  assert.equal(store.getSnapshot().nas.account, null);
  assert.equal(store.getSnapshot().identity.user, user);
  assert.equal(closed, 1);
  store.dispose();
});

test("expired metadata is rechecked, invalidating previously displayed NAS permissions", async () => {
  let time = 0, checks = 0;
  const store = createSessionStore({ now: () => time, maxAge: 10, readIdentity: async () => { checks++; return session; }, readNAS: async () => ({ user }) });
  await store.ensureIdentity();
  await store.ensureNAS();
  time = 11;
  await store.ensureIdentity();
  assert.equal(checks, 2);
  assert.equal(store.getSnapshot().nas.status, "idle");
  store.dispose();
});

test("login cancellation preserves a known guest and success invalidates both states", async () => {
  let succeeds = false, changes = 0;
  const store = createSessionStore({ readIdentity: async () => ({ authenticated: false }), startLogin: async () => { if (!succeeds) throw new DOMException("Cancelled", "AbortError"); }, onSessionChange: () => changes++ });
  await store.ensureIdentity();
  await assert.rejects(store.login(), { name: "AbortError" });
  assert.equal(store.getSnapshot().identity.status, "signed-out");
  assert.equal(changes, 0);
  succeeds = true;
  await store.login();
  assert.equal(store.getSnapshot().identity.status, "loading");
  assert.equal(changes, 1);
  store.dispose();
});

test("an unresponsive identity request times out without blocking another attempt", async () => {
  let reads = 0;
  const store = createSessionStore({ timeout: 10, readIdentity: () => ++reads === 1 ? new Promise(() => {}) : Promise.resolve(session) });
  await store.ensureIdentity();
  assert.equal(store.getSnapshot().identity.status, "error");
  assert.equal(store.getSnapshot().identity.error.kind, "unavailable");
  await store.refreshIdentity();
  assert.equal(store.getSnapshot().identity.status, "authenticated");
  store.dispose();
});

test("Worker expiry bounds identity and NAS metadata freshness", async () => {
  let time = 0, checks = 0;
  const store = createSessionStore({
    now: () => time, maxAge: 60_000,
    readIdentity: async () => ++checks === 1 ? { ...session, expiresAt: new Date(1000).toISOString() } : { authenticated: false },
    readNAS: async () => ({ user }),
  });
  await store.ensureIdentity();
  await store.ensureNAS();
  time = 1001;
  await store.ensureNAS();
  assert.equal(checks, 2);
  assert.equal(store.getSnapshot().identity.status, "signed-out");
  assert.equal(store.getSnapshot().nas.status, "idle");
  store.dispose();
});

test("expired session-grant responses are not mislabeled NAS outages or confirmed logouts", async () => {
  const store = createSessionStore({ readIdentity: async () => session, readNAS: async () => { throw Object.assign(new Error("Expired"), { status: 400, code: "LOGIN_REQUIRED" }); } });
  await store.ensureIdentity();
  await store.ensureNAS();
  assert.equal(store.getSnapshot().nas.error.kind, "session-expired");
  assert.equal(store.getSnapshot().identity.status, "authenticated");
  store.dispose();
});

test("already expired Worker metadata cannot trigger an unbounded NAS retry loop", async () => {
  let nasChecks = 0;
  const store = createSessionStore({ now: () => 2000, readIdentity: async () => ({ ...session, expiresAt: new Date(1000).toISOString() }), readNAS: async () => { nasChecks++; return { user }; } });
  await store.ensureNAS();
  assert.equal(store.getSnapshot().identity.status, "error");
  assert.equal(nasChecks, 0);
  store.dispose();
});
