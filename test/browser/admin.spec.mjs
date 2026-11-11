import { isCompact } from "../helpers/responsive.mjs";
import { test as base, expect } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
});
const user = {
  sub: "admin-user",
  issuer: "https://site.example",
  name: "Mina",
};
const fixtureLink = {
  id: "link-one",
  title: "Event photos",
  expiresAt: "2036-01-01T00:00:00Z",
  maxFileBytes: 104857600,
  maxTotalBytes: 1073741824,
  maxFiles: 100,
  revoked: false,
  usedBytes: 42,
  usedFiles: 1,
};
const fixtureFile = {
  id: "upload-one",
  linkId: fixtureLink.id,
  linkTitle: fixtureLink.title,
  name: "private-photo.txt",
  size: 5,
  status: "complete",
  createdAt: "2026-01-01T08:00:00Z",
};
const token = "A".repeat(43);
const copy = {
  "zh-CN": {
    title: "管理后台",
    create: "创建链接",
    created: "链接已创建",
    copied: "链接已复制。",
    save: "我已保存链接",
    copy: "复制链接",
    revoke: "撤销链接",
    revokeTitle: "撤销这个收件链接？",
    cancel: "取消",
    files: "私有收件",
    links: "收件链接",
    close: "关闭对话框",
    all: "查看全部收件",
  },
  en: {
    title: "Administration",
    create: "Create link",
    created: "Your link is ready",
    copied: "Link copied.",
    save: "I’ve saved the link",
    copy: "Copy link",
    revoke: "Revoke link",
    revokeTitle: "Revoke this upload link?",
    cancel: "Cancel",
    files: "Private inbox",
    links: "Upload links",
    close: "Close dialog",
    all: "Show all files",
  },
};

// This suite tests UI state with an explicit identity adapter fixture. Real DPoP
// validation and scope signing are covered by unit/Worker/NAS integration tests;
// the production protocol intentionally requires HTTPS, unlike the Vite fixture.
async function install(page, options = {}) {
  const state = {
    links: [fixtureLink],
    files: [fixtureFile],
    requests: [],
    scopes: [],
    ...options,
  };
  await page.route("**/src/lib/identity.js*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
    async function result(response) {
      const data = await response.json();
      if (!response.ok) { const error = new Error(data.error || 'Fixture error'); error.status = response.status; error.code = data.code; throw error; }
      return data;
    }
    export async function identitySession(signal) { return result(await fetch('/fixture/session', { signal })); }
    export async function accountConnection(signal) { const data = await result(await fetch('/fixture/account', { signal })); return { ...data, backend: { transport: 'http', endpoint: location.origin }, transport: { close() {} } }; }
    export async function requestNASGrant(signal, scope) { return result(await fetch('/fixture/grant?scope=' + encodeURIComponent(scope), { signal })); }
    export async function identityProof() { return 'fixture-proof'; }
    export async function beginLogin(signal) { const data = await result(await fetch('/fixture/login', { signal })); signal?.throwIfAborted(); location.assign(data.url); }
    export async function endLogin() { return result(await fetch('/fixture/logout', { method: 'POST' })); }
  `,
    }),
  );
  await page.route("**/fixture/session", (route) =>
    route.fulfill({
      status: state.sessionStatus || 200,
      json: state.sessionStatus
        ? { error: "Unavailable" }
        : state.signedOut
          ? { authenticated: false }
          : { authenticated: true, user },
    }),
  );
  await page.route("**/fixture/account", (route) =>
    route.fulfill({
      status: state.accountStatus || 200,
      json: state.accountStatus
        ? { error: "Cannot verify", code: state.accountCode }
        : {
            user: { ...user, role: state.role || "admin" },
            administratorConfigured: true,
            ...(state.legacy
              ? {}
              : {
                  capabilities: state.capabilities || {
                    adminLinks: true,
                    adminInbox: true,
                  },
                }),
          },
    }),
  );
  await page.route("**/fixture/grant?*", (route) => {
    state.scopes.push(new URL(route.request().url()).searchParams.get("scope"));
    return route.fulfill({
      json: {
        access_token: "scoped-secret",
        token_type: "DPoP",
        expires_in: 60,
      },
    });
  });
  await page.addInitScript(() => {
    window.adminCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          window.adminCopies.push(value);
        },
      },
    });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });
    // useDownload checks property existence, so remove it to exercise Blob saving.
    delete window.showSaveFilePicker;
  });
  await page.route("**/api/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    state.requests.push({
      method: request.method(),
      pathname: url.pathname,
      query: url.search,
      headers: request.headers(),
      body: request.postData(),
    });
    if (state.handle && (await state.handle(route, url, request))) return;
    if (url.pathname === "/api/admin/links" && request.method() === "POST") {
      const link = {
        ...fixtureLink,
        ...request.postDataJSON(),
        id: "new-link",
        usedBytes: 0,
        usedFiles: 0,
      };
      state.links = [link, ...state.links];
      return route.fulfill({ status: 201, json: { link, token } });
    }
    if (request.method() === "DELETE") {
      state.links = state.links.map((link) =>
        url.pathname.endsWith("/" + link.id)
          ? { ...link, revoked: true }
          : link,
      );
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === "/api/admin/links")
      return route.fulfill({ json: { links: state.links, nextOffset: null } });
    if (url.pathname === "/api/admin/inbox")
      return route.fulfill({
        json: {
          uploads: state.files.filter(
            (file) =>
              !url.searchParams.get("linkId") ||
              file.linkId === url.searchParams.get("linkId"),
          ),
          nextOffset: null,
        },
      });
    if (url.pathname.endsWith("/download"))
      return route.fulfill({
        contentType: "application/octet-stream",
        body: "hello",
      });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return state;
}
async function assertNoOverflow(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  for (const element of await page.locator("dialog[open]").all())
    expect(
      await element.evaluate(
        (node) => node.scrollWidth <= node.clientWidth + 1,
      ),
    ).toBe(true);
}

for (const legacy of [false, true]) {
  test(`${legacy ? "older" : "current"} NAS administrators find the entry between favorites and settings`, async ({
    page,
  }) => {
    test.skip(!isCompact(page), "Me is the mobile account destination");
    const state = await install(page, { legacy });
    await page.goto("/me");
    await expect(page.locator("#my-admin")).toBeVisible();
    expect(
      await page
        .locator(".my-action-list > *")
        .evaluateAll((nodes) => nodes.map((node) => node.id)),
    ).toEqual(["my-favorites", "my-admin", "my-settings"]);
    await page.locator("#my-account-link").click();
    await expect(page.locator(".account-details").first()).toContainText(
      "管理员",
    );
    const entry = page.locator("#account-admin-entry");
    await expect(entry).toBeVisible();
    await expect(entry).toHaveCSS("min-height", "56px");
    await expect(entry).toHaveCSS("padding-inline", "16px");
    const icon = entry.locator(".my-list-icon");
    await expect(icon).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(icon.locator("svg")).toHaveCSS("width", "24px");
    await page.goBack();
    await page.locator("#my-admin").click();
    if (legacy) {
      await expect(
        page.getByRole("heading", { name: "需要更新 NAS", exact: true }),
      ).toBeVisible();
      await expect(
        page.locator("#admin-create-link,.admin-navigation"),
      ).toHaveCount(0);
      expect(state.requests).toEqual([]);
      expect(state.scopes).toEqual([]);
    } else {
      await expect(page.locator("#admin-create-link")).toBeVisible();
    }
    await assertNoOverflow(page);
  });
}

for (const [name, options] of [
  ["guest", { signedOut: true }],
  ["ordinary user", { role: "user" }],
  ["unverified account", { accountStatus: 403 }],
]) {
  test(`${name} does not see an administrator entry in account details`, async ({
    page,
  }) => {
    const state = await install(page, options);
    await page.goto("/account");
    await expect(page.locator("#account-title")).toBeVisible();
    await expect(page.locator(".upload-message")).toHaveCount(0);
    await expect(page.locator("#account-admin-entry")).toHaveCount(0);
    expect(state.requests).toEqual([]);
  });
}

for (const language of ["zh-CN", "en"]) {
  test.describe(`${language} administration`, () => {
    test.use({ locale: language });
    const text = copy[language];
    test("create once, copy, dismiss, and browser history never recover the token", async ({
      page,
    }) => {
      const state = await install(page, { links: [] });
      await page.goto("/admin");
      await expect(
        page.getByRole("heading", { name: text.title, exact: true }),
      ).toBeVisible();
      await page.locator("#admin-create-link").click();
      const dialog = page.locator("#admin-create-dialog");
      await expect(dialog).toBeVisible();
      await dialog.locator("[name=title]").fill("Wedding collection");
      await assertNoOverflow(page);
      await dialog.locator("button[type=submit]").click();
      await expect(
        dialog.getByRole("heading", { name: text.created, exact: true }),
      ).toBeVisible();
      const url = await page.locator("#admin-created-url").inputValue();
      expect(url).toContain(`/upload#token=${token}`);
      await expect(page.locator("#admin-copy-link")).toBeFocused();
      await dialog
        .getByRole("button", { name: text.copy, exact: true })
        .click();
      await expect(dialog.getByRole("status")).toHaveText(text.copied);
      expect(await page.evaluate(() => window.adminCopies)).toEqual([url]);
      await dialog
        .getByRole("button", { name: text.save, exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator("#admin-create-link")).toBeFocused();
      await expect(page.locator(".admin-link-list")).toContainText(
        "Wedding collection",
      );
      expect(
        await page.evaluate(() =>
          JSON.stringify([localStorage, sessionStorage]),
        ),
      ).not.toContain(token);
      await expect(page.locator("body")).not.toContainText(token);
      await page.locator(".admin-account-link").click();
      await page.goBack();
      await expect(page).toHaveURL(/\/admin(?:\/links)?$/);
      await expect(page.locator("#admin-created-url")).toHaveCount(0);
      expect(
        state.requests.filter((request) => request.method === "POST"),
      ).toHaveLength(1);
      expect(state.scopes).toContain("links:write");
      await assertNoOverflow(page);
    });
    test("revoke confirms, retains inbox files, filters and downloads privately", async ({
      page,
    }) => {
      const state = await install(page);
      await page.goto("/admin");
      await expect(page.locator(".admin-link-card")).toHaveCount(1);
      await page.locator(".admin-link-card .admin-danger").click();
      const dialog = page.locator("#admin-revoke-dialog");
      await expect(
        dialog.getByRole("heading", { name: text.revokeTitle, exact: true }),
      ).toBeVisible();
      const cancel = dialog.getByRole("button", {
        name: text.cancel,
        exact: true,
      });
      await expect(cancel).toBeFocused();
      await cancel.click();
      await expect(dialog).toHaveCount(0);
      expect(
        state.requests.filter((request) => request.method === "DELETE"),
      ).toHaveLength(0);
      await page.locator(".admin-link-card .admin-danger").click();
      await dialog
        .getByRole("button", { name: text.revoke, exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".admin-badge")).toHaveAttribute(
        "data-status",
        "revoked",
      );
      await expect(page.locator(".admin-link-card .admin-danger")).toHaveCount(
        0,
      );
      await page.locator(".admin-link-actions .secondary-button").click();
      await expect(page.locator(".admin-filter")).toContainText(
        fixtureLink.title,
      );
      await expect(page.locator(".admin-inbox-file")).toHaveCount(1);
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.locator(".admin-inbox-file button").click(),
      ]);
      expect(download.suggestedFilename()).toBe(fixtureFile.name);
      const request = state.requests.find((value) =>
        value.pathname.endsWith("/download"),
      );
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
  [
    "no NAS",
    { accountStatus: 503, accountCode: "NAS_NOT_CONFIGURED" },
    "尚未配置 NAS",
  ],
  ["NAS unavailable", { accountStatus: 503 }, "暂时无法验证 NAS 权限"],
  ["permissions unconfirmed", { accountStatus: 403 }, "NAS 权限尚未确认"],
  ["standard user", { role: "user" }, "需要管理员权限"],
  ["old NAS", { legacy: true }, "需要更新 NAS"],
]) {
  test(`${name} cannot enter administration or make admin requests`, async ({
    page,
  }) => {
    const state = await install(page, options);
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("#admin-create-link,.admin-navigation"),
    ).toHaveCount(0);
    expect(state.requests).toEqual([]);
    await assertNoOverflow(page);
  });
}

test("rapid form submits create once, cancellation is locked while the outcome is pending", async ({
  page,
}) => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const state = await install(page, {
    handle: async (route, url, request) => {
      if (request.method() !== "POST") return false;
      await waiting;
      await route.fulfill({ status: 201, json: { link: fixtureLink, token } });
      return true;
    },
  });
  await page.goto("/admin");
  await page.locator("#admin-create-link").click();
  const dialog = page.locator("#admin-create-dialog");
  await dialog.locator("[name=title]").fill("One link");
  await dialog.locator("form").evaluate((form) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect
    .poll(
      () =>
        state.requests.filter((request) => request.method === "POST").length,
    )
    .toBe(1);
  await expect(
    dialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveAttribute("open", "");
  release();
  await expect(page.locator("#admin-created-url")).toBeVisible();
});

test("uncertain creation is not automatically retried", async ({ page }) => {
  const state = await install(page, {
    handle: async (route, _url, request) => {
      if (request.method() !== "POST") return false;
      await route.fulfill({ status: 503, json: { error: "Connection lost" } });
      return true;
    },
  });
  await page.goto("/admin");
  await page.locator("#admin-create-link").click();
  const dialog = page.locator("#admin-create-dialog");
  await dialog.locator("[name=title]").fill("One link");
  await dialog.locator("button[type=submit]").click();
  await expect(dialog).toContainText("链接可能已创建");
  await expect(dialog.locator("button[type=submit]")).toBeDisabled();
  expect(
    state.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(1);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("navigation aborts a pending create and a late response cannot reveal its token", async ({
  page,
}) => {
  const state = await install(page);
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.adminPending = null;
    window.fetch = function (input, options) {
      if (
        !String(input).endsWith("/api/admin/links") ||
        options?.method !== "POST"
      )
        return fetch.call(this, input, options);
      return new Promise((resolve) => {
        window.adminPending = {
          signal: options.signal,
          release: (body) =>
            resolve(new Response(JSON.stringify(body), { status: 201 })),
        };
      });
    };
  });
  await page.goto("/admin");
  await page.locator("#admin-create-link").click();
  await page.locator("#admin-link-title").fill("Leave this page");
  await page.locator("#admin-create-dialog button[type=submit]").click();
  await expect
    .poll(() => page.evaluate(() => !!window.adminPending))
    .toBe(true);
  await page.evaluate(() => {
    history.pushState(null, "", "/account");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator("#admin-create-dialog")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.adminPending.signal.aborted))
    .toBe(true);
  await page.evaluate(
    ({ link, token }) => window.adminPending.release({ link, token }),
    { link: fixtureLink, token },
  );
  await page.goBack();
  await expect(page.locator("#admin-created-url")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(token);
  expect(
    state.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(0);
});

test("a timed-out creation unlocks dismissal and never retries or reveals a late token", async ({
  page,
}) => {
  await page.clock.install();
  await install(page);
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.adminAttempts = [];
    window.fetch = function (input, options) {
      if (
        !String(input).endsWith("/api/admin/links") ||
        options?.method !== "POST"
      )
        return fetch.call(this, input, options);
      return new Promise((resolve) => {
        window.adminAttempts.push({
          signal: options.signal,
          release: (body) =>
            resolve(new Response(JSON.stringify(body), { status: 201 })),
        });
      });
    };
  });
  await page.goto("/admin");
  await page.locator("#admin-create-link").click();
  const dialog = page.locator("#admin-create-dialog");
  await page.locator("#admin-link-title").fill("Timeout check");
  await dialog.locator("button[type=submit]").click();
  await expect
    .poll(() => page.evaluate(() => window.adminAttempts.length))
    .toBe(1);
  await page.clock.fastForward(30001);
  await expect(dialog).toContainText("NAS 请求超时");
  await expect(dialog).toContainText("链接可能已创建");
  await expect(
    dialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeEnabled();
  await expect(dialog.locator("button[type=submit]")).toBeDisabled();
  expect(
    await page.evaluate(() => window.adminAttempts[0].signal.aborted),
  ).toBe(true);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(
    ({ link, token }) => window.adminAttempts[0].release({ link, token }),
    { link: fixtureLink, token },
  );
  await expect(page.locator("#admin-created-url")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(token);
  expect(await page.evaluate(() => window.adminAttempts.length)).toBe(1);
});

test("direct admin URLs respect capabilities before starting a collection request", async ({
  page,
}) => {
  const state = await install(page, {
    capabilities: { adminLinks: true, adminInbox: false },
  });
  await page.goto("/admin/inbox");
  await expect(page).toHaveURL(/\/admin\/links$/);
  await expect(page.locator("#admin-create-link")).toBeVisible();
  expect(
    state.requests.some((request) => request.pathname === "/api/admin/inbox"),
  ).toBe(false);
  // Tear down the preceding page before changing its simulated permissions.
  await page.goto("about:blank");
  state.capabilities = { adminLinks: false, adminInbox: true };
  state.requests.length = 0;
  await page.goto("/admin/links");
  await expect(page).toHaveURL(/\/admin\/inbox$/);
  await expect(page.locator("#admin-inbox-heading")).toBeVisible();
  expect(
    state.requests.some((request) => request.pathname === "/api/admin/links"),
  ).toBe(false);
});

test("a filtered inbox URL starts with its filter and survives refresh", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/admin/inbox?link=" + fixtureLink.id);
  await expect(page.locator(".admin-inbox-file")).toHaveCount(1);
  const reads = state.requests.filter(
    (request) => request.pathname === "/api/admin/inbox",
  );
  expect(reads.length).toBeGreaterThan(0);
  expect(
    reads.every(
      (request) =>
        new URLSearchParams(request.query).get("linkId") === fixtureLink.id,
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.locator(".admin-inbox-file")).toHaveCount(1);
});

async function installIntake(page, options) {
  const id = "a".repeat(32);
  const state = await install(page, {
    capabilities: { adminLinks: true, adminInbox: true, personalUploads: true },
    async handle(route, url, request) {
      if (!url.pathname.startsWith("/api/admin/uploads")) return false;
      if (request.method() === "GET")
        await route.fulfill({
          json: { ...fixtureLink, usedFiles: 0, usedBytes: 0 },
        });
      else if (request.method() === "POST")
        await route.fulfill({ status: 201, json: { id } });
      else if (request.method() === "PUT")
        await route.fulfill({ status: 201, json: { id, status: "complete" } });
      else throw new Error("Unexpected personal upload request");
      return true;
    },
    ...options,
  });
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        backend: {
          transport: "http",
          endpoint: new URL(route.request().url()).origin,
          rootPath: "/dav/",
          auth: "none",
        },
      },
    }),
  );
  await page.route("**/dav/**", (route) =>
    route.fulfill({
      status: 207,
      contentType: "application/xml",
      body: '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
    }),
  );
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({
      json: {
        version: 1,
        services: state.webDAVOnly
          ? {}
          : {
              inbox: {
                enabled: true,
                protocol: "lantern-dock-inbox",
                version: 1,
                href: "/api/uploads",
              },
            },
      },
    }),
  );
  return state;
}

test("file intake offers a local QR and a separate authenticated personal upload", async ({
  page,
}, info) => {
  const state = await installIntake(page);
  await page.goto("/files/");
  const trigger = page.locator("#file-intake-trigger");
  await expect(trigger).toBeVisible();
  const compact = isCompact(page);
  if (compact) {
    const position = await trigger.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const tabs = document
        .querySelector(".mobile-tabs")
        .getBoundingClientRect();
      return {
        aboveTabs: tabs.top - bounds.bottom,
        fromRight: innerWidth - bounds.right,
      };
    });
    expect(position.aboveTabs).toBeGreaterThanOrEqual(0);
    expect(position.aboveTabs).toBeLessThanOrEqual(32);
    expect(position.fromRight).toBe(16);
    await trigger.tap();
    const handle = page.locator(".intake-sheet-handle");
    await handle.evaluate(async (node) => {
      await Promise.all(
        node
          .closest("dialog")
          .getAnimations()
          .map((motion) => motion.finished),
      );
    });
    const box = await handle.boundingBox();
    const client = await page.context().newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    try {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...point, y: point.y + 80 }],
      });
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } finally {
      await client.detach();
    }
    await expect(handle).toHaveCount(0);
  } else {
    await expect(page.locator(".topbar").locator(trigger)).toBeVisible();
  }
  let captured = false;
  const choose = async (label) => {
    await trigger.click();
    const drawer = page.locator("dialog:has(.intake-actions)");
    await expect(drawer).toHaveAccessibleName("上传文件");
    await expect(drawer).toBeVisible();
    if (compact) {
      expect(
        await drawer.evaluate((node) => node.getBoundingClientRect().width),
      ).toBe(await page.evaluate(() => innerWidth));
    }
    if (!captured) {
      await drawer.screenshot({
        path: info.outputPath("upload-action-cards.png"),
      });
      captured = true;
    }
    await drawer.getByRole("button", { name: label, exact: true }).click();
  };
  await choose("邀请他人上传");
  const invite = page.locator("#admin-create-dialog");
  await invite.getByRole("button", { name: /当面扫码/ }).click();
  const qr = invite.getByRole("img", { name: "扫码打开上传页面" });
  await expect(qr).toBeVisible();
  expect(
    await qr.evaluate((canvas) =>
      canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((value, index) => index % 4 === 0 && value === 0),
    ),
  ).toBe(true);
  await invite.getByRole("button", { name: "复制链接" }).click();
  expect(await page.evaluate(() => window.adminCopies[0])).toContain(
    "/upload#token=" + token,
  );
  const scan = state.requests.find(
    (request) =>
      request.method === "POST" && request.pathname === "/api/admin/links",
  );
  expect(
    Date.parse(JSON.parse(scan.body).expiresAt) - Date.now(),
  ).toBeGreaterThan(29 * 60000);
  expect(
    Date.parse(JSON.parse(scan.body).expiresAt) - Date.now(),
  ).toBeLessThanOrEqual(30 * 60000);
  await invite.getByRole("button", { name: "完成", exact: true }).click();
  await expect(invite).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await choose("邀请他人上传");
  await invite.getByRole("button", { name: /发给微信好友/ }).click();
  await expect(invite.locator("#admin-created-url")).toBeVisible();
  await expect(invite.locator("canvas")).toHaveCount(0);
  const share = state.requests
    .filter((request) => request.method === "POST")
    .at(-1);
  expect(
    Date.parse(JSON.parse(share.body).expiresAt) - Date.now(),
  ).toBeGreaterThan(71 * 3600000);
  await invite.getByRole("button", { name: "完成", exact: true }).click();
  await expect(invite).toHaveCount(0);

  const chooser = page.waitForEvent("filechooser");
  await choose("选择文件上传");
  const personal = page.getByRole("dialog", { name: "上传文件" });
  await (
    await chooser
  ).setFiles({
    name: "my-photo.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("photo"),
  });
  await expect(personal.locator(".upload-result.complete")).toBeVisible();
  const put = state.requests.find((request) => request.method === "PUT");
  expect(put.pathname).toBe("/api/admin/uploads/" + "a".repeat(32));
  expect(put.body).toBe("photo");
  expect(put.headers.authorization).toBe("DPoP scoped-secret");
  expect(put.headers.dpop).toBe("fixture-proof");
  expect(state.scopes).toContain("inbox:write");
  expect(
    state.requests.filter(
      (request) =>
        request.method === "POST" && request.pathname === "/api/admin/links",
    ),
  ).toHaveLength(2);
});

for (const slow of [false, true]) {
  test(`file intake reveals upload actions after a ${slow ? "slow" : "fast"} permission check`, async ({
    page,
  }) => {
    await installIntake(page);
    const account = Promise.withResolvers();
    await page.route("**/fixture/account", async (route) => {
      await account.promise;
      await route.fallback();
    });
    await page.goto("/files/");
    const trigger = page.locator("#file-intake-trigger");
    await expect(trigger).toBeVisible();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await trigger.click();
    const dialog = page.locator("dialog:has(.intake-entry-body)");
    const spinner = dialog.locator(".intake-spinner");
    await expect(dialog).toHaveAccessibleName("上传文件");
    await expect(dialog.getByRole("heading")).toHaveCount(0);
    await expect(dialog.getByRole("status")).toHaveText("正在检查上传权限…");
    await expect(dialog.getByRole("button", { name: "关闭" })).toBeEnabled();

    await page.clock.runFor(100);
    await expect(spinner).toHaveCSS("opacity", "0");
    if (slow) {
      await page.clock.runFor(200);
      await expect(spinner).toHaveCSS("opacity", "1");
    }
    account.resolve();
    await expect(dialog.getByRole("heading")).toHaveText("上传文件");
    await expect(
      dialog.getByRole("button", { name: "选择文件上传", exact: true }),
    ).toBeEnabled();
    await expect(spinner).toHaveCSS("opacity", "0");
  });
}

test("file intake explains upload permission to members without a title or login button", async ({
  page,
}, info) => {
  const state = await installIntake(page, { role: "member" });
  await page.addInitScript(() => {
    navigator.clipboard.readText = async () => "";
  });
  await page.goto("/files/");
  const trigger = page.locator("#file-intake-trigger");
  await trigger.click();
  const guide = page.getByRole("dialog", { name: "上传文件", exact: true });
  await expect(guide.getByRole("heading")).toHaveCount(0);
  await expect(guide).toContainText("您当前的账号暂无上传权限");
  await expect(guide).toContainText("为你的账户开通直接上传权限");
  await expect(
    guide.getByRole("button", { name: "立即登录", exact: true }),
  ).toHaveCount(0);
  const check = guide.getByRole("button", { name: "检测剪贴板", exact: true });
  await expect(check).toHaveClass(/primary-button/);
  await guide.screenshot({ path: info.outputPath("member-upload.png") });
  const button = await check.boundingBox();
  expect(button.height).toBeGreaterThanOrEqual(44);
  expect(
    await guide.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await check.click();
  await expect(guide.locator(".toast-center")).toHaveText("未检测到上传链接");
  await guide.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await expect(guide).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.scopes).toHaveLength(0);
});

test("file intake guides guests without a title and keeps both actions comfortable", async ({
  page,
}, info) => {
  await installIntake(page, { signedOut: true });
  let clipboardReads = 0;
  await page.exposeFunction("recordClipboardRead", () => clipboardReads++);
  await page.addInitScript(() => {
    navigator.clipboard.readText = () => window.recordClipboardRead();
  });
  await page.goto("/files/");
  const trigger = page.locator("#file-intake-trigger");
  await trigger.click();
  const guide = page.getByRole("dialog", { name: "上传文件", exact: true });
  await expect(guide.getByRole("heading")).toHaveCount(0);
  await expect(guide).toContainText("您当前是游客，暂无上传权限");
  await expect(guide).toContainText("联系管理员获取上传链接");
  await expect(guide).toContainText("复制收到的上传链接后");
  await expect(guide.locator(".intake-guest-heading")).toBeFocused();
  const login = guide.getByRole("button", { name: "立即登录", exact: true });
  const clipboard = guide.getByRole("button", {
    name: "检测剪贴板",
    exact: true,
  });
  const screenshot = await guide.screenshot({
    path: info.outputPath("guest-upload.png"),
  });
  const first = await login.boundingBox(),
    second = await clipboard.boundingBox();
  expect(first.height).toBeGreaterThanOrEqual(44);
  expect(second.height).toBeGreaterThanOrEqual(44);
  expect(first.y).toBe(second.y);
  expect(first.width).toBeGreaterThanOrEqual(120);
  expect(
    await guide.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  expect(clipboardReads).toBe(0);
  await expect(guide.locator(".intake-sheet-handle")).toHaveCount(
    isCompact(page) ? 1 : 0,
  );
  await info.attach("guest-upload-layout", {
    body: screenshot,
    contentType: "image/png",
  });
  await guide.getByRole("button", { name: "关闭" }).click();
  await expect(guide).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

for (const signedOut of [true, false]) {
  test(`${signedOut ? "guest" : "member"} clipboard feedback stays centered without moving the upload dialog or buttons`, async ({
    page,
  }, info) => {
    await installIntake(page, { signedOut, role: "member" });
    await page.addInitScript(() => {
      window.clipboardReads = 0;
      navigator.clipboard.readText = () => {
        window.clipboardReads++;
        return new Promise((resolve) => {
          window.releaseClipboard = resolve;
        });
      };
    });
    await page.goto("/files/");
    await page.locator("#file-intake-trigger").click();
    const guide = page.getByRole("dialog", { name: "上传文件", exact: true });
    const check = guide.getByRole("button", {
      name: "检测剪贴板",
      exact: true,
    });
    await guide.evaluate((node) =>
      Promise.all(node.getAnimations().map((animation) => animation.finished)),
    );
    const layout = () =>
      guide.evaluate((node) =>
        [node, ...node.querySelectorAll(".intake-guest-actions button")].map(
          (element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          },
        ),
      );
    const original = await layout();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await check.click();
    await expect(check).toBeDisabled();
    await expect(check).toHaveText("检测剪贴板");
    await expect(check).toHaveAttribute("aria-busy", "true");
    await expect(check).toHaveCSS("opacity", "1");
    if (signedOut)
      await expect(
        guide.getByRole("button", { name: "立即登录", exact: true }),
      ).toHaveCSS("opacity", "1");
    const spinner = check.locator(".intake-clipboard-spinner");
    await page.clock.runFor(100);
    await expect(spinner).toHaveCSS("opacity", "0");
    await page.clock.runFor(150);
    await expect(spinner).toHaveCSS("opacity", "1");
    expect(await layout()).toEqual(original);
    await check.evaluate((node) => node.click());
    expect(await page.evaluate(() => window.clipboardReads)).toBe(1);
    await page.evaluate(() => window.releaseClipboard(""));
    const notification = guide.locator(".toast-center");
    await expect(notification).toHaveText("未检测到上传链接");
    await expect(notification).toHaveAttribute("role", "status");
    await expect(notification).toHaveCSS(
      "background-color",
      "rgba(20, 20, 24, 0.88)",
    );
    await expect(notification).toHaveCSS("color", "rgb(255, 255, 255)");
    expect(
      await notification.evaluate((node) => node.matches(":popover-open")),
    ).toBe(true);
    const offset = await notification.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return [
        Math.abs(box.x + box.width / 2 - innerWidth / 2),
        Math.abs(box.y + box.height / 2 - innerHeight / 2),
      ];
    });
    expect(offset.every((value) => value < 1)).toBe(true);
    await expect(check).toBeEnabled();
    await expect(spinner).toHaveCSS("opacity", "0");
    expect(await layout()).toEqual(original);
    await page.screenshot({
      path: info.outputPath("clipboard-centered-toast.png"),
      animations: "disabled",
    });
    await page.clock.runFor(1900);
    await expect(notification).not.toHaveClass(/leaving/);
    await page.clock.runFor(100);
    await expect(notification).toHaveClass(/leaving/);
    await page.clock.runFor(200);
    await expect(notification).toHaveCount(0);
    expect(await layout()).toEqual(original);

    await page.evaluate(() => {
      navigator.clipboard.readText = async () => {
        throw new DOMException("Denied", "NotAllowedError");
      };
    });
    await check.click();
    await expect(notification).toHaveText("无法读取剪贴板，请允许访问后重试");
    await expect(notification).toHaveAttribute("role", "alert");
    await expect(spinner).toHaveCSS("opacity", "0");
    expect(await layout()).toEqual(original);
    await page.clock.runFor(2900);
    await expect(notification).not.toHaveClass(/leaving/);
    await page.clock.runFor(100);
    await expect(notification).toHaveClass(/leaving/);
    await page.clock.runFor(200);
    await expect(notification).toHaveCount(0);
    expect(await layout()).toEqual(original);
    await page.clock.resume();
    await guide
      .getByRole("button", { name: "关闭对话框", exact: true })
      .click();
    await expect(guide).toHaveCount(0);
  });

  test(`${signedOut ? "guest" : "member"} upload checks the clipboard on demand and opens a matching upload invitation`, async ({
    page,
  }) => {
    await installIntake(page, { signedOut, role: "member" });
    await page.addInitScript(() => {
      window.clipboardText = "";
      navigator.clipboard.readText = async () => window.clipboardText;
    });
    await page.route("**/api/uploads", (route) =>
      route.fulfill({ json: fixtureLink }),
    );
    await page.goto("/files/");
    await page.locator("#file-intake-trigger").click();
    const guide = page.getByRole("dialog", { name: "上传文件", exact: true });
    const check = guide.getByRole("button", {
      name: "检测剪贴板",
      exact: true,
    });
    await check.click();
    await expect(guide.locator(".toast-center")).toHaveText("未检测到上传链接");
    await page.evaluate(() => {
      window.clipboardText =
        "https://other.example/upload#token=" + "A".repeat(43);
    });
    await check.click();
    await expect(page).toHaveURL(/\/files\/$/);
    await expect(check).toBeEnabled();
    await page.evaluate(() => {
      window.clipboardText =
        "请上传到：" +
        location.origin +
        "/upload#token=" +
        "A".repeat(43) +
        "。";
    });
    await check.click();
    await expect(page).toHaveURL(new RegExp("/upload#token=" + token + "$"));
    await expect(guide).toHaveCount(0);
    await expect(page.locator(".upload-page")).toBeVisible();
  });
}

test("guest upload explains denied clipboard access and ignores a read completed after dismissal", async ({
  page,
}) => {
  await installIntake(page, { signedOut: true });
  await page.addInitScript(() => {
    navigator.clipboard.readText = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page.goto("/files/");
  const trigger = page.locator("#file-intake-trigger");
  await trigger.click();
  const guide = page.getByRole("dialog", { name: "上传文件", exact: true });
  await guide.getByRole("button", { name: "检测剪贴板", exact: true }).click();
  await expect(guide.getByRole("alert")).toContainText("无法读取剪贴板");
  await page.evaluate(() => {
    navigator.clipboard.readText = () =>
      new Promise((resolve) => {
        window.releaseClipboard = resolve;
      });
  });
  await guide.getByRole("button", { name: "检测剪贴板", exact: true }).click();
  await guide.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.evaluate(() =>
    window.releaseClipboard(
      location.origin + "/upload#token=" + "A".repeat(43),
    ),
  );
  await expect(guide).toHaveCount(0);
  await expect(page).toHaveURL(/\/files\/$/);
  await trigger.click();
  await expect(
    guide.getByRole("button", { name: "检测剪贴板", exact: true }),
  ).toBeEnabled();
  await expect(guide.getByRole("alert")).toHaveCount(0);
});

test("guest upload signs in directly, permits retry and cancels a dismissed login", async ({
  page,
}) => {
  await installIntake(page, { signedOut: true });
  let logins = 0;
  const release = Promise.withResolvers();
  await page.route("**/fixture/login", async (route) => {
    logins++;
    if (logins === 1)
      return route.fulfill({ status: 503, json: { error: "登录暂不可用" } });
    await release.promise;
    await route.fulfill({ json: { url: "/files/?logged-in=1" } });
  });
  await page.goto("/files/");
  await page.locator("#file-intake-trigger").click();
  const guide = page.getByRole("dialog", { name: "上传文件", exact: true });
  const login = guide.getByRole("button", { name: "立即登录", exact: true });
  expect(logins).toBe(0);
  await login.click();
  await expect(guide.getByRole("alert")).toHaveText("登录暂不可用");
  await expect(login).toBeEnabled();
  await login.click();
  await expect(
    guide.getByRole("button", { name: "正在前往登录…" }),
  ).toBeDisabled();
  await expect.poll(() => logins).toBe(2);
  await guide.getByRole("button", { name: "关闭对话框", exact: true }).click();
  release.resolve();
  await expect(guide).toHaveCount(0);
  await expect(page).toHaveURL(/\/files\/$/);
});

test.describe("English guest upload guidance", () => {
  test.use({ locale: "en-US" });
  test("keeps the title hidden and both actions within the dialog", async ({
    page,
  }, info) => {
    await installIntake(page, { signedOut: true });
    await page.goto("/files/");
    await page.locator("#file-intake-trigger").click();
    const guide = page.getByRole("dialog", {
      name: "Upload files",
      exact: true,
    });
    await expect(guide.getByRole("heading")).toHaveCount(0);
    await expect(guide).toContainText("You’re browsing as a guest");
    await expect(
      guide.getByRole("button", { name: "Sign in now", exact: true }),
    ).toBeEnabled();
    await expect(
      guide.getByRole("button", { name: "Check clipboard", exact: true }),
    ).toBeEnabled();
    await guide.screenshot({ path: info.outputPath("guest-upload-en.png") });
    expect(
      await guide.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  });
  test("file intake shows signed-in members one clipboard action without a title", async ({
    page,
  }, info) => {
    await installIntake(page, { role: "member" });
    await page.goto("/files/");
    await page.locator("#file-intake-trigger").click();
    const guide = page.getByRole("dialog", {
      name: "Upload files",
      exact: true,
    });
    await expect(guide.getByRole("heading")).toHaveCount(0);
    await expect(guide).toContainText(
      "Your account doesn’t have upload permission yet",
    );
    await expect(guide).toContainText(
      "permission to upload directly from your account",
    );
    await expect(
      guide.getByRole("button", { name: "Sign in now", exact: true }),
    ).toHaveCount(0);
    await expect(
      guide.getByRole("button", { name: "Check clipboard", exact: true }),
    ).toBeEnabled();
    await guide.screenshot({ path: info.outputPath("member-upload-en.png") });
    expect(
      await guide.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await guide
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(guide).toHaveCount(0);
  });
});

test("file intake stays hidden for guests on plain WebDAV", async ({
  page,
}) => {
  await installIntake(page, { signedOut: true, webDAVOnly: true });
  const capabilities = page.waitForResponse("**/api/capabilities");
  await page.goto("/files/");
  await (await capabilities).finished();
  await expect(page.locator("#file-intake-trigger")).toHaveCount(0);
});

test("admin layout navigates to a member and saves direct upload permissions", async ({
  page,
}, info) => {
  const sub = "ld_" + "A".repeat(22);
  let member = {
    sub,
    name: "小王",
    admin: false,
    assignedElsewhere: false,
    permission: { enabled: false, maxFiles: 100, maxFileBytes: 100 * 1048576 },
  };
  const state = await install(page, {
    capabilities: { adminLinks: true, adminInbox: true, adminUsers: true },
    async handle(route, url, request) {
      if (url.pathname === "/api/admin/users") {
        await route.fulfill({ json: { users: [member], nextOffset: null } });
        return true;
      }
      if (
        url.pathname === "/api/admin/users/" + sub &&
        request.method() === "PUT"
      ) {
        member = { ...member, permission: request.postDataJSON() };
        await route.fulfill({ status: 204 });
        return true;
      }
      return false;
    },
  });
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/inbox$/);
  const navigation = page.locator(".admin-navigation");
  await page.getByRole("button", { name: "访客投递", exact: true }).click();
  await expect(page).toHaveURL(/source=guest$/);
  await expect
    .poll(() =>
      state.requests.some(({ query }) => query.includes("source=guest")),
    )
    .toBe(true);
  await navigation.getByRole("button", { name: "用户", exact: true }).click();
  await page.getByRole("button", { name: /小王/ }).click();
  await expect(page).toHaveURL(new RegExp("/admin/users/" + sub + "$"));
  const toggle = page.getByRole("switch", { name: /允许直接投递/ });
  await expect(toggle).not.toBeChecked();
  if (isCompact(page)) {
    await expect(navigation).toBeHidden();
    await expect(page.locator(".admin-user-list-pane")).toBeHidden();
  } else {
    await expect(navigation).toBeVisible();
    await expect(page.locator(".admin-user-list-pane")).toBeVisible();
  }
  await toggle.check();
  await page.locator("[name=maxFiles]").fill("12");
  await page.getByRole("button", { name: "保存权限" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "权限已保存" }),
  ).toBeVisible();
  expect(member.permission).toEqual({
    enabled: true,
    maxFiles: 12,
    maxFileBytes: 100 * 1048576,
  });
  expect(state.scopes).toContain("users:write");
  await assertNoOverflow(page);
  if (process.env.ADMIN_SCREENSHOTS === "1") {
    const path = info.outputPath("permission.png");
    await page.screenshot({ path });
    await info.attach("permission", { path, contentType: "image/png" });
  }
  await page.reload();
  await expect(
    page.getByRole("switch", { name: /允许直接投递/ }),
  ).toBeChecked();
});

test("an authorized ordinary user deposits from Files with their login proof", async ({
  page,
}) => {
  await installIntake(page, {
    role: "member",
    capabilities: { directUploads: true },
  });
  const id = "b".repeat(32);
  let received = false;
  await page.route(/\/api\/account\/uploads(?:\/[^/]+)?$/, (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe("DPoP scoped-secret");
    expect(request.headers().dpop).toBe("fixture-proof");
    if (request.method() === "POST")
      return route.fulfill({ status: 201, json: { id } });
    if (request.method() === "PUT") {
      expect(request.postData()).toBe("deposit");
      received = true;
      return route.fulfill({ status: 201, json: { id, status: "complete" } });
    }
    return route.fulfill({
      json: { ...fixtureLink, usedFiles: 0, usedBytes: 0 },
    });
  });
  await page.goto("/files/");
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#file-intake-trigger").click();
  if (isCompact(page)) {
    const sheet = page.locator(".intake-sheet");
    await expect(
      sheet.getByRole("button", { name: "邀请他人上传" }),
    ).toHaveCount(0);
    await sheet.getByRole("button", { name: "选择文件上传" }).click();
  }
  await (
    await chooser
  ).setFiles({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("deposit"),
  });
  const dialog = page.getByRole("dialog", { name: "上传文件" });
  await expect(dialog.locator(".upload-result.complete")).toBeVisible();
  expect(received).toBe(true);
  await expect(dialog.getByRole("link", { name: "查看收件" })).toHaveCount(0);
});
