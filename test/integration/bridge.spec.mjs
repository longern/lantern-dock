import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { parseLocalVariables } from "../../scripts/local-env.mjs";
import {
  deriveSecret,
  CERTIFICATE_WEBHOOK_PURPOSE,
} from "../../worker/secrets.js";
import {
  startFixture,
  gatewayToken,
  backendToken,
  textFile,
} from "./fixture.mjs";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      delete window.showSaveFilePicker;
    });
    await use(page);
    expect(errors).toEqual([]);
  },
});
let fixture;
test.beforeAll(async () => {
  test.setTimeout(180000);
  fixture = await startFixture();
});
test.afterAll(async () => {
  await fixture?.stop();
});

async function login(page, gateway = gatewayToken, backend = backendToken) {
  await page.getByRole("button", { name: "登录与连接设置" }).click();
  await page.getByLabel("后端访问令牌").fill(backend);
  await page.getByLabel("Bridge 网关令牌").fill(gateway);
  await page.getByRole("button", { name: "连接", exact: true }).click();
}

test("real bridge distinguishes gateway 407 and backend 401, then browses, previews and downloads", async ({
  page,
}, testInfo) => {
  await page.goto(fixture.origin);
  await expect(page.getByRole("alert")).toContainText("网关需要认证");
  await login(page, gatewayToken, "invalid-backend-token");
  await expect(page.getByRole("alert")).toContainText("后端需要登录");
  await login(page);
  await expect(page.locator(".file-card")).toHaveCount(5);
  await page
    .getByRole("button", { name: "预览 hello.txt", exact: true })
    .click();
  await expect(page.locator(".preview-content pre")).toHaveText(textFile);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载", exact: true }).click();
  const file = await downloaded;
  expect(await readFile(await file.path(), "utf8")).toBe(textFile);
  await page.getByRole("button", { name: "关闭预览" }).click();
  await page
    .getByRole("button", { name: "预览 coast.svg", exact: true })
    .click();
  await expect(page.locator(".file-details")).toContainText("1200 × 800");
  await page.screenshot({
    path: testInfo.outputPath("bridge-preview.png"),
    fullPage: false,
  });
  await page.getByRole("button", { name: "关闭预览" }).click();
  await page
    .getByRole("button", { name: "打开文件夹 照片", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "文件路径" }),
  ).toContainText("照片");
  await expect(page.locator(".file-card")).toHaveCount(5);
  await expect
    .poll(() =>
      fixture.requests.some(
        (request) => request.path === "/public/%E7%85%A7%E7%89%87/",
      ),
    )
    .toBe(true);
  expect(
    fixture.requests.every(
      (request) => !request.headers["proxy-authorization"],
    ),
  ).toBe(true);
  expect(
    fixture.requests.some(
      (request) =>
        request.method === "PROPFIND" &&
        request.headers.depth === "1" &&
        request.body.includes("propfind"),
    ),
  ).toBe(true);
});

test("same session handles chunked bodies, HEAD, Range, path limits and cancellation", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  const result = await page.evaluate(
    async ({ backendToken, gatewayToken }) => {
      const { DirectTransport } = await import("/__test/lib/transport.js");
      const config = await (await fetch("/api/config")).json();
      const transport = new DirectTransport(config.backend, {
        mode: "bearer",
        bearer: backendToken,
        gatewayToken,
      });
      try {
        const chunked = await transport.request("/public/chunked.txt");
        const text = await chunked.text();
        const head = await transport.request("/public/hello.txt", {
          method: "HEAD",
        });
        const range = await transport.request("/public/hello.txt", {
          headers: { Range: "bytes=0-10" },
        });
        const rangeText = await range.text();
        const denied = await transport.request("/private/hello.txt");
        await denied.body.cancel();
        const forbidden = await transport.request("/public/hello.txt", {
          method: "DELETE",
        });
        await forbidden.body.cancel();
        const controller = new AbortController();
        const slow = await transport.request("/public/slow.bin", {
          signal: controller.signal,
        });
        const reader = slow.body.getReader();
        const first = await reader.read();
        controller.abort();
        await reader.cancel().catch(() => {});
        return {
          text,
          headStatus: head.status,
          headBody: head.body,
          headLength: head.headers.get("Content-Length"),
          rangeStatus: range.status,
          rangeText,
          rangeHeader: range.headers.get("Content-Range"),
          denied: denied.status,
          forbidden: forbidden.status,
          received: first.value.length,
          session: !!transport.session,
        };
      } finally {
        transport.close();
      }
    },
    { backendToken, gatewayToken },
  );
  expect(result).toMatchObject({
    text: textFile,
    headStatus: 200,
    headBody: null,
    headLength: String(Buffer.byteLength(textFile)),
    rangeStatus: 206,
    rangeText: Buffer.from(textFile).subarray(0, 11).toString(),
    denied: 403,
    forbidden: 405,
    session: true,
  });
  expect(result.rangeHeader).toBe(`bytes 0-10/${Buffer.byteLength(textFile)}`);
  expect(result.received).toBeGreaterThan(0);
  await expect.poll(() => fixture.cancellations.length).toBeGreaterThan(0);
});

test("wrong certificate pin rejects a real WebTransport handshake", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  const accepted = await page.evaluate(async () => {
    const config = await (await fetch("/api/config")).json();
    const session = new WebTransport(config.backend.endpoint, {
      serverCertificateHashes: [
        { algorithm: "sha-256", value: new Uint8Array(32) },
      ],
    });
    session.closed.catch(() => {});
    try {
      await session.ready;
      return true;
    } catch {
      return false;
    } finally {
      session.close();
    }
  });
  expect(accepted).toBe(false);
});

test("download progress stays actionable inside a mobile preview and cancels the backend", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await expect(page.getByRole("alert")).toContainText("网关需要认证");
  await login(page);
  await expect(page.locator(".file-card")).toHaveCount(5);
  const before = fixture.cancellations.length;
  await page
    .getByRole("button", { name: "预览 slow.bin", exact: true })
    .click();
  await page.getByRole("button", { name: "下载", exact: true }).click();
  const progress = page.locator(".download-panel");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText(/KB|MB/);
  await page.getByRole("button", { name: "取消下载", exact: true }).click();
  await expect(progress).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveText("已取消下载");
  await expect.poll(() => fixture.cancellations.length).toBeGreaterThan(before);
});

test("first-run setup rechecks applied server settings and connects to the real bridge", async ({
  page,
}) => {
  const endpoint = fixture.env.BACKEND_ENDPOINT;
  try {
    fixture.env.BACKEND_ENDPOINT = "";
    await page.goto(fixture.origin);
    await expect(
      page.getByRole("heading", { name: "连接你的文件空间", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page
      .getByLabel("WebTransport 网关地址", { exact: true })
      .fill(endpoint);
    await page.getByRole("button", { name: "生成配置", exact: true }).click();
    // This simulates a maintainer applying environment variables outside the public UI.
    const variables = parseLocalVariables(
      await page
        .getByRole("textbox", { name: "生成的配置", exact: true })
        .inputValue(),
    );
    expect(variables.WEBTRANSPORT_URL).toBe(endpoint);
    expect(variables).not.toHaveProperty("BACKEND_TRANSPORT");
    Object.assign(fixture.env, variables);
    await page.getByRole("button", { name: "重新检测", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("网关需要认证");
    await login(page);
    await expect(page.locator(".file-card")).toHaveCount(5);
  } finally {
    delete fixture.env.WEBTRANSPORT_URL;
    delete fixture.env.WEBDAV_URL;
    fixture.env.BACKEND_ENDPOINT = endpoint;
  }
});

test("dashboard dotenv export provisions a new key and its derived certificate webhook", async ({
  page,
}) => {
  const previous = { ...fixture.env };
  try {
    delete fixture.env.SECRET_KEY;
    fixture.env.BACKEND_ENDPOINT = "";
    await page.goto(fixture.origin);
    await page
      .getByLabel("WebTransport 网关地址", { exact: true })
      .fill(previous.BACKEND_ENDPOINT);
    await page.getByRole("button", { name: "生成配置", exact: true }).click();
    await page
      .getByRole("button", { name: "Cloudflare Workers", exact: true })
      .click();
    await page.getByRole("button", { name: "显示密钥", exact: true }).click();
    const variables = parseLocalVariables(
      await page
        .getByRole("textbox", { name: "生成的配置", exact: true })
        .inputValue(),
    );
    expect(variables.SECRET_KEY).toMatch(/^[a-f0-9]{64}$/);
    // Apply outside the public UI, as a maintainer would in the dashboard.
    Object.assign(fixture.env, variables);
    const token = await deriveSecret(
      variables.SECRET_KEY,
      CERTIFICATE_WEBHOOK_PURPOSE,
    );
    const webhook = page.getByLabel("证书更新 Webhook URL", { exact: true });
    await expect(webhook).toHaveValue(
      `${fixture.origin}/api/certificates/${token}`,
    );
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.copiedWebhook = text;
          },
        },
      }),
    );
    await page
      .getByRole("button", { name: "复制 Webhook URL", exact: true })
      .click();
    const copiedUrl = await page.evaluate(() => window.copiedWebhook);
    const payload = JSON.parse(fixture.pins.get("certificate-pins"));
    fixture.pins.clear();
    const rejected = await page.request.put(
      `${fixture.origin}/api/certificates/${variables.SECRET_KEY}`,
      { data: payload },
    );
    expect(rejected.status()).toBe(404);
    const accepted = await page.request.put(copiedUrl, { data: payload });
    expect(accepted.status()).toBe(204);
    await page.getByRole("button", { name: "重新检测", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("网关需要认证");
    await login(page);
    await expect(page.locator(".file-card")).toHaveCount(5);
  } finally {
    for (const key of Object.keys(fixture.env)) delete fixture.env[key];
    Object.assign(fixture.env, previous);
  }
});

test("missing pins resume at certificate setup and publishing them enables the real bridge", async ({
  page,
}) => {
  const previous = new Map(fixture.pins);
  try {
    fixture.pins.clear();
    await page.goto(fixture.origin);
    await expect(
      page.getByRole("heading", { name: "配置网关证书", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "下一步", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "生成的配置", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel("已部署的 SECRET_KEY", { exact: true }),
    ).toHaveCount(0);
    // An existing deployment reuses the private URL saved at initialization.
    const token = await deriveSecret(
      fixture.env.SECRET_KEY,
      CERTIFICATE_WEBHOOK_PURPOSE,
    );
    const response = await page.request.put(
      `${fixture.origin}/api/certificates/${token}`,
      {
        data: JSON.parse(previous.get("certificate-pins")),
      },
    );
    expect(response.status()).toBe(204);
    await page.getByRole("button", { name: "重新检测", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("网关需要认证");
    await login(page);
    await expect(page.locator(".file-card")).toHaveCount(5);
  } finally {
    fixture.pins.clear();
    for (const [key, value] of previous) fixture.pins.set(key, value);
  }
});
