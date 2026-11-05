import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import worker from "../../worker/index.js";
import { parseLocalVariables } from "../../scripts/local-env.mjs";

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
      new Request(route.request().url()),
      typeof environment === "function" ? environment() : environment,
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
}
async function next(page) {
  await page.getByRole("button", { name: "下一步", exact: true }).click();
}
async function generate(page) {
  await page.getByRole("button", { name: "生成配置", exact: true }).click();
}

test("default setup exports one WebDAV URL and the advanced controls stay optional", async ({
  page,
}) => {
  await serveConfiguration(page, {});
  await page.goto("/");
  await next(page);
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
  expect(vars).toEqual({ WEBDAV_URL: "https://files.example.com/dav/public/" });
  await expect(page.locator(".setup-checklist")).toContainText("CORS");
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
  await page
    .getByRole("button", { name: /WebTransport.*需要部署网关/ })
    .click();
  await next(page);
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
  await expect(page.locator(".file-card")).toHaveCount(0);
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
  await expect(page.locator(".file-card")).toHaveCount(12);
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
  await serveConfiguration(page, () =>
    configured ? { DEMO_MODE: "true" } : {},
  );
  await page.goto("/");
  await next(page);
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
  const local = await code.inputValue();
  expect(parseLocalVariables(local)).toMatchObject({
    BACKEND_NAME: name,
    WEBDAV_URL: "https://files.example.com/dav/%E7%85%A7%E7%89%87/",
    BACKEND_AUTH: "basic",
  });
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载配置", exact: true }).click();
  expect(await readFile(await (await downloaded).path(), "utf8")).toBe(local);
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
  expect(
    await code.evaluate((node) => node.selectionEnd - node.selectionStart),
  ).toBe(local.length);
  await page
    .getByRole("button", { name: "Cloudflare Workers", exact: true })
    .click();
  expect(JSON.parse(await code.inputValue()).vars.BACKEND_NAME).toBe(name);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("setup-config.png"),
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "已完成，重新检测", exact: true })
    .click();
  await expect(
    page.getByText("尚未检测到有效后端配置。", { exact: false }),
  ).toBeVisible();
  expect(JSON.parse(await code.inputValue()).vars.BACKEND_NAME).toBe(name);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    name,
  );
  configured = true;
  await page
    .getByRole("button", { name: "已完成，重新检测", exact: true })
    .click();
  await expect(page.locator(".file-card")).toHaveCount(12);
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
    GATEWAY_AUTH: "true",
  });
  await page.goto("/");
  await expect(
    page.getByText("网关地址已配置，接下来准备连接证书。"),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await next(page);
  await expect(
    page.getByLabel("WebTransport 网关地址", { exact: true }),
  ).toHaveValue("https://bridge.example.com:4433/webtransport");
  await page.getByText("高级设置", { exact: true }).click();
  await expect(page.getByLabel("网关要求访问令牌")).toBeChecked();
  await generate(page);
  await expect(page.locator(".setup-checklist")).toContainText(
    "CERTIFICATES_JSON",
  );
  await page
    .getByRole("button", { name: "Cloudflare Workers", exact: true })
    .click();
  await expect(page.locator(".setup-checklist")).toContainText("PINS");
  await expect(page.locator(".setup-checklist")).toContainText("PROPFIND");
});

test("wizard validates mount paths without saving or attempting a backend connection", async ({
  page,
}) => {
  await serveConfiguration(page, {});
  await page.goto("/");
  await next(page);
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
