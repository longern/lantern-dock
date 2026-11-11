import { isCompact } from "../helpers/responsive.mjs";
import { test as base, expect } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    // DPoP intentionally requires HTTPS. Keep Vite local while exercising the
    // real browser proof flow under a secure test origin.
    await page.route("https://127.0.0.1:8788/**", async (route) => {
      const request = route.request();
      const response = await route.fetch({
        url: request.url().replace(/^https:/, "http:"),
        headers: {
          ...(await request.allHeaders()),
          "Sec-Fetch-Mode":
            request.resourceType() === "document" ? "navigate" : "cors",
        },
      });
      await route.fulfill({ response });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ json: { authenticated: false } }),
    );
    await use(page);
    expect(errors).toEqual([]);
  },
});
test.use({ baseURL: "https://127.0.0.1:8788", ignoreHTTPSErrors: true });

const copyByLanguage = {
  "zh-CN": {
    guest: "游客",
    title: "登录你的账户",
    login: "统一登录",
    close: "关闭登录",
    favorites: "我的收藏",
    back: "返回我的",
  },
  en: {
    guest: "Guest",
    title: "Sign in to your account",
    login: "Sign in",
    close: "Close sign-in",
    favorites: "My favorites",
    back: "Back to Me",
  },
};
const returnKey = "lantern-dock:account-return";
const hint = (page) =>
  page.evaluate((key) => sessionStorage.getItem(key), returnKey);
const dialogFor = (page, copy) =>
  page.getByRole("dialog", { name: copy.title, exact: true });

async function openGuest(page, copy) {
  await page.goto("/");
  await expect(page.locator(".file-item")).toHaveCount(12);
  await page.evaluate(() => {
    history.pushState(null, "", "/me");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const trigger = page.getByRole("button", { name: copy.guest, exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(dialogFor(page, copy)).toBeVisible();
  return trigger;
}

// Ignore AbortSignal deliberately: late upstream responses must be harmless even
// when fetch cancellation itself does not prevent their eventual completion.
async function installDeferredLogin(page) {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.loginAttempts = [];
    window.fetch = function (input, options) {
      if (String(input) !== "/api/auth/login")
        return fetch.call(this, input, options);
      return new Promise((resolve) => {
        window.loginAttempts.push({
          signal: options.signal,
          release: (url) =>
            resolve(
              new Response(JSON.stringify({ url }), {
                headers: { "Content-Type": "application/json" },
              }),
            ),
        });
      });
    };
  });
}

for (const language of ["zh-CN", "en"]) {
  test.describe(`${language} guest login dialog`, () => {
    test.use({ locale: language === "en" ? "en-US" : language });
    test.beforeEach(async ({ page }) => {
      test.skip(!isCompact(page), "Guest login entry is on mobile My");
    });
    const copy = copyByLanguage[language];

    test("icon and guest text form one button, and opening never starts login", async ({
      page,
    }) => {
      let logins = 0;
      await page.route("**/api/auth/login", (route) => {
        logins++;
        return route.fulfill({
          status: 503,
          json: { message: "Unexpected login" },
        });
      });
      await page.goto("/me");
      const trigger = page.getByRole("button", {
        name: copy.guest,
        exact: true,
      });
      await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(trigger).toHaveCSS("border-top-width", "0px");
      await expect(trigger).toHaveCSS("box-shadow", "none");
      const icon = trigger.locator(".my-account-symbol");
      await expect(icon).toHaveCSS("background-color", "rgb(239, 237, 252)");
      await expect(icon.locator("svg")).toHaveCount(1);
      await expect(page.locator("#my-account-link")).toHaveCount(0);
      await expect(page.locator("#my-account").getByRole("button")).toHaveCount(
        1,
      );
      await expect(page.locator("#my-account")).not.toContainText(copy.login);
      await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
      const size = await trigger.boundingBox();
      expect(size.height).toBeGreaterThanOrEqual(44);
      // Both visible pieces activate the same control, without another CTA.
      await icon.click();
      const dialog = dialogFor(page, copy);
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveJSProperty("tagName", "DIALOG");
      expect(await dialog.evaluate((node) => node.matches(":modal"))).toBe(
        true,
      );
      await expect(
        dialog.getByRole("button", { name: copy.login, exact: true }),
      ).toBeEnabled();
      await expect(page).toHaveURL(/\/me$/);
      expect(await hint(page)).toBeNull();
      expect(logins).toBe(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await trigger.getByText(copy.guest, { exact: true }).click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      const { width } = await page.locator("#my-account").boundingBox();
      await trigger.click({ position: { x: width - 16, y: size.height / 2 } });
      await expect(dialog).toBeVisible();
      expect(logins).toBe(0);
    });

    for (const reducedMotion of ["no-preference", "reduce"]) {
      test(`${reducedMotion}: close, Escape and backdrop restore focus and permit reopening`, async ({
        page,
      }) => {
        await page.emulateMedia({ reducedMotion });
        const trigger = await openGuest(page, copy);
        const dialog = dialogFor(page, copy);
        for (const dismiss of ["button", "escape", "backdrop"]) {
          if (dismiss !== "button") await trigger.click();
          await expect(dialog).toBeVisible();
          await expect(dialog.locator(".dialog-heading")).toBeFocused();
          const close = dialog.getByRole("button", {
            name: copy.close,
            exact: true,
          });
          const submit = dialog.getByRole("button", {
            name: copy.login,
            exact: true,
          });
          await close.focus();
          await page.keyboard.press("Shift+Tab");
          await expect(submit).toBeFocused();
          await page.keyboard.press("Tab");
          await expect(close).toBeFocused();
          if (dismiss === "button") await close.click();
          else if (dismiss === "escape") await page.keyboard.press("Escape");
          else await page.mouse.click(2, 2);
          await expect(dialog).toHaveCount(0);
          await expect(trigger).toBeFocused();
          await expect(page).toHaveURL(/\/me$/);
          await expect(page.locator("body")).not.toHaveCSS(
            "overflow",
            "hidden",
          );
          expect(await hint(page)).toBeNull();
        }
        await page.locator("#my-favorites").click();
        const favorites = page.getByRole("dialog", {
          name: copy.favorites,
          exact: true,
        });
        await expect(favorites).toBeVisible();
        await expect(dialog).toHaveCount(0);
        await favorites
          .getByRole("button", { name: copy.back, exact: true })
          .click();
        await expect(favorites).toHaveCount(0);
        await expect(page.locator("#my-favorites")).toBeFocused();
        await trigger.click();
        await expect(dialog).toBeVisible();
      });
    }

    test("explicit login uses the existing proof flow, fails visibly, and retries without stale errors", async ({
      page,
    }) => {
      const attempts = [];
      await page.route("**/api/auth/login", (route) => {
        attempts.push(route.request());
        return route.fulfill({
          status: 503,
          json: { message: "Identity service unavailable" },
        });
      });
      const trigger = await openGuest(page, copy);
      const dialog = dialogFor(page, copy);
      expect(attempts).toHaveLength(0);
      await dialog
        .getByRole("button", { name: copy.login, exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toContainText(
        "Identity service unavailable",
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0].method()).toBe("POST");
      expect(attempts[0].headers().dpop).toBeTruthy();
      expect(attempts[0].headers()["accept-language"]).toBe(language);
      expect(await hint(page)).toBeNull();
      await expect(page.locator("#sign-in-submit")).toBeEnabled();
      await page.locator("#sign-in-submit").click();
      await expect.poll(() => attempts.length).toBe(2);
      await expect(dialog.getByRole("alert")).toContainText(
        "Identity service unavailable",
      );
      expect(await hint(page)).toBeNull();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await trigger.click();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await expect(
        dialog.getByRole("button", { name: copy.login, exact: true }),
      ).toBeEnabled();
    });

    test("rapid explicit activation starts only one login and successful login preserves the Me return hint", async ({
      page,
    }) => {
      await installDeferredLogin(page);
      await page.route("**/login-complete", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<title>Login destination</title>",
        }),
      );
      await openGuest(page, copy);
      // Dispatch twice in one turn to exercise the handler guard, not merely
      // Playwright waiting for the disabled state between two ordinary clicks.
      await page.locator("#sign-in-submit").evaluate((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect
        .poll(() => page.evaluate(() => window.loginAttempts.length))
        .toBe(1);
      await expect(page.locator("#sign-in-submit")).toBeDisabled();
      expect(await hint(page)).toBeNull();
      await page.evaluate(() =>
        window.loginAttempts[0].release(location.origin + "/login-complete"),
      );
      await expect(page).toHaveURL(/\/login-complete$/);
      expect(await hint(page)).toBeNull();
    });
  });
}

for (const dismissal of [
  "close",
  "escape",
  "backdrop",
  "home",
  "history",
  "favorites",
  "desktop",
]) {
  test(`pending login is cancelled on ${dismissal}; a late response cannot redirect`, async ({
    page,
  }) => {
    test.skip(!isCompact(page), "Starts on mobile My");
    const copy = copyByLanguage["zh-CN"];
    await installDeferredLogin(page);
    // A same-document destination makes an accidental redirect observable
    // without relying on external network access or unloading this test hook.
    const trigger = await openGuest(page, copy);
    const dialog = dialogFor(page, copy);
    await page.locator("#sign-in-submit").click();
    await expect
      .poll(() => page.evaluate(() => window.loginAttempts.length))
      .toBe(1);
    expect(await hint(page)).toBeNull();
    if (dismissal === "close")
      await dialog
        .getByRole("button", { name: copy.close, exact: true })
        .click();
    else if (dismissal === "escape") await page.keyboard.press("Escape");
    else if (dismissal === "backdrop") await page.mouse.click(2, 2);
    else if (dismissal === "desktop")
      await page.setViewportSize({ width: 1440, height: 900 });
    else if (dismissal === "history") await page.goBack();
    else
      await page.evaluate(
        (route) => {
          history.pushState(null, "", route);
          window.dispatchEvent(new PopStateEvent("popstate"));
        },
        dismissal === "favorites" ? "/favorites" : "/",
      );
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.loginAttempts[0].signal.aborted))
      .toBe(true);
    expect(await hint(page)).toBeNull();
    const destination = page.url();
    await page.evaluate(async () => {
      window.loginAttempts[0].release(
        location.origin + "/account?late-login=1",
      );
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await expect(page).toHaveURL(destination);
    await expect(dialog).toHaveCount(0);
    expect(await hint(page)).toBeNull();
    if (["close", "escape", "backdrop"].includes(dismissal)) {
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await expect(page.locator("#sign-in-submit")).toBeEnabled();
    } else if (dismissal === "favorites") {
      const favorites = page.getByRole("dialog", {
        name: copy.favorites,
        exact: true,
      });
      await expect(favorites).toBeVisible();
      await favorites
        .getByRole("button", { name: copy.back, exact: true })
        .click();
      await expect(favorites).toHaveCount(0);
      await expect(page.locator("#my-favorites")).toBeFocused();
      await expect(dialog).toHaveCount(0);
    }
  });
}

test("an old login response cannot redirect or clear a newer attempt after reopening", async ({
  page,
}) => {
  test.skip(!isCompact(page), "Mobile guest login");
  await installDeferredLogin(page);
  const copy = copyByLanguage["zh-CN"];
  const trigger = await openGuest(page, copy);
  const dialog = dialogFor(page, copy);
  await page.locator("#sign-in-submit").click();
  await expect
    .poll(() => page.evaluate(() => window.loginAttempts.length))
    .toBe(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await page.locator("#sign-in-submit").click();
  await expect
    .poll(() => page.evaluate(() => window.loginAttempts.length))
    .toBe(2);
  await page.evaluate(async () => {
    window.loginAttempts[0].release(location.origin + "/account?obsolete=1");
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await expect(page).toHaveURL(/\/me$/);
  await expect(dialog).toBeVisible();
  await expect(page.locator("#sign-in-submit")).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(await hint(page)).toBeNull();
  expect(
    await page.evaluate(() =>
      window.loginAttempts.map(({ signal }) => signal.aborted),
    ),
  ).toEqual([true, false]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await hint(page)).toBeNull();
});

test("the account return destination survives refresh without a session-storage hint", async ({
  page,
}) => {
  test.skip(!isCompact(page), "Mobile account return destination");
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          sub: "fixture-user",
          issuer: "https://identity.example",
          name: "Signed-in visitor",
          email: "visitor@example.test",
        },
      },
    }),
  );
  await page.goto("/");
  await expect(page.locator(".file-item")).toHaveCount(12);
  await page.evaluate((key) => {
    history.pushState(null, "", "/account?return=/me");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, returnKey);
  await expect(
    page
      .locator("#account-dialog")
      .getByRole("heading", { name: "Signed-in visitor", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/account\?return=(?:%2F|\/)me$/);
  expect(await hint(page)).toBeNull();
  await page.reload();
  await expect(page.locator("#account-dialog")).toHaveAttribute(
    "data-entry",
    "instant",
  );
  await page.getByRole("button", { name: "返回我的", exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  const account = page.locator("#my-account");
  await expect(
    account.getByRole("heading", { name: "Signed-in visitor", exact: true }),
  ).toBeVisible();
  await expect(account).toContainText("visitor@example.test");
  await expect(
    account.getByRole("button", { name: "游客", exact: true }),
  ).toHaveCount(0);
  await account
    .getByRole("link", {
      name: "Signed-in visitor visitor@example.test",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/account\?return=(?:%2F|\/)me$/);
  await expect(
    page
      .locator("#account-dialog")
      .getByRole("heading", { name: "Signed-in visitor", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#sign-in-dialog")).toHaveCount(0);
});
