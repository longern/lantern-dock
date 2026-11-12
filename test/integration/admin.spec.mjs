import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startFixture } from "./fixture.mjs";
import { siteIdentitySubject } from "./sso-fixture.mjs";

// This suite uses production dist, real workers-sso login, the real Worker token
// endpoint, real NAS signature/proof verification, and the actual UDP bridge.
// No identity adapter, fake grant, or management API response is installed.
test.use({ locale: "zh-CN", acceptDownloads: true });
let fixture;
test.beforeAll(async () => {
  test.setTimeout(180000);
  fixture = await startFixture({ nas: true, identity: true });
});
test.afterAll(async () => fixture?.stop());
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus)
    await info.attach("bridge.log", {
      body: fixture?.logs || "",
      contentType: "text/plain",
    });
});

async function loginAdministrator(page) {
  await page.goto(fixture.origin + "/account");
  await page.getByRole("button", { name: "统一登录", exact: true }).click();
  const consent = page.getByRole("button", {
    name: "允许登录 LanternDock",
    exact: true,
  });
  await Promise.race([
    consent.waitFor({ timeout: 10000 }),
    page
      .getByRole("button", { name: "退出登录", exact: true })
      .waitFor({ timeout: 10000 }),
  ]);
  if (await consent.isVisible()) await consent.click();
  await expect(page.getByLabel("用户标识（sub）")).toHaveValue(
    siteIdentitySubject,
  );
  await expect(
    page.locator(".account-details dd").getByText("管理员", { exact: true }),
  ).toBeVisible();
  await page.goto(fixture.origin + "/admin/links");
  await expect(page.locator("#admin-create-link")).toBeVisible();
}

async function installBackendRoute(context, resourceOrigin) {
  // Only transport routing changes: forward the original method, body, query,
  // Origin and signed DPoP/Authorization headers to the actual NAS process.
  await context.route(resourceOrigin + "/**", async (route) => {
    const target = new URL(route.request().url());
    const response = await route.fetch({
      url: fixture.nas.endpoint + target.pathname + target.search,
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  });
}

// Independent protocol probes complement the production UI flow. Read only the
// existing browser-bound non-extractable private CryptoKey; never replace it or
// fabricate a login. The real Worker signs every token after its nonce exchange.
// The resulting signed request is sent to the actual NAS by the test runner so
// we can inspect scope/role failures and range headers even behind WebTransport.
async function signedHeaders(
  page,
  { method = "GET", path, scope, resourceOrigin },
) {
  return page.evaluate(
    async ({ method, path, scope, resourceOrigin }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("lantern-dock-identity", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      let pair;
      try {
        pair = await new Promise((resolve, reject) => {
          const request = db
            .transaction("keys")
            .objectStore("keys")
            .get("proof");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
      if (!pair || pair.privateKey.extractable)
        throw new Error(
          "The real login did not retain a non-extractable proof key",
        );
      const encode = (bytes) =>
        btoa(String.fromCharCode(...new Uint8Array(bytes)))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, "");
      const encoder = new TextEncoder();
      const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const jwk = {
        kty: publicKey.kty,
        crv: publicKey.crv,
        x: publicKey.x,
        y: publicKey.y,
      };
      async function proof(method, uri, token, nonce) {
        const payload = {
          htm: method,
          htu: uri,
          iat: Math.floor(Date.now() / 1000),
          jti: crypto.randomUUID(),
        };
        if (nonce) payload.nonce = nonce;
        if (token)
          payload.ath = encode(
            await crypto.subtle.digest("SHA-256", encoder.encode(token)),
          );
        const input =
          encode(
            encoder.encode(
              JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk }),
            ),
          ) +
          "." +
          encode(encoder.encode(JSON.stringify(payload)));
        return (
          input +
          "." +
          encode(
            await crypto.subtle.sign(
              { name: "ECDSA", hash: "SHA-256" },
              pair.privateKey,
              encoder.encode(input),
            ),
          )
        );
      }
      const endpoint = location.origin + "/api/auth/token";
      let nonce;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(endpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            DPoP: await proof("POST", endpoint, undefined, nonce),
          },
          body: new URLSearchParams({
            grant_type: "urn:lantern-dock:params:oauth:grant-type:session",
            client_id: location.origin + "/",
            resource: location.origin + "/nas",
            scope,
          }),
        });
        const grant = await response.json();
        if (attempt === 0 && grant.error === "use_dpop_nonce") {
          nonce = response.headers.get("DPoP-Nonce");
          continue;
        }
        if (
          !response.ok ||
          grant.token_type !== "DPoP" ||
          grant.scope !== scope
        )
          throw new Error(
            "Real Worker did not issue the requested scoped grant",
          );
        return {
          Authorization: "DPoP " + grant.access_token,
          DPoP: await proof(
            method,
            resourceOrigin + new URL(path, location.origin).pathname,
            grant.access_token,
          ),
          Origin: location.origin,
        };
      }
      throw new Error("Real Worker nonce exchange did not finish");
    },
    { method, path, scope, resourceOrigin },
  );
}
async function privateRequest(page, path, scope, resourceOrigin, options = {}) {
  const method = options.method || "GET";
  const headers = await signedHeaders(page, {
    method,
    path,
    scope,
    resourceOrigin,
  });
  return fetch(fixture.nas.endpoint + path, {
    ...options,
    method,
    headers: { ...headers, ...options.headers },
  });
}
async function assertDownloaded(page, name, contents) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: `下载“${name}”`, exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(name);
  expect(await download.failure()).toBeNull();
  expect(await readFile(await download.path())).toEqual(Buffer.from(contents));
}

for (const transport of ["webtransport", "http"]) {
  test(`${transport}: real administrator creates a link, receives guest files privately, revokes and loses access`, async ({
    page,
    context,
    browser,
  }, info) => {
    test.setTimeout(120000);
    const previous = { ...fixture.env };
    const resourceOrigin =
      transport === "http" ? "https://nas-api.example" : fixture.origin;
    const title = `真实管理收件 ${transport}`;
    const filename = `私有资料-${transport}.txt`;
    const contents = `Private ${transport} collection: 中文内容\n`;
    const errors = [];
    const scopes = [];
    const pending = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/auth/token")
        pending.push(
          response.json().then((body) => {
            if (response.ok()) scopes.push(body.scope);
          }),
        );
    });
    let guestContext;
    try {
      await fixture.nas.administrators([siteIdentitySubject], {
        resourceOrigin,
      });
      if (transport === "http") {
        fixture.env.BACKEND_TRANSPORT = "http";
        fixture.env.BACKEND_ENDPOINT = resourceOrigin;
      }
      await fixture.browser(context);
      if (transport === "http")
        await installBackendRoute(context, resourceOrigin);
      // Exercise the normal Blob download fallback instead of an OS file picker.
      await context.addInitScript(() => {
        delete window.showSaveFilePicker;
      });
      await loginAdministrator(page);
      await page.locator("#admin-create-link").click();
      const dialog = page.locator("#admin-create-dialog");
      await dialog.locator("[name=title]").fill(title);
      for (const [name, value] of [
        ["maxFileMiB", "1"],
        ["maxTotalMiB", "2"],
        ["maxFiles", "3"],
      ]) {
        await dialog.locator(`select[name=${name}]`).selectOption("custom");
        await dialog.locator(`input[name=${name}]`).fill(value);
      }
      await dialog.locator("button[type=submit]").click();
      await expect(
        dialog.getByRole("heading", { name: "邀请链接已创建", exact: true }),
      ).toBeVisible();
      const uploadURL = await page.locator("#admin-created-url").inputValue();
      const token = new URLSearchParams(new URL(uploadURL).hash.slice(1)).get(
        "token",
      );
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await dialog.getByRole("button", { name: "完成", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const card = page.locator(".admin-link-card").filter({ hasText: title });
      await expect(card).toHaveCount(1);
      await card
        .getByRole("button", { name: `分享“${title}”`, exact: true })
        .click();
      await expect(page.locator("#admin-created-url")).toHaveValue(uploadURL);
      await expect(dialog.locator(".invite-success")).toHaveCount(0);
      await dialog
        .getByRole("button", { name: "显示二维码", exact: true })
        .click();
      await expect(dialog.locator("canvas[role=img]")).toBeVisible();
      await dialog.getByRole("button", { name: "完成", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(
        await page.evaluate(() =>
          JSON.stringify([localStorage, sessionStorage]),
        ),
      ).not.toContain(token);
      await expect(page.locator("body")).not.toContainText(token);

      guestContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        locale: "zh-CN",
        viewport: info.project.use.viewport,
        isMobile: info.project.use.isMobile,
        hasTouch: info.project.use.hasTouch,
      });
      await fixture.browser(guestContext);
      await guestContext.clearCookies();
      if (transport === "http")
        await installBackendRoute(guestContext, resourceOrigin);
      const guest = await guestContext.newPage();
      guest.on("pageerror", (error) => errors.push(error.message));
      await guest.goto(uploadURL);
      await expect(guest.locator(".upload-subtitle")).toHaveText(title);
      expect(
        await guest.evaluate(
          async () =>
            (await (await fetch("/api/auth/session")).json()).authenticated,
        ),
      ).toBe(false);
      await guest.getByLabel("选择上传文件").setInputFiles({
        name: filename,
        mimeType: "text/plain",
        buffer: Buffer.from(contents),
      });
      await expect(guest.locator(".upload-result.complete")).toHaveText(
        "已接收",
      );
      await page
        .getByRole("button", { name: `查看“${title}”的收件`, exact: true })
        .click();
      await expect(
        page.locator(".admin-inbox-file").filter({ hasText: filename }),
      ).toHaveCount(1);
      await assertDownloaded(page, filename, contents);

      const listing = await privateRequest(
        page,
        "/api/admin/inbox",
        "inbox:read",
        resourceOrigin,
      );
      expect(listing.status).toBe(200);
      const file = (await listing.json()).uploads.find(
        (entry) => entry.name === filename,
      );
      expect(file).toMatchObject({
        name: filename,
        linkTitle: title,
        status: "complete",
        size: Buffer.byteLength(contents),
      });
      const downloadPath = `/api/admin/inbox/${file.id}/download`;
      const guestDownload = await fetch(fixture.nas.endpoint + downloadPath, {
        headers: { Authorization: "Bearer " + token },
      });
      expect(guestDownload.status).toBe(401);
      await guestDownload.body?.cancel();
      const insufficient = await privateRequest(
        page,
        "/api/admin/links",
        "account:read",
        resourceOrigin,
      );
      expect(insufficient.status).toBe(403);
      expect(insufficient.headers.get("WWW-Authenticate")).toContain(
        'scope="links:read"',
      );
      expect((await insufficient.json()).code).toBe("INSUFFICIENT_SCOPE");
      const range = await privateRequest(
        page,
        downloadPath,
        "inbox:read",
        resourceOrigin,
        { headers: { Range: "bytes=0-6" } },
      );
      expect(range.status).toBe(206);
      expect(await range.text()).toBe("Private");
      expect(range.headers.get("Cache-Control")).toBe("no-store");
      expect(range.headers.get("Access-Control-Expose-Headers")).toContain(
        "Content-Disposition",
      );

      await page
        .getByRole("navigation", { name: "后台管理分类", exact: true })
        .getByRole("button", { name: "邀请", exact: true })
        .click();
      await card
        .getByRole("button", { name: `撤销“${title}”`, exact: true })
        .click();
      await page
        .locator("#admin-revoke-dialog")
        .getByRole("button", { name: "撤销链接", exact: true })
        .click();
      await expect(page.locator("#admin-revoke-dialog")).toHaveCount(0);
      await expect(card.locator(".admin-badge")).toHaveAttribute(
        "data-status",
        "revoked",
      );
      await guest.reload();
      await expect(guest.getByRole("alert")).toContainText("已撤销");
      await page
        .getByRole("button", { name: `查看“${title}”的收件`, exact: true })
        .click();
      await assertDownloaded(page, filename, contents);
      await Promise.all(pending);
      expect(scopes).toEqual(
        expect.arrayContaining([
          "account:read",
          "links:read",
          "links:write",
          "inbox:read",
        ]),
      );

      // Keep a genuinely signed, unexpired grant from before administrator
      // removal. Restarting with new environment subjects must deny it too.
      const staleHeaders = await signedHeaders(page, {
        path: downloadPath,
        scope: "inbox:read",
        resourceOrigin,
      });
      await fixture.nas.administrators([], { resourceOrigin });
      const removed = await fetch(fixture.nas.endpoint + downloadPath, {
        headers: staleHeaders,
      });
      expect(removed.status).toBe(403);
      expect((await removed.json()).code).toBe("ADMIN_REQUIRED");
      const deniedCreate = await privateRequest(
        page,
        "/api/admin/links",
        "links:write",
        resourceOrigin,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Must not exist",
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            maxFileBytes: 1,
            maxTotalBytes: 1,
            maxFiles: 1,
          }),
        },
      );
      expect(deniedCreate.status).toBe(403);
      expect((await deniedCreate.json()).code).toBe("ADMIN_REQUIRED");
      await page
        .getByRole("button", { name: "刷新私有收件", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "需要管理员权限", exact: true }),
      ).toBeVisible();
      await expect(
        page.locator("#admin-create-link,.admin-inbox-file,.admin-navigation"),
      ).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await guestContext?.close();
      Object.assign(fixture.env, previous);
      await fixture.nas.administrators([]);
    }
  });
}

test("an administrator uploads to their own inbox through the file intake actions", async ({
  page,
  context,
}) => {
  await fixture.nas.administrators([siteIdentitySubject]);
  await fixture.browser(context);
  await loginAdministrator(page);
  await page.goto(fixture.origin + "/files/");
  await page.locator("#file-intake-trigger").click();
  const dialog = page.getByRole("dialog", { name: "上传文件" });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "选择文件上传", exact: true }).click(),
  ]);
  const name = "my-personal-photo.jpg";
  await chooser.setFiles({
    name,
    mimeType: "image/jpeg",
    buffer: Buffer.from("personal upload"),
  });
  await expect(dialog.locator(".upload-result.complete")).toHaveText("已接收");
  await dialog.getByRole("link", { name: "查看收件" }).click();
  const row = page
    .locator(".admin-inbox-file")
    .filter({ hasText: name })
    .first();
  await expect(row.getByText("我的收件", { exact: true })).toBeVisible();
  await page
    .locator(".admin-navigation")
    .getByRole("button", { name: "用户", exact: true })
    .click();
  await expect(page.locator(".admin-user-list")).toContainText("管理员");
});
