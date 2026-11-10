import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import worker from "../../worker/index.js";
import { parseLocalVariables } from "../../scripts/local-env.mjs";
import { certificateWebhookUrl } from "../../shared/site-secret.js";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
});

async function serveConfiguration(page, environment) {
  await page.route("**/api/config", async (route) => {
    const response = await worker.fetch(
      new Request(route.request().url(), {
        headers: route.request().headers(),
      }),
      typeof environment === "function" ? environment() : environment,
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
}
async function generate(page) {
  await page.getByRole("button", { name: "生成配置", exact: true }).click();
}

test("default setup exports one WebDAV URL plus a new masked deployment key", async ({
  page,
}) => {
  await serveConfiguration(page, {});
  await page.goto("/");
  await expect(page.getByLabel("资源名称", { exact: true })).not.toBeVisible();
  await page
    .getByLabel("WebDAV 服务地址", { exact: true })
    .fill("https://files.example.com/dav/public/");
  await generate(page);
  const vars = parseLocalVariables(
    await page
      .getByRole("textbox", { name: "生成的配置", exact: true })
      .inputValue(),
  );
  expect(vars).toEqual({
    WEBDAV_URL: "https://files.example.com/dav/public/",
    SECRET_KEY: "•".repeat(32),
  });
  await expect(page.locator(".setup-checklist")).toContainText("CORS");
  await expect(
    page.getByRole("region", { name: "证书更新 Webhook", exact: true }),
  ).toHaveCount(0);
});

test("new deployment webhook URLs are derived locally and copy the complete URL", async ({
  page,
}, testInfo) => {
  const requests = [];
  page.on("request", (request) =>
    requests.push(request.url() + (request.postData() || "")),
  );
  await serveConfiguration(page, {
    WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "保存并部署", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "显示密钥", exact: true }).click();
  const key = parseLocalVariables(
    await page
      .getByRole("textbox", { name: "生成的配置", exact: true })
      .inputValue(),
  ).SECRET_KEY;
  await page.getByRole("button", { name: "隐藏密钥", exact: true }).click();
  const address = page.getByLabel("LanternDock 部署地址", { exact: true });
  const output = page.getByLabel("证书更新 Webhook URL", { exact: true });
  const copy = page.getByRole("button", {
    name: "复制 Webhook URL",
    exact: true,
  });
  await expect(copy).toBeDisabled();
  await address.fill("https://dock.example.com");
  const expected = await certificateWebhookUrl(key, "https://dock.example.com");
  await expect(output).toHaveValue(expected);
  await expect(output).toHaveAttribute("type", "password");
  await expect(
    page.getByRole("region", { name: "证书更新 Webhook", exact: true }),
  ).toBeVisible();
  const downloadedSite = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载配置", exact: true }).click();
  expect(
    parseLocalVariables(
      await readFile(await (await downloadedSite).path(), "utf8"),
    ).SECRET_KEY,
  ).toBe(key);
  const downloadedBridge = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 bridge.env", exact: true })
    .click();
  const bridgeFile = await downloadedBridge;
  expect(bridgeFile.suggestedFilename()).toBe("bridge.env");
  expect(
    parseLocalVariables(await readFile(await bridgeFile.path(), "utf8")),
  ).toEqual({ CERT_WEBHOOK_URL: expected });
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
  await copy.click();
  expect(await page.evaluate(() => window.copiedWebhook)).toBe(expected);
  expect(expected).not.toContain(key);
  await address.fill("https://user:password@dock.example.com");
  await expect(output).toHaveValue("");
  await expect(copy).toBeDisabled();
  await address.fill("https://other.example.com");
  await expect(output).toHaveValue(
    await certificateWebhookUrl(key, "https://other.example.com"),
  );
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    }),
  );
  await copy.click();
  await expect(
    page.getByText("请复制已选中的 Webhook URL。", { exact: true }),
  ).toBeVisible();
  await expect(output).toHaveAttribute("type", "text");
  await expect
    .poll(() =>
      output.evaluate((node) => node.selectionEnd - node.selectionStart),
    )
    .toBe((await output.inputValue()).length);
  await page
    .getByRole("button", { name: "隐藏 Webhook URL", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("region", { name: "证书更新 Webhook", exact: true })
    .screenshot({ path: testInfo.outputPath("certificate-webhook.png") });
  expect(requests.join("\n")).not.toContain(key);
  expect(requests.join("\n")).not.toContain("/api/certificates/");
  expect(
    await page.evaluate(() => JSON.stringify({ localStorage, sessionStorage })),
  ).not.toContain(key);
});

test("an existing deployment keeps its key and offers saved URL recovery without a secret input", async ({
  page,
}) => {
  const existing = "saved-existing-site-key-".repeat(4);
  const requests = [];
  page.on("request", (request) =>
    requests.push(request.url() + (request.postData() || "")),
  );
  await serveConfiguration(page, {
    WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
    SECRET_KEY: existing,
  });
  await page.goto("/");
  await expect(
    page.getByLabel("已部署的 SECRET_KEY", { exact: true }),
  ).toHaveCount(0);
  const webhook = page.getByRole("region", {
    name: "证书更新 Webhook",
    exact: true,
  });
  await expect(webhook).toContainText("首次生成密钥时一并保存的 Webhook URL");
  await webhook.getByText("使用已有密钥重新计算 URL", { exact: true }).click();
  await expect(webhook).toContainText("npm run webhook --");
  await expect(
    page.getByRole("textbox", { name: "生成的配置", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "部署环境", exact: true }),
  ).toHaveCount(0);
  expect(await page.content()).not.toContain(existing);
  expect(requests.join("\n")).not.toContain(existing);
  expect(
    await page.evaluate(() => JSON.stringify({ localStorage, sessionStorage })),
  ).not.toContain(existing);
});

test("choosing one URL clears the other configured URL explicitly", async ({
  page,
}) => {
  await serveConfiguration(page, {
    WEBDAV_URL: "https://files.example.com/dav/",
    WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
  });
  await page.goto("/");
  await expect(
    page.getByText("检测到两种连接地址，请选择保留其中一种。"),
  ).toBeVisible();
  await page.getByRole("button", { name: /WebTransport.*通过 bridge/ }).click();
  await page
    .getByLabel("WebTransport 网关地址", { exact: true })
    .fill("https://bridge.example.com/webtransport");
  await generate(page);
  expect(
    parseLocalVariables(
      await page
        .getByRole("textbox", { name: "生成的配置", exact: true })
        .inputValue(),
    ),
  ).toEqual({
    WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
    WEBDAV_URL: "",
    SECRET_KEY: "•".repeat(32),
  });
  await expect(page.locator(".setup-checklist")).toContainText(
    "CERTIFICATES_JSON",
  );
});

test("missing configuration opens a responsive wizard and demo is an explicit temporary choice", async ({
  page,
}, testInfo) => {
  let count = 0;
  await serveConfiguration(page, () => {
    count++;
    return {};
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "连接你的文件空间", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".file-item")).toHaveCount(0);
  if (page.viewportSize().height >= 844)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("setup-welcome.png"),
    fullPage: false,
  });
  const before = count;
  await page.getByRole("button", { name: "先体验演示", exact: true }).click();
  await expect(page.locator(".file-item")).toHaveCount(12);
  expect(count).toBe(before);
  await page.getByRole("button", { name: "返回配置向导", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "连接你的文件空间", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "连接你的文件空间", exact: true }),
  ).toBeVisible();
});

test("wizard exports real configuration, keeps form values on retry, and detects applied settings", async ({
  page,
}, testInfo) => {
  let configured = false;
  const requests = [];
  page.on("request", (request) =>
    requests.push(request.url() + (request.postData() || "")),
  );
  await serveConfiguration(page, () =>
    configured ? { DEMO_MODE: "true" } : {},
  );
  await page.goto("/");
  const name = `My "files" 'box' \\ home`;
  await page.getByText("高级设置", { exact: true }).click();
  await page.getByLabel("资源名称", { exact: true }).fill(name);
  await page
    .getByLabel("WebDAV 服务地址", { exact: true })
    .fill("https://files.example.com");
  await page.getByLabel("WebDAV 根目录", { exact: true }).fill("/dav/照片");
  await page.getByLabel("后端认证", { exact: true }).selectOption("basic");
  await generate(page);
  const code = page.getByRole("textbox", { name: "生成的配置", exact: true });
  expect(await code.inputValue()).toContain("•".repeat(32));
  await page.getByRole("button", { name: "显示密钥", exact: true }).click();
  const local = await code.inputValue();
  const key = parseLocalVariables(local).SECRET_KEY;
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(parseLocalVariables(local)).toMatchObject({
    BACKEND_NAME: name,
    WEBDAV_URL: "https://files.example.com/dav/%E7%85%A7%E7%89%87/",
    BACKEND_AUTH: "basic",
  });
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedSetup = text;
        },
      },
    }),
  );
  await page.getByRole("button", { name: "隐藏密钥", exact: true }).click();
  await page.getByRole("button", { name: "复制配置", exact: true }).click();
  expect(await page.evaluate(() => window.copiedSetup)).toBe(local);
  expect(await code.inputValue()).not.toContain(key);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载配置", exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("lantern-dock.env");
  expect(await readFile(await file.path(), "utf8")).toBe(local);
  expect(await code.inputValue()).not.toContain(key);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    }),
  );
  await page.getByRole("button", { name: "复制配置", exact: true }).click();
  await expect(page.getByText("请复制已选中的配置文本。")).toBeVisible();
  await expect
    .poll(() =>
      code.evaluate((node) => node.selectionEnd - node.selectionStart),
    )
    .toBe(local.length);
  await page
    .getByRole("button", { name: "Cloudflare Workers", exact: true })
    .click();
  expect(await code.inputValue()).toBe(local);
  await expect(page.locator(".setup-instructions")).toContainText("手动勾选");
  await expect(page.locator(".setup-instructions")).toContainText("Secret");
  await page.getByText("其他部署方式", { exact: true }).click();
  const wrangler = page.getByRole("textbox", {
    name: "Wrangler 配置",
    exact: true,
  });
  expect(JSON.parse(await wrangler.inputValue()).vars.BACKEND_NAME).toBe(name);
  expect(await wrangler.inputValue()).not.toContain("SECRET_KEY");
  await page.getByText("其他部署方式", { exact: true }).click();
  await page
    .getByRole("button", { name: "Cloudflare Workers", exact: true })
    .click();
  await page.getByRole("button", { name: "隐藏密钥", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("setup-config.png"),
    fullPage: false,
  });
  await page.getByRole("button", { name: "本地开发", exact: true }).click();
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(
    page.getByText("尚未检测到有效后端配置", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "显示密钥", exact: true }).click();
  expect(await code.inputValue()).toBe(local);
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  await generate(page);
  await page.getByRole("button", { name: "显示密钥", exact: true }).click();
  expect(await code.inputValue()).toBe(local);
  const storage = await page.evaluate(() =>
    JSON.stringify({ localStorage, sessionStorage }),
  );
  expect(storage).not.toContain(name);
  expect(storage).not.toContain(key);
  expect(requests.join("\n")).not.toContain(key);
  configured = true;
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(page.locator(".file-item")).toHaveCount(12);
  await expect(
    page.getByRole("heading", { name: "连接你的文件空间", exact: true }),
  ).toHaveCount(0);
});

test("missing certificate guidance retains the WebTransport settings", async ({
  page,
}) => {
  await serveConfiguration(page, {
    BACKEND_TRANSPORT: "webtransport",
    BACKEND_ENDPOINT: "https://bridge.example.com:4433/webtransport",
    BACKEND_ROOT: "/public/",
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "保存并部署", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "保存并部署", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "下一步", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".setup-steps .current")).toContainText(
    "保存并部署",
  );
  await expect(page.locator(".setup-checklist")).toContainText(
    "CERTIFICATES_JSON",
  );
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(
    page.getByText("尚未检测到有效网关证书", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "保存并部署", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  await expect(
    page.getByLabel("WebTransport 网关地址", { exact: true }),
  ).toHaveValue("https://bridge.example.com:4433/webtransport");
  await page.getByText("高级设置", { exact: true }).click();
  await expect(page.getByLabel("网关要求访问令牌")).toHaveCount(0);
  await generate(page);
  await expect(page.locator(".setup-checklist")).toContainText(
    "CERTIFICATES_JSON",
  );
  await page
    .getByRole("button", { name: "Cloudflare Workers", exact: true })
    .click();
  await expect(page.locator(".setup-checklist")).toContainText("KV");
  await expect(page.locator(".setup-checklist")).toContainText("PROPFIND");
});

test("wizard validates mount paths without saving or attempting a backend connection", async ({
  page,
}) => {
  await serveConfiguration(page, {});
  await page.goto("/");
  await page
    .getByLabel("WebDAV 服务地址", { exact: true })
    .fill("https://user:secret@files.example.com/dav/");
  await generate(page);
  await expect(page.getByRole("alert")).toContainText("账号和令牌");
  await expect(
    page.getByRole("textbox", { name: "生成的配置", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("WebDAV 服务地址", { exact: true })
    .fill("https://files.example.com");
  await page.getByText("高级设置", { exact: true }).click();
  await page.getByLabel("WebDAV 根目录", { exact: true }).fill("/../private/");
  await generate(page);
  await expect(page.getByRole("alert")).toContainText("根目录");
});

test("existing server key stays private and is preserved unless generating for a new deployment", async ({
  page,
}) => {
  const existing = "existing-site-secret-".repeat(4);
  await serveConfiguration(page, { SECRET_KEY: existing });
  await page.goto("/");
  await page
    .getByLabel("WebDAV 服务地址", { exact: true })
    .fill("https://files.example.com/dav/");
  await generate(page);
  const code = page.getByRole("textbox", { name: "生成的配置", exact: true });
  await expect(
    page.getByText("保留站点现有的 SECRET_KEY", { exact: false }),
  ).toBeVisible();
  expect(await code.inputValue()).not.toContain("SECRET_KEY");
  expect(await page.content()).not.toContain(existing);
  await page.getByText("其他部署方式", { exact: true }).click();
  await page
    .getByRole("button", { name: "为新部署生成密钥", exact: true })
    .click();
  expect(await code.inputValue()).toContain("•".repeat(32));
  await page.getByRole("button", { name: "显示密钥", exact: true }).click();
  const key = parseLocalVariables(await code.inputValue()).SECRET_KEY;
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(key).not.toBe(existing);
});

test("local site key does not suppress generation for a new Cloudflare deployment", async ({
  page,
}) => {
  const existing = "local-only-site-key-".repeat(4);
  await serveConfiguration(page, { SECRET_KEY: existing });
  await page.goto("/");
  await page
    .getByLabel("WebDAV 服务地址", { exact: true })
    .fill("https://files.example.com/dav/");
  await generate(page);
  const code = page.getByRole("textbox", { name: "生成的配置", exact: true });
  expect(await code.inputValue()).not.toContain("SECRET_KEY");
  await page
    .getByRole("button", { name: "Cloudflare Workers", exact: true })
    .click();
  expect(await code.inputValue()).toContain('SECRET_KEY="' + "•".repeat(32));
  await page.getByRole("button", { name: "显示密钥", exact: true }).click();
  const key = parseLocalVariables(await code.inputValue()).SECRET_KEY;
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(key).not.toBe(existing);
  await page.getByRole("button", { name: "本地开发", exact: true }).click();
  expect(await code.inputValue()).not.toContain("SECRET_KEY");
  await page
    .getByRole("button", { name: "Cloudflare Workers", exact: true })
    .click();
  expect(parseLocalVariables(await code.inputValue()).SECRET_KEY).toBe(key);
  expect(await page.content()).not.toContain(existing);
});

test("applied WebTransport settings advance a first-run wizard directly to certificate setup", async ({
  page,
}) => {
  let environment = {};
  await serveConfiguration(page, () => environment);
  await page.goto("/");
  await page
    .getByLabel("WebDAV 服务地址", { exact: true })
    .fill("https://files.example.com/dav/");
  await generate(page);
  environment = {
    WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
    BACKEND_ROOT: "/public/",
    SECRET_KEY: "configured-site-key-".repeat(4),
  };
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "配置网关证书", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".setup-connection-summary")).toContainText(
    environment.WEBTRANSPORT_URL,
  );
  await expect(
    page.getByRole("textbox", { name: "生成的配置", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "修改连接", exact: true }).click();
  await expect(
    page.getByLabel("WebTransport 网关地址", { exact: true }),
  ).toHaveValue(environment.WEBTRANSPORT_URL);
});

test("an existing deployed Worker key is preserved across export target switches", async ({
  page,
}) => {
  await page.route("https://lantern-dock.example/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({
        url: `http://127.0.0.1:8788${url.pathname}${url.search}`,
      }),
    });
  });
  const existing = "deployed-worker-site-key-".repeat(4);
  await serveConfiguration(page, { SECRET_KEY: existing });
  await page.goto("https://lantern-dock.example/");
  await page
    .getByLabel("WebDAV 服务地址", { exact: true })
    .fill("https://files.example.com/dav/");
  await generate(page);
  const code = page.getByRole("textbox", { name: "生成的配置", exact: true });
  await expect(
    page.getByRole("button", { name: "Cloudflare Workers", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await code.inputValue()).not.toContain("SECRET_KEY");
  await page.getByText("其他部署方式", { exact: true }).click();
  await page
    .getByRole("button", { name: "Cloudflare Workers", exact: true })
    .click();
  expect(await code.inputValue()).not.toContain("SECRET_KEY");
  expect(await page.content()).not.toContain(existing);
});

test("generated key and webhook stay paired across editing and lead to a focused certificate screen", async ({
  page,
}, testInfo) => {
  let environment = {};
  await serveConfiguration(page, () => environment);
  await page.goto("/");
  await page.getByRole("button", { name: /WebTransport.*通过 bridge/ }).click();
  await page
    .getByLabel("WebTransport 网关地址", { exact: true })
    .fill("https://bridge.example.com/webtransport");
  await generate(page);
  await page.getByRole("button", { name: "显示密钥", exact: true }).click();
  const variables = parseLocalVariables(
    await page
      .getByRole("textbox", { name: "生成的配置", exact: true })
      .inputValue(),
  );
  await page.getByRole("button", { name: "隐藏密钥", exact: true }).click();
  await page
    .getByLabel("LanternDock 部署地址", { exact: true })
    .fill("https://dock.example.com");
  const webhook = page.getByLabel("证书更新 Webhook URL", { exact: true });
  const expected = await certificateWebhookUrl(
    variables.SECRET_KEY,
    "https://dock.example.com",
  );
  await expect(webhook).toHaveValue(expected);
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  await generate(page);
  await expect(webhook).toHaveValue(expected);
  await page.getByRole("button", { name: "显示密钥", exact: true }).click();
  expect(
    parseLocalVariables(
      await page
        .getByRole("textbox", { name: "生成的配置", exact: true })
        .inputValue(),
    ).SECRET_KEY,
  ).toBe(variables.SECRET_KEY);
  environment = variables;
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "配置网关证书", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "生成的配置", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "部署环境", exact: true }),
  ).toHaveCount(0);
  await expect(webhook).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "为新部署生成密钥", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("setup-certificates.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "修改连接", exact: true }).click();
  await generate(page);
  expect(
    await page
      .getByRole("textbox", { name: "生成的配置", exact: true })
      .inputValue(),
  ).not.toContain("SECRET_KEY");
});

test("a new Worker deployment opens its destination instead of rechecking localhost", async ({
  page,
}) => {
  let count = 0;
  await serveConfiguration(page, () => {
    count++;
    return {};
  });
  await page.goto("/");
  await page
    .getByLabel("WebDAV 服务地址", { exact: true })
    .fill("https://files.example.com/dav/");
  await generate(page);
  const before = count;
  await page
    .getByRole("button", { name: "Cloudflare Workers", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "重新检测", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "打开已部署站点", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("LanternDock 部署地址", { exact: true })
    .fill("https://dock.example.com");
  const destination = page.getByRole("link", {
    name: "打开已部署站点",
    exact: false,
  });
  await expect(destination).toHaveAttribute("href", "https://dock.example.com");
  expect(count).toBe(before);
});

test("certificate setup distinguishes a namespace name from an attached KV binding", async ({
  page,
}) => {
  await page.route("https://dock.example/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({
        url: `http://127.0.0.1:8788${url.pathname}${url.search}`,
      }),
    });
  });
  const env = {
    WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
    SECRET_KEY: "diagnostic-site-key-".repeat(4),
  };
  await serveConfiguration(page, () => env);
  await page.goto("https://dock.example/");
  await expect(
    page.getByText("未检测到 KV 绑定。", { exact: false }),
  ).toBeVisible();
  env.KV = { get: async () => null, put: async () => {} };
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(
    page.getByText("未检测到 KV 绑定。", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText("KV 存储已连接。", { exact: true }),
  ).toBeVisible();
});
