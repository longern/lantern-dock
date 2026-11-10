import { isCompact } from "../helpers/responsive.mjs";
import { test as base, expect } from "@playwright/test";
import { mainNavigation } from "../helpers/navigation.mjs";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
});

const copyByLanguage = {
  "zh-CN": {
    me: "我的",
    home: "首页",
    favorites: "我的收藏",
    settings: "设置",
    account: "我的账户",
    checking: "正在检查账户…",
    signedIn: "已登录",
    guest: "游客",
    signIn: "统一登录",
    retry: "重试",
    details: "账户详情",
    connectionSettings: "连接设置",
    closeSettings: "关闭设置",
    authentication: "访问方式",
    username: "用户名",
    back: "返回我的",
    signInTitle: "登录你的账户",
    administrator: "管理员",
    standardUser: "普通用户",
  },
  en: {
    me: "Me",
    home: "Home",
    favorites: "My favorites",
    settings: "Settings",
    account: "My account",
    checking: "Checking your account…",
    signedIn: "Signed in",
    guest: "Guest",
    signIn: "Sign in",
    retry: "Try again",
    details: "Account details",
    connectionSettings: "Connection settings",
    closeSettings: "Close settings",
    authentication: "Authentication",
    username: "Username",
    back: "Back to Me",
    signInTitle: "Sign in to your account",
    administrator: "Administrator",
    standardUser: "Standard user",
  },
};

async function enterMyPage(page, language) {
  await page.goto("/");
  await expect(page.locator(".file-item")).toHaveCount(12);
  const me = mainNavigation(page, language).getByRole("button", {
    name: copyByLanguage[language].me,
    exact: true,
  });
  await me.click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(me).toHaveAttribute("aria-current", "page");
  return page.locator("#my-account");
}

const session = (user) => ({
  authenticated: true,
  user: { sub: "fixture-user", issuer: "https://identity.example", ...user },
});

for (const language of ["zh-CN", "en"]) {
  test.describe(`${language} mobile My page`, () => {
    test.use({ locale: language === "en" ? "en-US" : language });
    test.beforeEach(async ({ page }) => {
      test.skip(!isCompact(page), "My is the mobile account destination");
    });
    const copy = copyByLanguage[language];

    test("last tab opens a plain guest summary without a page title and keeps the list actions", async ({
      page,
    }) => {
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({ json: { authenticated: false } }),
      );
      const account = await enterMyPage(page, language);
      const navigation = mainNavigation(page, language);
      await expect(navigation.getByRole("button")).toHaveCount(3);
      await expect(navigation.getByRole("button").last()).toHaveText(copy.me);
      await expect(
        navigation.getByRole("button", { name: /^(收藏|Favorites)/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: copy.me, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: copy.me, exact: true }),
      ).toHaveCount(0);
      await expect(account).toHaveAttribute("aria-busy", "false");
      await expect(
        account.getByRole("button", { name: copy.guest, exact: true }),
      ).toBeVisible();
      await expect(account.locator(".my-account-copy p")).toHaveCount(0);
      await expect(account).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(account).toHaveCSS("border-top-width", "0px");
      await expect(account).toHaveCSS("border-radius", "0px");
      await expect(account).toHaveCSS("box-shadow", "none");
      await expect(page.locator(".my-action-list")).toHaveCSS(
        "background-color",
        "rgb(255, 255, 255)",
      );
      await expect(page.locator(".my-action-list")).toHaveCSS(
        "border-radius",
        "20px",
      );
      await expect(
        account.getByRole("link", { name: copy.signIn, exact: true }),
      ).toHaveCount(0);
      await expect(
        account.getByRole("button", { name: copy.signIn, exact: true }),
      ).toHaveCount(0);
      await expect(page.locator("#my-page").getByRole("button")).toHaveText([
        copy.guest,
        copy.favorites,
        copy.settings,
      ]);
      await expect(
        page.getByRole("searchbox", { includeHidden: true }),
      ).toHaveCount(0);
      await expect(page.locator("#file-list,.category-cards")).toHaveCount(0);
      await expect(account.locator("img")).toHaveCount(0);
      await expect(account).not.toContainText(copy.administrator);
      await expect(account).not.toContainText(copy.standardUser);
      await page.locator("#my-favorites").focus();
      await page.keyboard.press("Tab");
      await expect(page.locator("#my-settings")).toBeFocused();
    });

    test("loading never invents an identity and account failure retries in place", async ({
      page,
    }) => {
      let release;
      let checks = 0;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route("**/api/auth/session", async (route) => {
        checks++;
        if (checks === 1) {
          await gate;
          await route.fulfill({
            status: 503,
            json: { error: "private upstream diagnostic" },
          });
        } else {
          await route.fulfill({
            json: session({ name: "Mina Chen", email: "mina@example.test" }),
          });
        }
      });
      const account = await enterMyPage(page, language);
      try {
        await expect(account).toHaveAttribute("aria-busy", "true");
        await expect(
          account.getByRole("heading", { name: copy.checking, exact: true }),
        ).toBeVisible();
        await expect(account.getByRole("link")).toHaveCount(0);
        await expect(account).not.toContainText("@");
        await expect(page.locator("#my-favorites")).toBeEnabled();
        await expect(page.locator("#my-settings")).toBeEnabled();
      } finally {
        release();
      }
      await expect(account).toHaveAttribute("aria-busy", "false");
      await expect(account).not.toContainText("private upstream diagnostic");
      await account
        .getByRole("button", { name: copy.retry, exact: true })
        .click();
      await expect(
        account.getByRole("heading", { name: "Mina Chen", exact: true }),
      ).toBeVisible();
      await expect(
        account.getByText("mina@example.test", { exact: true }),
      ).toBeVisible();
      await expect(
        account.getByRole("button", { name: copy.retry, exact: true }),
      ).toHaveCount(0);
      await expect(page).toHaveURL(/\/me$/);
      expect(checks).toBe(2);
    });

    test("real session fields render as text without invented role or remote avatar", async ({
      page,
    }) => {
      const name =
        '<img data-account-probe src=x onerror="window.accountInjected=true"> 林 & {{name}}';
      const email = "actual.user@example.test";
      const avatarRequests = [];
      page.on("request", (request) => {
        if (request.url().startsWith("https://avatars.example/"))
          avatarRequests.push(request.url());
      });
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({
          json: session({
            name,
            email,
            picture: "https://avatars.example/unused-photo.png",
          }),
        }),
      );
      const account = await enterMyPage(page, language);
      await expect(
        account.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      await expect(account.getByText(email, { exact: true })).toBeVisible();
      await expect(
        account.getByRole("link", { name: `${name} ${email}`, exact: true }),
      ).toBeVisible();
      await expect(account).not.toContainText(copy.signedIn);
      await expect(account).not.toContainText(copy.administrator);
      await expect(account).not.toContainText(copy.standardUser);
      await expect(account.locator("img,[data-account-probe]")).toHaveCount(0);
      expect(await page.evaluate(() => window.accountInjected)).toBeUndefined();
      expect(avatarRequests).toEqual([]);
    });

    test("signed-in avatar and identity form one account link", async ({
      page,
    }) => {
      let logins = 0;
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({
          json: session({ name: "Mina Chen", email: "mina@example.test" }),
        }),
      );
      await page.route("**/api/auth/login", (route) => {
        logins++;
        return route.fulfill({
          status: 503,
          json: { message: "Unexpected login" },
        });
      });
      const account = await enterMyPage(page, language);
      const trigger = account.getByRole("link", {
        name: "Mina Chen mina@example.test",
        exact: true,
      });
      await expect(account.getByRole("link")).toHaveCount(1);
      await expect(account.getByRole("button")).toHaveCount(0);
      await expect(account).not.toContainText(copy.details);
      await expect(account).not.toContainText(copy.signedIn);
      await expect(trigger).toHaveAttribute("id", "my-account-link");
      await expect(trigger).toHaveAttribute("href", "/account?return=/me");
      await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
      await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(trigger).toHaveCSS("border-top-width", "0px");
      await expect(trigger).toHaveCSS("box-shadow", "none");
      const icon = trigger.locator(".my-account-symbol");
      await expect(icon).toHaveCSS("background-color", "rgb(239, 237, 252)");
      await expect(icon.locator("svg")).toHaveCount(1);
      const { height } = await trigger.boundingBox();
      expect(height).toBeGreaterThanOrEqual(44);
      const dialog = page.locator("#account-dialog");
      for (const activation of ["avatar", "name", "keyboard"]) {
        if (activation === "avatar") await icon.click();
        else if (activation === "name")
          await trigger
            .getByRole("heading", { name: "Mina Chen", exact: true })
            .click();
        else {
          await page.locator("#my-favorites").focus();
          await page.keyboard.press("Shift+Tab");
          await expect(trigger).toBeFocused();
          await expect(trigger).toHaveCSS("outline-style", "solid");
          await page.keyboard.press("Enter");
        }
        await expect(page).toHaveURL(/\/account\?return=(?:%2F|\/)me$/);
        await expect(dialog).toHaveAttribute("data-entry", "animated");
        await expect(dialog).toHaveCSS("animation-name", "page-dialog-in");
        await expect(
          dialog.getByRole("heading", { name: "Mina Chen", exact: true }),
        ).toBeVisible();
        await expect(trigger).toBeAttached();
        await trigger.evaluate((node) => node.focus());
        expect(
          await dialog.evaluate((node) =>
            node.contains(document.activeElement),
          ),
        ).toBe(true);
        await expect(page.locator("#sign-in-dialog")).toHaveCount(0);
        if (activation === "keyboard") await page.keyboard.press("Escape");
        else
          await dialog
            .getByRole("button", { name: copy.back, exact: true })
            .click();
        await expect(page).toHaveURL(/\/me$/);
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
      // The trailing space opens the account and supports native history.
      const { width } = await account.boundingBox();
      await trigger.click({ position: { x: width - 16, y: height / 2 } });
      await expect(page).toHaveURL(/\/account\?return=(?:%2F|\/)me$/);
      await page.goBack();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeVisible();
      await page.goForward();
      await expect(page).toHaveURL(/\/account\?return=(?:%2F|\/)me$/);
      expect(logins).toBe(0);
    });

    test("missing optional identity fields use truthful fallbacks", async ({
      page,
    }) => {
      let user = {};
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({ json: session(user) }),
      );
      for (const fixture of [
        { user: { name: "Name only" }, title: "Name only" },
        {
          user: { email: "email-only@example.test" },
          title: "email-only@example.test",
        },
        { user: {}, title: copy.account },
        { user: { name: "", email: "" }, title: copy.account },
      ]) {
        user = fixture.user;
        // Start a new document so even an unchanged hash reloads the session.
        await page.goto("about:blank");
        await page.goto("/me");
        const account = page.locator("#my-account");
        await expect(
          account.getByRole("heading", { name: fixture.title, exact: true }),
        ).toBeVisible();
        await expect(
          account.getByRole("link", { name: fixture.title, exact: true }),
        ).toHaveAttribute("href", "/account?return=/me");
        await expect(account).not.toContainText(copy.signedIn);
        await expect(account).not.toContainText(
          /undefined|null|fixture-user|identity\.example/,
        );
        await expect(account).not.toContainText(copy.administrator);
        await expect(account.locator("img")).toHaveCount(0);
      }
    });

    test("settings dismissal restores its My row and discards unsubmitted edits", async ({
      page,
    }) => {
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({ json: { authenticated: false } }),
      );
      await enterMyPage(page, language);
      const trigger = page.locator("#my-settings");
      for (const dismiss of ["button", "escape", "backdrop"]) {
        await trigger.click();
        const dialog = page.getByRole("dialog", {
          name: copy.connectionSettings,
          exact: true,
        });
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByLabel(copy.authentication, { exact: true }),
        ).toHaveValue("none");
        await dialog
          .getByLabel(copy.authentication, { exact: true })
          .selectOption("basic");
        await dialog
          .getByLabel(copy.username, { exact: true })
          .fill("unsaved-my-page-user");
        if (dismiss === "button")
          await dialog
            .getByRole("button", { name: copy.closeSettings, exact: true })
            .click();
        else if (dismiss === "escape") await page.keyboard.press("Escape");
        else await page.mouse.click(4, 4);
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expect(page).toHaveURL(/\/me$/);
        await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
      }
    });

    test("guest entry opens sign-in in place and dismisses back to My", async ({
      page,
    }) => {
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({ json: { authenticated: false } }),
      );
      await enterMyPage(page, language);
      const trigger = page.getByRole("button", {
        name: copy.guest,
        exact: true,
      });
      await trigger.click();
      const dialog = page.getByRole("dialog", {
        name: copy.signInTitle,
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(/\/me$/);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(
        mainNavigation(page, language).getByRole("button", {
          name: copy.me,
          exact: true,
        }),
      ).toHaveAttribute("aria-current", "page");
    });
  });
}

test("a late response from an invalidated shared session cannot replace the newer account", async ({
  page,
}) => {
  test.skip(!isCompact(page), "Mobile account navigation");
  // Model an upstream response that completes even after cancellation. This
  // exercises stale-result handling, not just the browser's fetch abortion.
  await page.addInitScript(() => {
    const fetch = window.fetch;
    let checks = 0;
    window.fetch = function (input, options) {
      if (String(input) === "/api/auth/session" && ++checks === 1) {
        return new Promise((resolve) => {
          window.releaseOldAccount = () =>
            resolve(
              new Response(
                JSON.stringify({
                  authenticated: true,
                  user: {
                    name: "Obsolete identity",
                    email: "obsolete@example.test",
                  },
                }),
                { headers: { "Content-Type": "application/json" } },
              ),
            );
        });
      }
      return fetch.call(this, input, options);
    };
  });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: session({
        name: "Current identity",
        email: "current@example.test",
      }),
    }),
  );
  await enterMyPage(page, "zh-CN");
  await expect(page.locator("#my-account")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await mainNavigation(page)
    .getByRole("button", { name: "首页", exact: true })
    .click();
  await expect(page.locator("#my-page")).toHaveCount(0);
  // Route changes now preserve the shared request. An actual session change,
  // not leaving a consumer, invalidates a previous identity lookup.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("lantern-dock:session-changed")),
  );
  await mainNavigation(page)
    .getByRole("button", { name: "我的", exact: true })
    .click();
  await expect(page.locator("#my-account")).toContainText("Current identity");
  await page.evaluate(async () => {
    window.releaseOldAccount();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await expect(page.locator("#my-account")).toContainText(
    "current@example.test",
  );
  await expect(page.locator("#my-account")).not.toContainText(
    "Obsolete identity",
  );
  await expect(page).toHaveURL(/\/me$/);
});

test("long identity fields and the last action remain usable at 320px and above the bottom tabs", async ({
  page,
}, testInfo) => {
  test.skip(!isCompact(page), "Mobile account layout");
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: session({
        name: "LongUnbrokenDisplayName".repeat(12),
        email: `${"long".repeat(40)}@example.test`,
      }),
    }),
  );
  await enterMyPage(page, "zh-CN");
  await expect(page.locator("#my-account")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  for (const width of [320, 390, 700]) {
    await page.setViewportSize({ width, height: 568 });
    await page.locator("#my-settings").scrollIntoViewIfNeeded();
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    const bounds = await page.evaluate(() => {
      const row = document
        .getElementById("my-settings")
        .getBoundingClientRect();
      const tabs = document
        .querySelector(".mobile-tabs")
        .getBoundingClientRect();
      const nodes = [
        document.documentElement,
        document.getElementById("my-page"),
        document.getElementById("my-account"),
      ];
      return {
        row: {
          left: row.left,
          right: row.right,
          bottom: row.bottom,
          height: row.height,
        },
        tabsTop: tabs.top,
        width: innerWidth,
        overflow: nodes
          .filter((node) => node.scrollWidth > node.clientWidth + 1)
          .map((node) => node.id || node.tagName),
      };
    });
    expect(bounds.overflow).toEqual([]);
    expect(bounds.row.left).toBeGreaterThanOrEqual(0);
    expect(bounds.row.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.row.height).toBeGreaterThanOrEqual(44);
    expect(bounds.row.bottom).toBeLessThanOrEqual(bounds.tabsTop);
    await page.locator("#my-settings").click();
    await expect(
      page.getByRole("dialog", { name: "连接设置", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#my-settings")).toBeFocused();
  }
  await page.screenshot({
    path: testInfo.outputPath("my-page-long-identity.png"),
    fullPage: true,
  });
});

test("resizing My to desktop returns to the desktop library without stranding focus", async ({
  page,
}) => {
  test.skip(!isCompact(page), "Starts at the mobile account destination");
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await enterMyPage(page, "zh-CN");
  await page.locator("#my-settings").click();
  await expect(
    page.getByRole("dialog", { name: "连接设置", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("dialog", { name: "连接设置", exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#account-menu-trigger")).toBeVisible();
  await expect(page.locator("#account-menu-trigger")).toBeFocused();
  await expect(page.locator("#my-page")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await expect(
    mainNavigation(page).getByRole("button", { name: /^收藏/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    mainNavigation(page).getByRole("button", { name: "首页", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("searchbox")).toBeVisible();
});

test("signing out during a pending account check cannot resurrect the old identity", async ({
  page,
}) => {
  test.skip(!isCompact(page), "My account round trip");
  let authenticated = true;
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: authenticated
        ? session({ name: "Previous account", email: "previous@example.test" })
        : { authenticated: false },
    }),
  );
  await page.route("**/api/auth/logout", (route) => {
    authenticated = false;
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = function (input, options) {
      if (
        String(input) === "/api/config" &&
        ["/me", "/account"].includes(location.pathname)
      ) {
        return new Promise((resolve) => {
          // Complete after logout even if the account request was cancelled.
          window.releasePendingAccountCheck = () =>
            resolve(
              new Response(
                JSON.stringify({
                  backend: { transport: "demo" },
                }),
                { headers: { "Content-Type": "application/json" } },
              ),
            );
        });
      }
      return fetch.call(this, input, options);
    };
  });
  await enterMyPage(page, "zh-CN");
  await page.locator("#my-account-link").click();
  await expect(
    page
      .locator("#account-dialog")
      .getByRole("heading", { name: "Previous account", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("正在检查账户…", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => typeof window.releasePendingAccountCheck))
    .toBe("function");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "统一登录", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    window.releasePendingAccountCheck();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await expect(page.locator(".account-page")).not.toContainText(
    "Previous account",
  );
  await expect(page.locator(".account-page")).not.toContainText(
    "previous@example.test",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "返回我的", exact: true }).click();
  await expect(
    page
      .locator("#my-account")
      .getByRole("button", { name: "游客", exact: true }),
  ).toBeVisible();
});

test("logout completing after returning to My refreshes its real session", async ({
  page,
}) => {
  test.skip(!isCompact(page), "My account round trip");
  let authenticated = true;
  let logoutStarted = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: authenticated
        ? session({ name: "Signing out account" })
        : { authenticated: false },
    }),
  );
  await page.route("**/api/auth/logout", async (route) => {
    logoutStarted = true;
    await gate;
    authenticated = false;
    await route.fulfill({ json: {} });
  });
  await enterMyPage(page, "zh-CN");
  await page.locator("#my-account-link").click();
  try {
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect.poll(() => logoutStarted).toBe(true);
    await page.getByRole("button", { name: "返回我的", exact: true }).click();
    await expect(page.locator("#my-account")).toContainText(
      "Signing out account",
    );
  } finally {
    release();
  }
  await expect(
    page
      .locator("#my-account")
      .getByRole("button", { name: "游客", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#my-account")).not.toContainText(
    "Signing out account",
  );
  await expect(page).toHaveURL(/\/me$/);
});

test("an unsuccessful account recheck clears the previously verified session", async ({
  page,
}) => {
  let checks = 0;
  await page.route("**/api/auth/session", (route) => {
    checks++;
    return checks === 1
      ? route.fulfill({
          json: session({
            name: "Outdated account",
            email: "outdated@example.test",
          }),
        })
      : route.fulfill({
          status: 503,
          json: { message: "Session unavailable for recheck" },
        });
  });
  await page.goto("/account");
  await expect(
    page.getByRole("heading", { name: "Outdated account", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Session unavailable for recheck",
  );
  await expect(page.locator(".account-page")).not.toContainText(
    "Outdated account",
  );
  await expect(page.locator(".account-page")).not.toContainText(
    "outdated@example.test",
  );
  // A failed check is not a confirmed logout and must not offer guest actions.
  await expect(
    page.getByRole("button", { name: "统一登录", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "重新检测", exact: true }),
  ).toBeEnabled();
});
