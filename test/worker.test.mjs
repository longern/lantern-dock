import test from "node:test";
import assert from "node:assert/strict";
import worker, { configuration, validatePins } from "../worker/index.js";
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
    PINS: { get: async () => ({ version: 1, certificates: [pin] }) },
  };
  const config = await configuration(env);
  assert.equal(config.backend.certificates.length, 1);
  assert.equal(config.backend.endpoint, env.BACKEND_ENDPOINT);
  assert.equal(
    (
      await configuration({
        ...env,
        CERTIFICATE_MODE: "webpki",
        PINS: undefined,
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
    PINS: { put: async (_, value) => (stored = JSON.parse(value)) },
  };
  const url = "https://portal.example.com/api/certificates/" + secret;
  const req = (path) =>
    new Request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, certificates: [pin] }),
    });
  assert.equal((await worker.fetch(req(url + "wrong"), env)).status, 404);
  assert.equal((await worker.fetch(req(url), env)).status, 204);
  assert.equal(stored.certificates.length, 1);
  assert.equal(
    (
      await worker.fetch(req(url), {
        ...env,
        PINS: {
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
  const bridge = (
    await configuration({
      WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
      PINS: { get: async () => ({ version: 1, certificates: [pin] }) },
    })
  ).backend;
  assert.equal(bridge.transport, "webtransport");
  assert.equal(bridge.rootPath, "/");
  assert.equal(bridge.gatewayAuth, true);
  assert.equal(
    (
      await configuration({
        WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
        GATEWAY_AUTH: "false",
        CERTIFICATE_MODE: "webpki",
      })
    ).backend.gatewayAuth,
    false,
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
      GATEWAY_AUTH: "true",
    },
  );
  const pins = await missing.json();
  assert.equal(missing.status, 200);
  assert.equal(pins.setup.reason, "missing-certificates");
  assert.equal(pins.setup.backend.transport, "webtransport");
  assert.equal(pins.setup.backend.gatewayAuth, true);
});

test("storage outages remain errors and the public config endpoint cannot write settings", async () => {
  const env = {
    ...base,
    BACKEND_TRANSPORT: "webtransport",
    PINS: {
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
    PINS: {
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
  assert.equal((await worker.fetch(request(master), env)).status, 404);
  assert.equal(
    (
      await worker.fetch(
        request(await deriveSecret(master, "lantern-dock:other:v1")),
        env,
      )
    ).status,
    404,
  );
  assert.equal(
    (await worker.fetch(request(token), { ...env, SECRET_KEY: "n".repeat(64) }))
      .status,
    404,
  );
  assert.equal(
    (await worker.fetch(request(token), { ...env, SECRET_KEY: "short" }))
      .status,
    404,
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

test("an explicit legacy webhook credential stays valid during migration", async () => {
  const master = "m".repeat(64),
    legacy = "l".repeat(64),
    token = await deriveSecret(master, CERTIFICATE_WEBHOOK_PURPOSE);
  const env = {
    SECRET_KEY: master,
    CERT_WEBHOOK_SECRET: legacy,
    PINS: { put: async () => {} },
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
    404,
  );
});
