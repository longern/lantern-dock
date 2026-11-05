import test from "node:test";
import assert from "node:assert/strict";
import { setupVariables, setupSnippet } from "../src/lib/setup.js";
import { parseLocalVariables } from "../scripts/local-env.mjs";
import { configuration } from "../worker/index.js";

const base = {
  name: "我的文件",
  transport: "http",
  endpoint: "https://files.example.com",
  rootPath: "/dav/",
  auth: "none",
  gatewayAuth: false,
  certificateMode: "pinned",
};

test("setup generates equivalent local and Worker settings without secrets", () => {
  const vars = setupVariables({
    ...base,
    name: `My "files" 'box' \\ home`,
    rootPath: "/dav/照片",
    auth: "basic",
    password: "private-password",
    gatewayToken: "private-token",
  });
  assert.equal(
    vars.WEBDAV_URL,
    "https://files.example.com/dav/%E7%85%A7%E7%89%87/",
  );
  assert.equal(vars.DEMO_MODE, undefined);
  assert.equal(vars.BACKEND_ROOT, undefined);
  assert.deepEqual(parseLocalVariables(setupSnippet(vars, "local")), vars);
  assert.deepEqual(JSON.parse(setupSnippet(vars, "worker")), { vars });
  assert.ok(!JSON.stringify(vars).includes("private-"));
});

test("setup validates addresses and paths before offering configuration", () => {
  for (const bad of [
    { endpoint: "not-a-url" },
    { endpoint: "https://user:secret@files.example.com" },
    { endpoint: "https://files.example.com/?token=secret" },
    { rootPath: "/dav/../private/" },
    { rootPath: "/dav/%2fprivate" },
    { name: "name\nBACKEND_AUTH=none" },
    { transport: "unknown" },
    { auth: "unknown" },
  ])
    assert.throws(() => setupVariables({ ...base, ...bad }));
  assert.throws(() =>
    setupVariables({
      ...base,
      transport: "webtransport",
      endpoint: "http://bridge.example.com/webtransport",
    }),
  );
});

test("WebTransport setup includes gateway and certificate choices only when relevant", () => {
  const vars = setupVariables({
    ...base,
    transport: "webtransport",
    endpoint: "https://bridge.example.com:4433/webtransport",
    gatewayAuth: true,
    certificateMode: "webpki",
  });
  assert.equal(vars.GATEWAY_AUTH, undefined);
  assert.equal(vars.CERTIFICATE_MODE, "webpki");
  assert.equal(
    setupVariables({ ...base, gatewayAuth: true }).GATEWAY_AUTH,
    undefined,
  );
  assert.equal(setupVariables(base).CERTIFICATE_MODE, undefined);
});

test("a default WebDAV setup generates just one variable and resolves its root", async () => {
  const vars = setupVariables({
    ...base,
    rootPath: "",
    endpoint: "https://files.example.com/dav/public/",
  });
  assert.deepEqual(vars, {
    WEBDAV_URL: "https://files.example.com/dav/public/",
  });
  const { backend } = await configuration(vars);
  assert.equal(backend.endpoint, "https://files.example.com");
  assert.equal(backend.rootPath, "/dav/public/");
  assert.equal(backend.name, "我的文件");
  assert.equal(backend.auth, "none");
});

test("explicit resets clear the other URL and old overrides when applying generated settings", async () => {
  const previous = {
    WEBTRANSPORT_URL: "https://old.example.com/webtransport",
    BACKEND_ROOT: "/old/",
    BACKEND_AUTH: "bearer",
    BACKEND_NAME: "Old name",
    GATEWAY_AUTH: "false",
  };
  const vars = setupVariables(
    { ...base, rootPath: "", endpoint: "https://files.example.com/public/" },
    Object.keys(previous),
  );
  assert.equal(vars.WEBTRANSPORT_URL, "");
  assert.equal(vars.BACKEND_ROOT, "");
  assert.equal(vars.BACKEND_AUTH, "none");
  assert.equal(vars.BACKEND_NAME, "我的文件");
  const { backend } = await configuration({ ...previous, ...vars });
  assert.equal(backend.transport, "http");
  assert.equal(backend.rootPath, "/public/");
  assert.equal(backend.auth, "none");
});

test("non-default WebTransport public mode is explicit while pinned certificates use the default", () => {
  const vars = setupVariables({
    ...base,
    transport: "webtransport",
    endpoint: "https://bridge.example.com/webtransport",
    rootPath: "/",
    gatewayAuth: true,
  });
  assert.deepEqual(vars, {
    WEBTRANSPORT_URL: "https://bridge.example.com/webtransport",
  });
  assert.equal(
    setupVariables({ ...base, transport: "webtransport", gatewayAuth: false })
      .GATEWAY_AUTH,
    "false",
  );
});

test("local variables preserve existing quoted certificate JSON examples", () => {
  const document = '{"version":1,"certificates":[]}';
  assert.deepEqual(
    parseLocalVariables(
      `# comment\nCERTIFICATES_JSON='${document}'\nBACKEND_ROOT="/dav/"\n`,
    ),
    { CERTIFICATES_JSON: document, BACKEND_ROOT: "/dav/" },
  );
});
