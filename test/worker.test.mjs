import test from "node:test";
import assert from "node:assert/strict";
import worker, { configuration, validatePins } from "../worker/index.js";
import { createTranslator } from "../shared/i18n.js";
import { setupVariables } from "../src/lib/setup.js";
import {
  deriveSecret,
  CERTIFICATE_WEBHOOK_PURPOSE,
} from "../worker/secrets.js";
const base = {
  BACKEND_TRANSPORT: "http",
  BACKEND_ENDPOINT: "https://files.example.com",
  BACKEND_ROOT: "/dav/",
  ASSETS: { fetch: async () => new Response("static") },
};
const pin = {
  algorithm: "sha-256",
  value: "A".repeat(43) + "=",
  notBefore: new Date(Date.now() - 1000).toISOString(),
  notAfter: new Date(Date.now() + 13 * 86400000).toISOString(),
};
test("config contains endpoint metadata, never backend credentials or webhook secret", async () => {
  const env = {
    ...base,
    BRIDGE_TOKEN: "never-publish",
    PASSWORD: "secret",
    CERT_WEBHOOK_SECRET: "hook-secret",
  };
  const r = await worker.fetch(
    new Request("https://portal.example.com/api/config"),
    env,
  );
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.backend.endpoint, base.BACKEND_ENDPOINT);
  assert.ok(!JSON.stringify(data).includes("secret"));
  assert.equal(r.headers.get("Cache-Control"), "no-store");
});
test("Worker never fetches backend file contents", async () => {
  let assets = 0;
  const r = await worker.fetch(
    new Request("https://portal.example.com/anything"),
    {
      ...base,
      ASSETS: {
        fetch: async () => {
          assets++;
          return new Response("static");
        },
      },
    },
  );
  assert.equal(await r.text(), "static");
  assert.equal(assets, 1);
  const unknown = await worker.fetch(
    new Request(
      "https://portal.example.com/api/proxy?url=https://target.example",
    ),
    base,
  );
  assert.equal(unknown.status, 404);
});
test("WebTransport requires published valid pins unless using Web PKI", async () => {
  await assert.rejects(
    configuration({ ...base, BACKEND_TRANSPORT: "webtransport" }),
    /certificate/,
  );
  const env = {
    ...base,
    BACKEND_TRANSPORT: "webtransport",
    BACKEND_ENDPOINT: "https://bridge.example.com:4433/webtransport",
    KV: { get: async () => ({ version: 1, certificates: [pin] }) },
  };
  const config = await configuration(env);
  assert.equal(config.backend.certificates.length, 1);
  assert.equal(config.backend.endpoint, env.BACKEND_ENDPOINT);
  assert.equal(
    (
      await configuration({
        ...env,
        CERTIFICATE_MODE: "webpki",
        KV: undefined,
      })
    ).backend.certificates.length,
    0,
  );
});
test("private webhook authenticates, validates and acknowledges storage", async () => {
  let stored;
  const secret = "a".repeat(64);
  const env = {
    ...base,
    CERT_WEBHOOK_SECRET: secret,
    KV: { put: async (_, value) => (stored = JSON.parse(value)) },
  };
  const url = "https://portal.example.com/api/certificates/" + secret;
  const req = (path) =>
    new Request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, certificates: [pin] }),
    });
  assert.equal((await worker.fetch(req(url + "wrong"), env)).status, 401);
  assert.equal((await worker.fetch(req(url), env)).status, 204);
  assert.equal(stored.certificates.length, 1);
  assert.equal(
    (
      await worker.fetch(req(url), {
        ...env,
        KV: {
          put: async () => {
            throw new Error("offline");
          },
        },
      })
    ).status,
    503,
  );
});
test("certificate lifespan has a 14-day upper bound", () => {
  assert.equal(validatePins({ version: 1, certificates: [pin] }).length, 1);
  assert.throws(() =>
    validatePins({
      version: 1,
      certificates: [
        {
          ...pin,
          notAfter: new Date(
            Date.parse(pin.notBefore) + 14 * 86400000 + 1,
          ).toISOString(),
        },
      ],
    }),
  );
});
test("configuration rejects credential-bearing endpoints and invalid roots", async () => {
  for (const env of [
    { ...base, BACKEND_ENDPOINT: "https://user:secret@files.example.com" },
    { ...base, BACKEND_ROOT: "/../secret/" },
  ])
    await assert.rejects(configuration(env));
});

test("URL variables select the transport and retain legacy settings", async () => {
  const direct = (
    await configuration({ WEBDAV_URL: "https://files.example.com/dav/public/" })
  ).backend;
  assert.equal(direct.transport, "http");
  assert.equal(direct.endpoint, "https://files.example.com");
  assert.equal(direct.rootPath, "/dav/public/");
  assert.equal(
    (
      await configuration({
        WEBDAV_URL: "https://files.example.com/dav/",
        BACKEND_ROOT: "/override/",
      })
    ).backend.rootPath,
    "/override/",
  );
  const legacy = (await configuration(base)).backend;
  assert.equal(legacy.rootPath, "/dav/");
  const bridgeEnv = {
    WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
    KV: { get: async () => ({ version: 1, certificates: [pin] }) },
  };
  const { backend: bridge } = await configuration(bridgeEnv);
  assert.equal(bridge.transport, "webtransport");
  assert.equal(bridge.rootPath, "/dav/");
  assert.equal("gatewayAuth" in bridge, false);
  assert.deepEqual(
    (await configuration({ ...bridgeEnv, GATEWAY_AUTH: "false" })).backend,
    bridge,
  );
  assert.equal(
    (
      await configuration({
        WEBDAV_URL: "https://files.example.com",
        BACKEND_TRANSPORT: "webtransport",
        BACKEND_ENDPOINT: "https://old.example.com",
      })
    ).backend.transport,
    "http",
  );
});

test("NAS paths default to /dav/ while explicit third-party roots are preserved", async () => {
  for (const address of [
    { WEBDAV_URL: "https://files.example.com" },
    {
      BACKEND_ENDPOINT: "https://files.example.com",
      BACKEND_TRANSPORT: "http",
    },
    {
      WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
      CERTIFICATE_MODE: "webpki",
    },
  ]) {
    assert.equal((await configuration(address)).backend.rootPath, "/dav/");
    for (const root of ["/", "/public/", "/dav/subfolder/"])
      assert.equal(
        (await configuration({ ...address, BACKEND_ROOT: root })).backend
          .rootPath,
        root,
      );
  }
});

test("two active URL variables require an explicit choice instead of falling back", async () => {
  const env = {
    WEBDAV_URL: "https://files.example.com/dav/",
    WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
  };
  const response = await worker.fetch(
    new Request("https://portal.example.com/api/config"),
    env,
  );
  const data = await response.json();
  assert.equal(data.setupRequired, true);
  assert.equal(data.setup.reason, "conflicting-backends");
  assert.deepEqual(data.setup.resetVariables, [
    "WEBDAV_URL",
    "WEBTRANSPORT_URL",
  ]);
  const withRoot = await worker.fetch(
    new Request("https://portal.example.com/api/config"),
    { ...env, BACKEND_ROOT: "/" },
  );
  assert.ok(
    (await withRoot.json()).setup.resetVariables.includes("BACKEND_ROOT"),
  );
});

test("missing backend configuration returns setup metadata instead of an error", async () => {
  for (const endpoint of [undefined, "", "   "]) {
    const r = await worker.fetch(
      new Request("https://portal.example.com/api/config"),
      {
        BACKEND_ENDPOINT: endpoint,
        BRIDGE_TOKEN: "private-token",
        CERT_WEBHOOK_SECRET: "private-hook",
      },
    );
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.setupRequired, true);
    assert.equal(data.setup.reason, "missing-backend");
    assert.equal(data.setup.hasSecretKey, false);
    assert.equal(data.error, undefined);
    assert.equal(data.backend, undefined);
    assert.ok(!JSON.stringify(data).includes("private-"));
  }
  const demo = await worker.fetch(
    new Request("https://portal.example.com/api/config"),
    { DEMO_MODE: "true" },
  );
  assert.equal((await demo.json()).backend.transport, "demo");
});

test("setup reports only whether a valid site key is already configured", async () => {
  for (const key of ["short", "private-site-key-".repeat(4)]) {
    const response = await worker.fetch(
      new Request("https://portal.example.com/api/config"),
      { SECRET_KEY: key },
    );
    const data = await response.json();
    assert.equal(data.setup.hasSecretKey, key.length >= 32);
    assert.ok(!JSON.stringify(data).includes(key));
  }
});

test("configuration mistakes and missing pins provide safe setup defaults", async () => {
  const invalid = await worker.fetch(
    new Request("https://portal.example.com/api/config"),
    {
      ...base,
      BACKEND_ENDPOINT: "https://user:private-password@files.example.com",
    },
  );
  const data = await invalid.json();
  assert.equal(data.setup.reason, "invalid-configuration");
  assert.equal(data.setup.backend.endpoint, "");
  assert.ok(!JSON.stringify(data).includes("private-password"));
  const missing = await worker.fetch(
    new Request("https://portal.example.com/api/config"),
    {
      ...base,
      BACKEND_TRANSPORT: "webtransport",
      BACKEND_ENDPOINT: "https://bridge.example.com:4433/webtransport",
    },
  );
  const pins = await missing.json();
  assert.equal(missing.status, 200);
  assert.equal(pins.setup.reason, "missing-certificates");
  assert.equal(pins.setup.backend.transport, "webtransport");
  assert.equal("gatewayAuth" in pins.setup.backend, false);
});

test("storage outages remain errors and the public config endpoint cannot write settings", async () => {
  const env = {
    ...base,
    BACKEND_TRANSPORT: "webtransport",
    KV: {
      get: async () => {
        throw new Error("private storage diagnostics");
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://portal.example.com/api/config"),
    env,
  );
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.setupRequired, undefined);
  assert.ok(!JSON.stringify(data).includes("private storage"));
  const write = await worker.fetch(
    new Request("https://portal.example.com/api/config", {
      method: "PUT",
      body: "{}",
    }),
    base,
  );
  assert.equal(write.status, 404);
  assert.equal(base.BACKEND_ENDPOINT, "https://files.example.com");
});

test("certificate updates accept only a purpose-derived token, never the master key", async () => {
  const master = "m".repeat(64),
    token = await deriveSecret(master, CERTIFICATE_WEBHOOK_PURPOSE);
  let writes = 0;
  const env = {
    ...base,
    SECRET_KEY: master,
    KV: {
      put: async () => {
        writes++;
      },
    },
  };
  const request = (value) =>
    new Request("https://portal.example.com/api/certificates/" + value, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, certificates: [pin] }),
    });
  assert.equal((await worker.fetch(request(token), env)).status, 204);
  assert.equal((await worker.fetch(request(master), env)).status, 401);
  assert.equal(
    (
      await worker.fetch(
        request(await deriveSecret(master, "lantern-dock:other:v1")),
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (await worker.fetch(request(token), { ...env, SECRET_KEY: "n".repeat(64) }))
      .status,
    401,
  );
  assert.equal(
    (await worker.fetch(request(token), { ...env, SECRET_KEY: "short" }))
      .status,
    503,
  );
  assert.equal(writes, 1);
  const publicConfig = await (
    await worker.fetch(
      new Request("https://portal.example.com/api/config"),
      env,
    )
  ).text();
  assert.ok(!publicConfig.includes(master));
  assert.ok(!publicConfig.includes(token));
  const publicSetup = await (
    await worker.fetch(new Request("https://portal.example.com/api/config"), {
      ...env,
      BACKEND_ENDPOINT: "",
    })
  ).text();
  assert.ok(!publicSetup.includes(master));
  assert.ok(!publicSetup.includes(token));
});

test("webhook reports deployment errors separately from an invalid private URL", async () => {
  const master = "diagnostic-site-key-".repeat(4);
  const token = await deriveSecret(master, CERTIFICATE_WEBHOOK_PURPOSE);
  const url = `https://portal.example.com/api/certificates/${token}`;
  let writes = 0;
  const env = {
    SECRET_KEY: master,
    KV: {
      get: async () => null,
      put: async () => {
        writes++;
      },
    },
  };
  const request = () =>
    new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, certificates: [pin] }),
    });
  for (const KV of [undefined, "lantern-dock", {}]) {
    const response = await worker.fetch(request(), { ...env, KV });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "MISSING_KV_BINDING");
  }
  for (const SECRET_KEY of [undefined, "short"]) {
    const response = await worker.fetch(request(), { ...env, SECRET_KEY });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "INVALID_SITE_KEY");
  }
  const wrong = await worker.fetch(
    new Request(url + "wrong", { method: "PUT", body: "{}" }),
    env,
  );
  assert.equal(wrong.status, 401);
  assert.equal(
    wrong.headers.get("WWW-Authenticate"),
    'Webhook realm="certificate-updates"',
  );
  assert.equal((await wrong.json()).code, "INVALID_WEBHOOK_TOKEN");
  const query = await worker.fetch(
    new Request(url + "?extra=value", { method: "PUT", body: "{}" }),
    env,
  );
  assert.equal(query.status, 400);
  assert.equal((await query.json()).code, "INVALID_WEBHOOK_URL");
  const get = await worker.fetch(new Request(url), env);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("Allow"), "PUT");
  assert.equal(writes, 0);
  assert.equal((await worker.fetch(request(), env)).status, 204);
  assert.equal(writes, 1);
});

test("setup exposes KV binding availability without returning a namespace or secret", async () => {
  const key = "private-setup-key-".repeat(4);
  for (const KV of [
    undefined,
    "lantern-dock",
    { get: async () => null, put: async () => {} },
  ]) {
    const response = await worker.fetch(
      new Request("https://portal.example.com/api/config"),
      {
        WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
        SECRET_KEY: key,
        KV,
      },
    );
    const data = await response.json();
    assert.equal(data.setup.hasKV, typeof KV === "object");
    assert.equal(data.setup.hasSecretKey, true);
    assert.ok(!JSON.stringify(data).includes(key));
    assert.ok(!JSON.stringify(data).includes("lantern-dock"));
  }
});

test("an explicit legacy webhook credential stays valid during migration", async () => {
  const master = "m".repeat(64),
    legacy = "l".repeat(64),
    token = await deriveSecret(master, CERTIFICATE_WEBHOOK_PURPOSE);
  const env = {
    SECRET_KEY: master,
    CERT_WEBHOOK_SECRET: legacy,
    KV: { put: async () => {} },
  };
  const request = (value) =>
    new Request("https://portal.example.com/api/certificates/" + value, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, certificates: [pin] }),
    });
  assert.equal((await worker.fetch(request(legacy), env)).status, 204);
  assert.equal((await worker.fetch(request(token), env)).status, 204);
  assert.equal(
    (
      await worker.fetch(request(legacy), {
        ...env,
        CERT_WEBHOOK_SECRET: undefined,
      })
    ).status,
    401,
  );
});

test("configuration negotiates browser languages without changing configured names", async () => {
  const cases = [
    ["zh-TW, en;q=0.8", "zh-CN", "我的文件", "公开资源库"],
    ["zh-CN;q=0.5, en-GB;q=0.9", "en", "My files", "Public library"],
    ["fr-FR, zh;q=0.8, en;q=0.5", "zh-CN", "我的文件", "公开资源库"],
    ["zh;q=0, en;q=1", "en", "My files", "Public library"],
    ["fr-FR", "en", "My files", "Public library"],
    ["", "en", "My files", "Public library"],
  ];
  for (const [language, locale, name, demoName] of cases) {
    const request = () =>
      new Request("https://portal.example.com/api/config", {
        headers: { "Accept-Language": language },
      });
    const configured = await worker.fetch(request(), base);
    assert.equal((await configured.json()).backend.name, name);
    assert.equal(configured.headers.get("Content-Language"), locale);
    assert.equal(configured.headers.get("Vary"), "Accept-Language");
    assert.equal(configured.headers.get("Cache-Control"), "no-store");
    const setup = await worker.fetch(request(), {});
    assert.equal((await setup.json()).setup.backend.name, name);
    const demo = await worker.fetch(request(), { DEMO_MODE: "true" });
    assert.equal((await demo.json()).backend.name, demoName);
    for (const env of [base, {}]) {
      const custom = await worker.fetch(request(), {
        ...env,
        BACKEND_NAME: "<Owner's archive>",
      });
      const data = await custom.json();
      assert.equal(
        (data.backend || data.setup.backend).name,
        "<Owner's archive>",
      );
    }
  }
});

test("concurrent configuration requests keep their language across storage awaits", async () => {
  const pending = [];
  const env = {
    ...base,
    BACKEND_TRANSPORT: "webtransport",
    KV: {
      get: () =>
        new Promise((resolve) => {
          pending.push(resolve);
          if (pending.length === 2)
            for (const complete of pending.reverse())
              complete({ version: 1, certificates: [pin] });
        }),
    },
  };
  const responses = await Promise.all(
    ["zh-CN", "en"].map((language) =>
      worker.fetch(
        new Request("https://portal.example.com/api/config", {
          headers: { "Accept-Language": language },
        }),
        env,
      ),
    ),
  );
  assert.equal((await responses[0].json()).backend.name, "我的文件");
  assert.equal((await responses[1].json()).backend.name, "My files");
  assert.equal(responses[0].headers.get("Content-Language"), "zh-CN");
  assert.equal(responses[1].headers.get("Content-Language"), "en");
});

test("webhook validation localizes safe errors without exposing malformed payloads", async () => {
  const secret = "localized-webhook-secret-".repeat(3);
  const env = { CERT_WEBHOOK_SECRET: secret, KV: { put: async () => {} } };
  const url = "https://portal.example.com/api/certificates/" + secret;
  for (const [language, expected] of [
    ["en", "Invalid JSON body"],
    ["zh-CN", "JSON 请求正文无效。"],
  ]) {
    const response = await worker.fetch(
      new Request(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Accept-Language": language,
        },
        body: '{"private-canary":',
      }),
      env,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: expected });
    assert.equal(response.headers.get("Content-Language"), language);
  }
  const invalidPin = await worker.fetch(
    new Request(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": "zh-CN",
      },
      body: JSON.stringify({ version: 1, certificates: [null] }),
    }),
    env,
  );
  assert.deepEqual(await invalidPin.json(), { error: "证书指纹无效。" });
});

test("setup distinguishes explicit default names from localized fallback names", async () => {
  for (const [language, defaultName] of [
    ["en", "My files"],
    ["zh-CN", "我的文件"],
  ]) {
    for (const name of [undefined, "", "My files", "我的文件"]) {
      const env = Object.freeze(
        name === undefined ? {} : { BACKEND_NAME: name },
      );
      const request = () =>
        new Request("https://portal.example.com/api/config", {
          headers: { "Accept-Language": language },
        });
      const setup = await worker.fetch(request(), env);
      const data = await setup.json();
      assert.equal(data.setup.backend.name, name || defaultName);
      assert.equal(data.setup.backend.nameConfigured, Boolean(name));
      assert.equal(
        data.setup.resetVariables.includes("BACKEND_NAME"),
        Boolean(name),
      );
      assert.equal(env.BACKEND_NAME, name);
      assert.equal(Object.hasOwn(env, "BACKEND_NAME"), name !== undefined);

      const configured = await worker.fetch(request(), { ...base, ...env });
      const backend = (await configured.json()).backend;
      assert.equal(backend.name, name || defaultName);
      assert.equal(Object.hasOwn(backend, "nameConfigured"), false);
    }
  }
});

test("clearing an explicit English default name exports a reset for every locale", async () => {
  for (const language of ["en", "zh-CN"]) {
    const previous = Object.freeze({ BACKEND_NAME: "My files" });
    const response = await worker.fetch(
      new Request("https://portal.example.com/api/config", {
        headers: { "Accept-Language": language },
      }),
      previous,
    );
    const { setup } = await response.json();
    assert.equal(setup.backend.nameConfigured, true);
    assert.deepEqual(setup.resetVariables, ["BACKEND_NAME"]);
    const form = {
      ...setup.backend,
      endpoint: "https://files.example.com",
    };
    const retained = setupVariables(form, setup.resetVariables);
    assert.equal(retained.BACKEND_NAME, "My files");
    const cleared = setupVariables(
      { ...form, name: "", nameConfigured: false },
      setup.resetVariables,
    );
    assert.equal(cleared.BACKEND_NAME, "");
    const configured = await configuration(
      { ...previous, ...cleared },
      createTranslator(language),
    );
    assert.equal(
      configured.backend.name,
      language === "zh-CN" ? "我的文件" : "My files",
    );
    assert.equal(previous.BACKEND_NAME, "My files");
  }
});

test("reserved API and auth navigation never falls back to the SPA shell", async () => {
  let assets = 0;
  const env = {
    ASSETS: {
      fetch() {
        assets++;
        return new Response("<html>SPA</html>");
      },
    },
  };
  for (const path of ["/api", "/api/missing", "/auth", "/auth/missing"]) {
    const response = await worker.fetch(
      new Request("https://portal.example" + path, {
        headers: { "Sec-Fetch-Mode": "navigate" },
      }),
      env,
    );
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get("Content-Type"), /application\/json/);
  }
  assert.equal(assets, 0);
});
