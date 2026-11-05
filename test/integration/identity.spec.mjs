import { test, expect } from "@playwright/test";
import { startFixture } from "./fixture.mjs";
import { identitySubject } from "./sso-fixture.mjs";

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
  await page.goto(fixture.origin + "/#/account");
  await page.getByRole("button", { name: "统一登录", exact: true }).click();
  const consent = page.getByRole("button", {
    name: "允许登录 LanternDock",
    exact: true,
  });
  await Promise.race([
    consent.waitFor({ timeout: 10000 }),
    page.getByLabel("用户标识（sub）").waitFor({ timeout: 10000 }),
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
    JSON.stringify([identitySubject]),
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
    JSON.stringify([identitySubject]),
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

test("administrator subjects are enforced on the NAS and apply to an existing login", async ({
  page,
}) => {
  await fixture.nas.administrators([]);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "尚未配置管理员", exact: true }),
  ).toBeVisible();
  await fixture.nas.administrators([identitySubject]);
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(
    page.getByText("管理员身份已生效", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "尚未配置管理员", exact: true }),
  ).toHaveCount(0);
  await fixture.nas.administrators(["some-other-user"]);
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
