import { test, expect } from "@playwright/test";
import { startFixture } from "./fixture.mjs";
import {
  siteIdentitySubject as identitySubject,
  identitySubject as upstreamSubject,
} from "./sso-fixture.mjs";

const otherSiteSubject = "ld_" + "A".repeat(22);
test.use({ locale: "zh-CN" });

let fixture;
test.beforeAll(async () => {
  test.setTimeout(180000);
  fixture = await startFixture({ nas: true, identity: true });
});
test.afterAll(async () => {
  await fixture?.stop();
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus)
    await info.attach("bridge.log", {
      body: fixture?.logs || "",
      contentType: "text/plain",
    });
});
test.beforeEach(async ({ context }) => {
  await fixture.browser(context);
});
async function login(page) {
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
  await expect(page.getByLabel("用户标识（sub）")).toHaveValue(identitySubject);
}

test("real workers-sso CIMD login uses HttpOnly cookies and shows a copyable administrator bootstrap", async ({
  page,
  context,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await fixture.nas.administrators([]);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "尚未配置管理员", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("ADMIN_SUBJECTS 的值")).toHaveValue(
    identitySubject,
  );
  await expect(
    page.getByRole("heading", {
      name: "测试用户 <b>plain text</b>",
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.locator("h1 b").count()).toBe(0);
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "lantern-session",
  );
  const cookie = (await context.cookies(fixture.origin)).find(
    (item) => item.name === "__Host-lantern-session",
  );
  expect(cookie).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.copiedIdentity = value;
        },
      },
    }),
  );
  await page.getByRole("button", { name: "复制 sub", exact: true }).click();
  expect(await page.evaluate(() => window.copiedIdentity)).toBe(
    identitySubject,
  );
  await page
    .getByRole("button", { name: "复制管理员配置", exact: true })
    .click();
  expect(await page.evaluate(() => window.copiedIdentity)).toBe(
    identitySubject,
  );
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("account-bootstrap.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByLabel("用户标识（sub）")).toHaveValue(identitySubject);
  await expect(
    page.getByRole("heading", { name: "尚未配置管理员", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("real OIDC login returns to a shared file instead of losing its location", async ({
  page,
}) => {
  await page.goto(
    fixture.origin +
      "/account?return=" +
      encodeURIComponent("/files/hello.txt"),
  );
  await page.getByRole("button", { name: "统一登录", exact: true }).click();
  await page
    .getByRole("button", { name: "允许登录 LanternDock", exact: true })
    .click();
  await expect(page).toHaveURL(fixture.origin + "/files/hello.txt");
  await expect(page.locator("#preview-name")).toHaveText("hello.txt");
  await expect(page.locator(".preview-content pre")).toContainText(
    "WebTransport",
  );
});

test("administrator subjects are enforced on the NAS and apply to an existing login", async ({
  page,
}) => {
  await fixture.nas.administrators([]);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "尚未配置管理员", exact: true }),
  ).toBeVisible();
  await fixture.nas.administrators([otherSiteSubject, identitySubject]);
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(
    page.getByText("管理员权限已启用", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "尚未配置管理员", exact: true }),
  ).toHaveCount(0);
  await fixture.nas.administrators([otherSiteSubject]);
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(page.getByText("普通用户", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "统一登录", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      async () =>
        (await (await fetch("/api/auth/session")).json()).authenticated,
    ),
  ).toBe(false);
});

test("discovery, nonce retry and signing-key rollover work with an existing browser session", async ({
  page,
  context,
}) => {
  await fixture.nas.administrators([]);
  const replies = [];
  const pending = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/auth/token")
      pending.push(
        response
          .json()
          .then((body) => replies.push({ status: response.status(), body })),
      );
  });
  fixture.env.AUTH_SIGNING_KEY_VERSIONS = '["v1","v2"]';
  try {
    await login(page);
    await expect(
      page.getByRole("heading", { name: "尚未配置管理员", exact: true }),
    ).toBeVisible();
    await Promise.all(pending);
    expect(
      replies.some(
        (r) => r.status === 400 && r.body.error === "use_dpop_nonce",
      ),
    ).toBe(true);
    const first = replies.find((r) => r.status === 200).body;
    expect(first).toMatchObject({
      token_type: "DPoP",
      expires_in: 60,
      scope: "account:read",
    });
    expect(first.accessToken).toBeUndefined();
    const cookie = (await context.cookies(fixture.origin)).find(
      (c) => c.name === "__Host-lantern-session",
    ).value;
    fixture.env.AUTH_SIGNING_KEY_VERSIONS = '["v2","v1"]';
    const nextToken = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/token" &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: "重新检测", exact: true }).click();
    await nextToken;
    await expect(
      page.getByRole("button", { name: "重新检测", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("heading", { name: "尚未配置管理员", exact: true }),
    ).toBeVisible();
    await Promise.all(pending);
    const last = replies.filter((r) => r.status === 200).at(-1).body;
    const header = (token) =>
      JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(header(last.access_token).kid).not.toBe(
      header(first.access_token).kid,
    );
    expect(
      (await context.cookies(fixture.origin)).find(
        (c) => c.name === "__Host-lantern-session",
      ).value,
    ).toBe(cookie);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "尚未配置管理员", exact: true }),
    ).toBeVisible();
  } finally {
    delete fixture.env.AUTH_SIGNING_KEY_VERSIONS;
  }
});

test("direct HTTPS identities bind the proof to the NAS public origin", async ({
  page,
}) => {
  const previous = { ...fixture.env };
  const resourceOrigin = "https://nas-api.example";
  const proofs = [];
  await fixture.nas.administrators([], { resourceOrigin });
  fixture.env.BACKEND_TRANSPORT = "http";
  fixture.env.BACKEND_ENDPOINT = resourceOrigin;
  try {
    await page.route(resourceOrigin + "/**", async (route) => {
      const request = route.request();
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname === "/api/account"
      )
        proofs.push((await request.allHeaders()).dpop);
      const response = await route.fetch({
        url: fixture.nas.endpoint + new URL(request.url()).pathname,
      });
      await route.fulfill({ response });
    });
    await login(page);
    await expect(
      page.getByRole("heading", { name: "尚未配置管理员", exact: true }),
    ).toBeVisible();
    expect(
      JSON.parse(Buffer.from(proofs[0].split(".")[1], "base64url").toString())
        .htu,
    ).toBe(resourceOrigin + "/api/account");
    // An incorrect NAS resource-origin setting must fail proof verification.
    await fixture.nas.administrators([]);
    await page.getByRole("button", { name: "重新检测", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("无法验证请求");
    await expect(page.getByLabel("用户标识（sub）")).toHaveValue(
      identitySubject,
    );
  } finally {
    Object.assign(fixture.env, previous);
  }
});

test("NAS sees only site identity and an existing session works without an upstream provider", async ({
  page,
}) => {
  // Raw upstream subjects are rejected at NAS startup; use another valid site ID.
  expect(otherSiteSubject).not.toBe(identitySubject);
  await fixture.nas.administrators([otherSiteSubject]);
  await login(page);
  await expect(page.getByText("普通用户", { exact: true })).toBeVisible();
  await expect(page.locator(".account-advanced")).not.toHaveAttribute("open");
  await fixture.nas.administrators([identitySubject]);
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(
    page.getByText("管理员权限已启用", { exact: false }),
  ).toBeVisible();
  const previous = { ...fixture.env };
  delete fixture.env.OIDC_ISSUER_URL;
  fixture.env.SSO_SERVICE = {
    fetch() {
      throw new Error("Upstream identity must not be used");
    },
  };
  try {
    await page.reload();
    await expect(
      page.getByText("管理员权限已启用", { exact: false }),
    ).toBeVisible();
    const session = await page.evaluate(async () =>
      (await fetch("/api/auth/session")).json(),
    );
    expect(session.user).toMatchObject({
      issuer: fixture.origin,
      sub: identitySubject,
    });
    expect(JSON.stringify(session)).not.toContain("sso.example");
    expect(JSON.stringify(session)).not.toContain(upstreamSubject);

    const config = await (
      await fetch(fixture.nas.endpoint + "/api/account/config")
    ).json();
    expect(config).toMatchObject({ enabled: true, issuer: fixture.origin });
    expect(JSON.stringify(config)).not.toContain("sso.example");
    expect(JSON.stringify(config)).not.toContain(upstreamSubject);
  } finally {
    Object.assign(fixture.env, previous);
  }
});
