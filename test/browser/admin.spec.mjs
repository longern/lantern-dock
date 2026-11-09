import { test as base, expect } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
});
const user = { sub: "admin-user", issuer: "https://site.example", name: "Mina" };
const fixtureLink = { id: "link-one", title: "Event photos", expiresAt: "2036-01-01T00:00:00Z", maxFileBytes: 104857600, maxTotalBytes: 1073741824, maxFiles: 100, revoked: false, usedBytes: 42, usedFiles: 1 };
const fixtureFile = { id: "upload-one", linkId: fixtureLink.id, linkTitle: fixtureLink.title, name: "private-photo.txt", size: 5, status: "complete", createdAt: "2026-01-01T08:00:00Z" };
const token = "A".repeat(43);
const copy = {
  "zh-CN": { title: "管理后台", create: "创建链接", created: "链接已创建", copied: "链接已复制。", save: "我已保存链接", copy: "复制链接", revoke: "撤销链接", revokeTitle: "撤销这个收件链接？", cancel: "取消", files: "私有收件", links: "收件链接", close: "关闭对话框", all: "查看全部收件" },
  en: { title: "Administration", create: "Create link", created: "Your link is ready", copied: "Link copied.", save: "I’ve saved the link", copy: "Copy link", revoke: "Revoke link", revokeTitle: "Revoke this upload link?", cancel: "Cancel", files: "Private inbox", links: "Upload links", close: "Close dialog", all: "Show all files" },
};

// This suite tests UI state with an explicit identity adapter fixture. Real DPoP
// validation and scope signing are covered by unit/Worker/NAS integration tests;
// the production protocol intentionally requires HTTPS, unlike the Vite fixture.
async function install(page, options = {}) {
  const state = { links: [fixtureLink], files: [fixtureFile], requests: [], scopes: [], ...options };
  await page.route("**/src/lib/identity.js*", (route) => route.fulfill({ contentType: "text/javascript", body: `
    async function result(response) {
      const data = await response.json();
      if (!response.ok) { const error = new Error(data.error || 'Fixture error'); error.status = response.status; error.code = data.code; throw error; }
      return data;
    }
    export async function identitySession(signal) { return result(await fetch('/fixture/session', { signal })); }
    export async function accountConnection(signal) { const data = await result(await fetch('/fixture/account', { signal })); return { ...data, backend: { transport: 'http', endpoint: location.origin }, transport: { close() {} } }; }
    export async function requestNASGrant(signal, scope) { return result(await fetch('/fixture/grant?scope=' + encodeURIComponent(scope), { signal })); }
    export async function identityProof() { return 'fixture-proof'; }
    export async function beginLogin() {}
    export async function endLogin() { return result(await fetch('/fixture/logout', { method: 'POST' })); }
  ` }));
  await page.route("**/fixture/session", (route) => route.fulfill({ status: state.sessionStatus || 200,
    json: state.sessionStatus ? { error: "Unavailable" } : state.signedOut ? { authenticated: false } : { authenticated: true, user } }));
  await page.route("**/fixture/account", (route) => route.fulfill({ status: state.accountStatus || 200,
    json: state.accountStatus ? { error: "Cannot verify", code: state.accountCode } : {
      user: { ...user, role: state.role || "admin" }, administratorConfigured: true,
      ...(state.legacy ? {} : { capabilities: { adminLinks: true, adminInbox: true } }),
    } }));
  await page.route("**/fixture/grant?*", (route) => {
    state.scopes.push(new URL(route.request().url()).searchParams.get("scope"));
    return route.fulfill({ json: { access_token: "scoped-secret", token_type: "DPoP", expires_in: 60 } });
  });
  await page.addInitScript(() => {
    window.adminCopies = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { async writeText(value) { window.adminCopies.push(value); } } });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    // useDownload checks property existence, so remove it to exercise Blob saving.
    delete window.showSaveFilePicker;
  });
  await page.route("**/api/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    state.requests.push({ method: request.method(), pathname: url.pathname, query: url.search, headers: request.headers(), body: request.postData() });
    if (state.handle && await state.handle(route, url, request)) return;
    if (url.pathname === "/api/admin/links" && request.method() === "POST") {
      const link = { ...fixtureLink, ...request.postDataJSON(), id: "new-link", usedBytes: 0, usedFiles: 0 };
      state.links = [link, ...state.links];
      return route.fulfill({ status: 201, json: { link, token } });
    }
    if (request.method() === "DELETE") {
      state.links = state.links.map((link) => url.pathname.endsWith("/" + link.id) ? { ...link, revoked: true } : link);
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === "/api/admin/links") return route.fulfill({ json: { links: state.links, nextOffset: null } });
    if (url.pathname === "/api/admin/inbox") return route.fulfill({ json: { uploads: state.files.filter((file) => !url.searchParams.get("linkId") || file.linkId === url.searchParams.get("linkId")), nextOffset: null } });
    if (url.pathname.endsWith("/download")) return route.fulfill({ contentType: "application/octet-stream", body: "hello" });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return state;
}
async function assertNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const element of await page.locator("dialog[open]").all())
    expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

for (const language of ["zh-CN", "en"]) {
  test.describe(`${language} administration`, () => {
    test.use({ locale: language });
    const text = copy[language];
    test("create once, copy, dismiss, and browser history never recover the token", async ({ page }) => {
      const state = await install(page, { links: [] });
      await page.goto("/#/admin");
      await expect(page.getByRole("heading", { name: text.title, exact: true })).toBeVisible();
      await page.locator("#admin-create-link").click();
      const dialog = page.locator("#admin-create-dialog");
      await expect(dialog).toBeVisible();
      await dialog.locator("[name=title]").fill("Wedding collection");
      await assertNoOverflow(page);
      await dialog.locator("button[type=submit]").click();
      await expect(dialog.getByRole("heading", { name: text.created, exact: true })).toBeVisible();
      const url = await page.locator("#admin-created-url").inputValue();
      expect(url).toContain(`#/upload/${token}`);
      await expect(page.locator("#admin-copy-link")).toBeFocused();
      await dialog.getByRole("button", { name: text.copy, exact: true }).click();
      await expect(dialog.getByRole("status")).toHaveText(text.copied);
      expect(await page.evaluate(() => window.adminCopies)).toEqual([url]);
      await dialog.getByRole("button", { name: text.save, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator("#admin-create-link")).toBeFocused();
      await expect(page.locator(".admin-link-list")).toContainText("Wedding collection");
      expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(token);
      await expect(page.locator("body")).not.toContainText(token);
      await page.locator(".admin-account-link").click();
      await page.goBack();
      await expect(page).toHaveURL(/#\/admin$/);
      await expect(page.locator("#admin-created-url")).toHaveCount(0);
      expect(state.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(state.scopes).toContain("links:write");
      await assertNoOverflow(page);
    });
    test("revoke confirms, retains inbox files, filters and downloads privately", async ({ page }) => {
      const state = await install(page);
      await page.goto("/#/admin");
      await expect(page.locator(".admin-link-card")).toHaveCount(1);
      await page.locator(".admin-link-card .admin-danger").click();
      const dialog = page.locator("#admin-revoke-dialog");
      await expect(dialog.getByRole("heading", { name: text.revokeTitle, exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: text.cancel, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(state.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
      await page.locator(".admin-link-card .admin-danger").click();
      await dialog.getByRole("button", { name: text.revoke, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".admin-badge")).toHaveAttribute("data-status", "revoked");
      await expect(page.locator(".admin-link-card .admin-danger")).toHaveCount(0);
      await page.locator(".admin-link-actions .secondary-button").click();
      await expect(page.locator(".admin-filter")).toContainText(fixtureLink.title);
      await expect(page.locator(".admin-inbox-file")).toHaveCount(1);
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".admin-inbox-file button").click()]);
      expect(download.suggestedFilename()).toBe(fixtureFile.name);
      const request = state.requests.find((value) => value.pathname.endsWith("/download"));
      expect(request.headers.authorization).toBe("DPoP scoped-secret");
      expect(request.headers.dpop).toBe("fixture-proof");
      expect(request.pathname).not.toContain("scoped-secret");
      expect(state.scopes).toContain("inbox:read");
      await page.getByRole("button", { name: text.all, exact: true }).click();
      await expect(page.locator(".admin-filter")).toHaveCount(0);
      await assertNoOverflow(page);
    });
  });
}

for (const [name, options, heading] of [
  ["signed out", { signedOut: true }, "请先登录"],
  ["identity failure", { sessionStatus: 503 }, "暂时无法检查账户"],
  ["no NAS", { accountStatus: 503, accountCode: "NAS_NOT_CONFIGURED" }, "尚未配置 NAS"],
  ["NAS unavailable", { accountStatus: 503 }, "暂时无法验证 NAS 权限"],
  ["permissions unconfirmed", { accountStatus: 403 }, "NAS 权限尚未确认"],
  ["standard user", { role: "user" }, "需要管理员权限"],
  ["old NAS", { legacy: true }, "需要更新 NAS"],
]) {
  test(`${name} cannot enter administration or make admin requests`, async ({ page }) => {
    const state = await install(page, options);
    await page.goto("/#/admin");
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.locator("#admin-create-link,.admin-navigation")).toHaveCount(0);
    expect(state.requests).toEqual([]);
    await assertNoOverflow(page);
  });
}

test("rapid form submits create once, cancellation is locked while the outcome is pending", async ({ page }) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const state = await install(page, { handle: async (route, url, request) => {
    if (request.method() !== "POST") return false;
    await waiting;
    await route.fulfill({ status: 201, json: { link: fixtureLink, token } });
    return true;
  } });
  await page.goto("/#/admin");
  await page.locator("#admin-create-link").click();
  const dialog = page.locator("#admin-create-dialog");
  await dialog.locator("[name=title]").fill("One link");
  await dialog.locator("form").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(() => state.requests.filter((request) => request.method === "POST").length).toBe(1);
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveAttribute("open", "");
  release();
  await expect(page.locator("#admin-created-url")).toBeVisible();
});

test("uncertain creation is not automatically retried", async ({ page }) => {
  const state = await install(page, { handle: async (route, _url, request) => {
    if (request.method() !== "POST") return false;
    await route.fulfill({ status: 503, json: { error: "Connection lost" } });
    return true;
  } });
  await page.goto("/#/admin");
  await page.locator("#admin-create-link").click();
  const dialog = page.locator("#admin-create-dialog");
  await dialog.locator("[name=title]").fill("One link");
  await dialog.locator("button[type=submit]").click();
  await expect(dialog).toContainText("链接可能已创建");
  await expect(dialog.locator("button[type=submit]")).toBeDisabled();
  expect(state.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("navigation aborts a pending create and a late response cannot reveal its token", async ({ page }) => {
  const state = await install(page);
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.adminPending = null;
    window.fetch = function (input, options) {
      if (!String(input).endsWith("/api/admin/links") || options?.method !== "POST") return fetch.call(this, input, options);
      return new Promise((resolve) => { window.adminPending = { signal: options.signal, release: (body) => resolve(new Response(JSON.stringify(body), { status: 201 })) }; });
    };
  });
  await page.goto("/#/admin");
  await page.locator("#admin-create-link").click();
  await page.locator("#admin-link-title").fill("Leave this page");
  await page.locator("#admin-create-dialog button[type=submit]").click();
  await expect.poll(() => page.evaluate(() => !!window.adminPending)).toBe(true);
  await page.evaluate(() => { location.hash = "#/account"; });
  await expect(page.locator("#admin-create-dialog")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.adminPending.signal.aborted)).toBe(true);
  await page.evaluate(({ link, token }) => window.adminPending.release({ link, token }), { link: fixtureLink, token });
  await page.goBack();
  await expect(page.locator("#admin-created-url")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(token);
  expect(state.requests.filter((request) => request.method === "POST")).toHaveLength(0);
});
