import test from "node:test";
import assert from "node:assert/strict";
import { setupVariables, setupSnippet } from "../src/lib/setup.js";
import { parseLocalVariables } from "../scripts/local-env.mjs";

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
  assert.equal(vars.BACKEND_ROOT, "/dav/%E7%85%A7%E7%89%87/");
  assert.equal(vars.DEMO_MODE, "false");
  assert.deepEqual(parseLocalVariables(setupSnippet(vars, "local")), vars);
  assert.deepEqual(JSON.parse(setupSnippet(vars, "worker")), { vars });
  assert.ok(!JSON.stringify(vars).includes("private-"));
});

test("setup validates addresses and paths before offering configuration", () => {
  for (const bad of [
    { endpoint: "not-a-url" },
    { endpoint: "https://user:secret@files.example.com" },
    { endpoint: "https://files.example.com/dav/" },
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
  assert.equal(vars.GATEWAY_AUTH, "true");
  assert.equal(vars.CERTIFICATE_MODE, "webpki");
  assert.equal(
    setupVariables({ ...base, gatewayAuth: true }).GATEWAY_AUTH,
    "false",
  );
  assert.equal(setupVariables(base).CERTIFICATE_MODE, undefined);
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
