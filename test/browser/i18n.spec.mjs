import { isCompact } from "../helpers/responsive.mjs";
import { openItem } from "../helpers/open-item.mjs";
import { favoriteItem } from "../helpers/favorite-item.mjs";
import { test, expect } from "@playwright/test";
import { closeFavorites, openFavorites } from "../helpers/navigation.mjs";

const labels = {
  en: {
    home: "Home",
    files: /^Files/,
    favorites: /^Favorites/,
    navigation: "Resource navigation",
    mobileNavigation: "Mobile resource navigation",
    search: "Search files",
    categories: "File categories",
    categoryNames: ["Albums", "Videos", "Documents", "Books", "Audio"],
    documents: "Documents",
    path: "File path",
    clearSearch: "Clear search",
    settings: "Connection settings",
    closeSettings: "Close settings",
    me: "Me",
    authentication: "Authentication",
    basic: "Username and password (Basic)",
    username: "Username",
    count: "12 items",
    emptyCount: "0 items",
    title: "LanternDock · Public file portal",
    description:
      "A visitor portal for self-hosted files. Connect directly over HTTPS or WebTransport to browse, preview and download files.",
  },
  "zh-CN": {
    home: "首页",
    files: /^文件/,
    favorites: /^收藏/,
    navigation: "资源导航",
    mobileNavigation: "移动端资源导航",
    search: "搜索文件",
    categories: "文件分类",
    categoryNames: ["相册", "视频", "文档", "图书", "音频"],
    documents: "文档",
    path: "文件路径",
    clearSearch: "清除搜索",
    settings: "连接设置",
    closeSettings: "关闭设置",
    me: "我的",
    authentication: "访问方式",
    basic: "用户名与密码（Basic）",
    username: "用户名",
    count: "12 个项目",
    emptyCount: "0 个项目",
    title: "LanternDock · 公开资源门户",
    description:
      "自托管资源的访客入口。通过 HTTPS 或 WebTransport 直连后端，浏览、预览和下载文件。",
  },
};

// Explicit contexts keep these cases independent of the suite's Chinese default
// while retaining every project's desktop, tablet, and mobile configuration.
async function withLocale(browser, testInfo, options, run) {
  const project = testInfo.project.use;
  const context = await browser.newContext({
    baseURL: project.baseURL,
    viewport: project.viewport,
    isMobile: project.isMobile,
    hasTouch: project.hasTouch,
    locale: options.locale,
    timezoneId: "UTC",
  });
  try {
    if (options.languages !== undefined) {
      await context.addInitScript(
        ({ languages, language }) => {
          Object.defineProperty(navigator, "languages", {
            get: () => languages,
          });
          Object.defineProperty(navigator, "language", { get: () => language });
        },
        {
          languages: options.languages,
          language: options.language || options.locale,
        },
      );
    }
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await run(page, new URL(project.baseURL).origin);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

function backend(origin, transport = "demo") {
  return {
    name: "Fixture library",
    transport,
    endpoint: transport === "demo" ? "" : origin,
    rootPath: transport === "demo" ? "/" : "/dav/",
    auth: "none",
    gatewayAuth: false,
    certificates: [],
  };
}

const mainNavigation = (page, copy) =>
  page.getByRole("navigation", {
    name: isCompact(page) ? copy.mobileNavigation : copy.navigation,
    exact: true,
  });

async function expectMetadata(page, language) {
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await expect(page).toHaveTitle(labels[language].title);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    labels[language].description,
  );
}

async function expectNoLanguageSwitch(page) {
  await expect(
    page.getByRole("combobox", { name: /language|语言/i, includeHidden: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /^(?:English|中文|简体中文|Language|语言|切换语言)$/i,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.locator('select option[value="en"], select option[value="zh-CN"]'),
  ).toHaveCount(0);
}

for (const { locale, expected } of [
  { locale: "zh-CN", expected: "zh-CN" },
  { locale: "en-US", expected: "en" },
  { locale: "fr-FR", expected: "en" },
]) {
  test(`${locale} localizes Home, categories, metadata and mobile Files search`, async ({
    browser,
  }, testInfo) => {
    await withLocale(browser, testInfo, { locale }, async (page, origin) => {
      const copy = labels[expected];
      await page.route("**/api/config", (route) =>
        route.fulfill({ json: { backend: backend(origin) } }),
      );
      await page.goto("/");
      await expect(page.locator(".file-item")).toHaveCount(12);
      await expectMetadata(page, expected);
      const nav = mainNavigation(page, copy);
      const home = nav.getByRole("button", { name: copy.home, exact: true });
      await expect(home).toHaveAttribute("aria-current", "page");
      await expect(page.locator("#item-count")).toHaveCount(0);
      const categories = page.getByRole("navigation", {
        name: copy.categories,
        exact: true,
      });
      await expect(categories.getByRole("button")).toHaveText(
        copy.categoryNames,
      );
      await expectNoLanguageSwitch(page);

      const search = page.getByRole("searchbox", {
        name: copy.search,
        exact: true,
      });
      await home.focus();
      await page.keyboard.press("/");
      await expect(search).toBeFocused();
      await search.fill("no-matching-i18n-file");
      await expect(page.locator("#item-count")).toHaveCount(0);
      await page
        .getByRole("button", { name: copy.clearSearch, exact: true })
        .first()
        .click();
      await expect(search).toHaveValue("");
      await expect(search).toBeFocused();
      await categories
        .getByRole("button", { name: copy.documents, exact: true })
        .click();
      await expect(page.locator(".file-item")).toHaveCount(4);
      await expect(
        page.getByRole("searchbox", { includeHidden: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("navigation", { name: copy.path, exact: true }),
      ).toBeVisible();
      await home.click();
      await expect(search).toHaveValue("");
      await expect(page.locator(".file-item")).toHaveCount(12);

      for (const mode of ["files", "favorites"]) {
        await search.fill("no-matching-i18n-file");
        const destination =
          mode === "favorites"
            ? await openFavorites(page, expected)
            : nav.getByRole("button", { name: copy.files });
        if (mode === "files") await destination.click();
        await destination.focus();
        await page.keyboard.press("/");
        if (mode === "favorites") await expect(page).toHaveURL(/\/favorites$/);
        else await expect(destination).toHaveAttribute("aria-current", "page");
        await expect(destination).toBeFocused();
        await expect(
          page.getByRole("searchbox", { includeHidden: true }),
        ).toHaveCount(0);
        await expect(page.locator(".category-cards")).toHaveCount(0);
        if (mode === "files" && isCompact(page)) {
          await expect(page.locator(".topbar .mobile-brand")).toHaveText(
            copy.files,
          );
          await page
            .locator(".topbar")
            .getByRole("button", { name: copy.search, exact: true })
            .tap();
          await expect(search).toBeFocused();
          await expect(search).toHaveAttribute("placeholder", copy.search);
        }
        if (mode === "favorites") await closeFavorites(page, expected);
        await home.click();
        await expect(search).toHaveValue("");
      }
    });
  });
}

for (const scenario of [
  {
    name: "English before Chinese",
    locale: "zh-CN",
    languages: ["en-US", "zh-CN"],
    expected: "en",
  },
  {
    name: "Chinese regional variant before English",
    locale: "en-US",
    languages: ["zh-Hant-TW", "en-US"],
    expected: "zh-CN",
  },
  {
    name: "unsupported preference before Chinese",
    locale: "en-US",
    languages: ["fr-FR", "zh-CN", "en-US"],
    expected: "zh-CN",
  },
  {
    name: "unsupported preferences fall back to English",
    locale: "zh-CN",
    languages: ["fr-FR", "de-DE"],
    expected: "en",
  },
  {
    name: "empty preferences fall back to navigator.language",
    locale: "en-US",
    languages: [],
    language: "zh-HK",
    expected: "zh-CN",
  },
]) {
  test(`browser language priority: ${scenario.name}`, async ({
    browser,
  }, testInfo) => {
    await withLocale(browser, testInfo, scenario, async (page, origin) => {
      await page.route("**/api/config", (route) =>
        route.fulfill({ json: { backend: backend(origin) } }),
      );
      await page.goto("/");
      await expect(page.locator(".file-item")).toHaveCount(12);
      await expectMetadata(page, scenario.expected);
      const copy = labels[scenario.expected];
      await expect(
        mainNavigation(page, copy).getByRole("button", {
          name: copy.home,
          exact: true,
        }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        page.getByRole("searchbox", { name: copy.search, exact: true }),
      ).toBeVisible();
    });
  });
}

for (const locale of ["en-US", "zh-CN"]) {
  test(`${locale} settings close and Escape restore focus with translated labels`, async ({
    browser,
  }, testInfo) => {
    await withLocale(browser, testInfo, { locale }, async (page, origin) => {
      const copy = labels[locale === "zh-CN" ? "zh-CN" : "en"];
      await page.route("**/api/config", (route) =>
        route.fulfill({ json: { backend: backend(origin) } }),
      );
      await page.goto("/");
      await expect(page.locator(".file-item")).toHaveCount(12);
      const mobile = isCompact(page);
      for (const dismiss of ["button", "escape"]) {
        if (mobile)
          await mainNavigation(page, copy)
            .getByRole("button", { name: copy.me, exact: true })
            .click();
        await page
          .locator(mobile ? "#my-settings" : "#connection-settings")
          .click();
        const dialog = page.getByRole("dialog", {
          name: copy.settings,
          exact: true,
        });
        await expect(dialog).toBeVisible();
        if (mobile) await expect(page.locator("#sidebar")).toHaveCount(0);
        const authentication = dialog.getByLabel(copy.authentication, {
          exact: true,
        });
        await expect(authentication).toHaveValue("none");
        await authentication.selectOption({ label: copy.basic });
        await dialog
          .getByLabel(copy.username, { exact: true })
          .fill("unsaved-locale-user");
        await expectNoLanguageSwitch(page);
        if (dismiss === "button")
          await dialog
            .getByRole("button", { name: copy.closeSettings, exact: true })
            .click();
        else await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(
          page.locator(mobile ? "#my-settings" : "#connection-settings"),
        ).toBeFocused();
      }
    });
  });
}

test("English account entry and recheck remain local and translated", async ({
  browser,
}, testInfo) => {
  await withLocale(
    browser,
    testInfo,
    { locale: "en-US" },
    async (page, origin) => {
      let sessionChecks = 0;
      await page.route("**/api/config", (route) =>
        route.fulfill({ json: { backend: backend(origin) } }),
      );
      await page.route("**/api/auth/session", (route) => {
        sessionChecks++;
        return route.fulfill({ json: { authenticated: false } });
      });
      await page.goto("/account");
      await expect(
        page.getByRole("heading", {
          name: "Sign in to your account",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Browse public files without signing in. Sign in to view your account details.",
          { exact: true },
        ),
      ).toBeVisible();
      await expectMetadata(page, "en");
      await expectNoLanguageSwitch(page);
      await page
        .getByRole("button", { name: "Check again", exact: true })
        .click();
      await expect.poll(() => sessionChecks).toBe(2);
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Back to public files", exact: true })
        .click();
      await expect(
        page.getByRole("searchbox", { name: "Search files", exact: true }),
      ).toBeVisible();
    },
  );
});

test("English setup export, demo and return labels survive navigation", async ({
  browser,
}, testInfo) => {
  await withLocale(
    browser,
    testInfo,
    { locale: "en-US" },
    async (page, origin) => {
      await page.route("**/api/config", (route) =>
        route.fulfill({
          json: {
            setupRequired: true,
            setup: {
              reason: "missing-backend",
              hasSecretKey: false,
              hasKV: false,
            },
          },
        }),
      );
      await page.goto("/");
      await expect(
        page.getByRole("heading", {
          name: "Connect your file space",
          exact: true,
        }),
      ).toBeVisible();
      await expectMetadata(page, "en");
      await expectNoLanguageSwitch(page);
      await page
        .getByLabel("WebDAV service address", { exact: true })
        .fill(`${origin}/dav/`);
      await page
        .getByRole("button", { name: "Generate configuration", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Save and deploy", exact: true }),
      ).toBeVisible();
      expect(
        await page
          .getByRole("textbox", {
            name: "Generated configuration",
            exact: true,
          })
          .inputValue(),
      ).toContain(`WEBDAV_URL="${origin}/dav/"`);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(
        page.getByLabel("WebDAV service address", { exact: true }),
      ).toHaveValue(`${origin}/dav/`);
      await page
        .getByRole("button", { name: "Try the demo", exact: true })
        .click();
      await expect(page.locator(".file-item")).toHaveCount(12);
      await expect(
        page.getByText("You are exploring demo files", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Back to setup", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Connect your file space",
          exact: true,
        }),
      ).toBeVisible();
      await expectMetadata(page, "en");
    },
  );
});

test("English upload errors, available inbox and exhausted limits use localized copy", async ({
  browser,
}, testInfo) => {
  await withLocale(
    browser,
    testInfo,
    { locale: "en-US" },
    async (page, origin) => {
      let connected = false;
      let full = false;
      await page.route("**/api/config", (route) =>
        route.fulfill({
          json: {
            backend: backend(origin, connected ? "http" : "demo"),
          },
        }),
      );
      await page.route("**/api/uploads", (route) =>
        route.fulfill({
          json: {
            title: "Locale fixture inbox",
            maxFileBytes: 1024,
            maxTotalBytes: 4096,
            usedBytes: full ? 4096 : 0,
            maxFiles: 2,
            usedFiles: full ? 2 : 0,
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        }),
      );
      await page.goto("/upload#token=invalid");
      await expect(
        page.getByRole("heading", { name: "Receive files", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toContainText(
        "This upload link is invalid. Ask the recipient for the complete link.",
      );
      await expectMetadata(page, "en");
      await page.goto(`/upload#token=${"a".repeat(43)}`);
      await expect(page.getByRole("alert")).toContainText(
        "This site is not connected to an upload service. Ask the recipient to finish setup.",
      );
      connected = true;
      await page
        .getByRole("button", { name: "Check again", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Locale fixture inbox",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator(".upload-limits dt")).toHaveText([
        "Maximum file size",
        "Space remaining",
        "Files remaining",
        "Expires on",
      ]);
      await expect(
        page.getByLabel("Choose files to upload", { exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByText("Only the recipient can view your files.", {
          exact: true,
        }),
      ).toBeVisible();
      await expectNoLanguageSwitch(page);
      full = true;
      await page.reload();
      await expect(
        page.getByText("This inbox is full or has expired", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Choose files to upload", { exact: true }),
      ).toBeDisabled();
    },
  );
});

test("English filename interpolation preserves markup, braces and non-English user data as text", async ({
  browser,
}, testInfo) => {
  await withLocale(
    browser,
    testInfo,
    { locale: "en-US" },
    async (page, origin) => {
      const name =
        '<img data-i18n-probe src=x onerror=globalThis.i18nInjected=true> & "{{count}}" 中文.txt';
      const content = "<b data-i18n-probe>Literal preview & {{count}}</b>";
      const path = `/dav/${encodeURIComponent(name)}`;
      const listing = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>${path}</d:href><d:propstat><d:prop>
      <d:resourcetype/><d:getcontentlength>${content.length}</d:getcontentlength>
      <d:getcontenttype>text/plain</d:getcontenttype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
      await page.route("**/api/config", (route) =>
        route.fulfill({ json: { backend: backend(origin, "http") } }),
      );
      await page.route("**/api/capabilities", (route) =>
        route.fulfill({ status: 404 }),
      );
      await page.route("**/dav/**", (route) =>
        route.request().method() === "PROPFIND"
          ? route.fulfill({
              status: 207,
              contentType: "application/xml",
              body: listing,
            })
          : route.fulfill({ contentType: "text/plain", body: content }),
      );
      await page.goto("/");
      await expect(page.locator(".file-item")).toHaveCount(1);
      await expect(page.locator("#item-count")).toHaveCount(0);
      await expect(page.locator(".file-name")).toHaveText(name);
      await expect(page.locator(".file-open")).toHaveAttribute(
        "aria-label",
        `Preview ${name}`,
      );
      await expect(
        page.locator(".favorite-button,.file-copy-button"),
      ).toHaveCount(0);
      await favoriteItem(page.locator(".file-open"));
      await openItem(page.locator(".file-open"));
      await expect(page.locator("#preview-name")).toHaveText(name);
      await expect(page.locator(".preview-content pre")).toHaveText(content);
      await expect(page.locator("[data-i18n-probe]")).toHaveCount(0);
      expect(
        await page.evaluate(() => globalThis.i18nInjected),
      ).toBeUndefined();
      await page
        .getByRole("button", { name: "Close preview", exact: true })
        .click();
      await expect(page.locator("#preview-dialog")).toHaveCount(0);
      await expect(page.locator(".file-open")).toBeFocused();
    },
  );
});
