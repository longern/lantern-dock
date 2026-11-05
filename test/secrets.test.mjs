import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  deriveSecret,
  CERTIFICATE_WEBHOOK_PURPOSE,
} from "../worker/secrets.js";
import { initializeEnvironment } from "../scripts/site-key.mjs";
import {
  parseLocalVariables,
  loadLocalEnvironment,
} from "../scripts/local-env.mjs";

const exec = promisify(execFile),
  root = fileURLToPath(new URL("../", import.meta.url));
const master = "a".repeat(64);
async function directory(t) {
  const path = await mkdtemp(resolve(tmpdir(), "lantern-secret-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function cleanEnv() {
  const env = { ...process.env };
  delete env.SECRET_KEY;
  return env;
}

test("purpose-specific tokens match HMAC-SHA256 and do not disclose the master key", async () => {
  const token = await deriveSecret(master, CERTIFICATE_WEBHOOK_PURPOSE);
  assert.equal(
    token,
    createHmac("sha256", master)
      .update(CERTIFICATE_WEBHOOK_PURPOSE)
      .digest("hex"),
  );
  assert.equal(await deriveSecret(master, CERTIFICATE_WEBHOOK_PURPOSE), token);
  assert.notEqual(
    await deriveSecret(master, "lantern-dock:another-purpose:v1"),
    token,
  );
  assert.notEqual(
    await deriveSecret("b".repeat(64), CERTIFICATE_WEBHOOK_PURPOSE),
    token,
  );
  assert.notEqual(token, master);
  await assert.rejects(deriveSecret("short", CERTIFICATE_WEBHOOK_PURPOSE));
});

test("initialization appends a private persistent key without replacing existing settings", async (t) => {
  const path = await directory(t),
    source =
      '# Existing configuration\nWEBDAV_URL="https://files.example.com/dav/"';
  await writeFile(resolve(path, ".env"), source);
  const first = await initializeEnvironment(path, {}),
    contents = await readFile(resolve(path, ".env"), "utf8");
  assert.match(first.key, /^[a-f0-9]{64}$/);
  assert.ok(contents.startsWith(source + "\n"));
  assert.equal(parseLocalVariables(contents).SECRET_KEY, first.key);
  assert.equal(first.created, true);
  const again = await initializeEnvironment(path, {});
  assert.equal(again.key, first.key);
  assert.equal(again.created, false);
  assert.equal(await readFile(resolve(path, ".env"), "utf8"), contents);
  assert.equal((await stat(resolve(path, ".env"))).mode & 0o777, 0o600);
  await assert.rejects(access(resolve(path, ".env.init.lock")), {
    code: "ENOENT",
  });
});

test("simultaneous initializers share one key and independent sites get different keys", async (t) => {
  const path = await directory(t),
    other = await directory(t);
  const [one, two] = await Promise.all([
    initializeEnvironment(path, {}),
    initializeEnvironment(path, {}),
  ]);
  assert.equal(one.key, two.key);
  assert.equal(
    (await readFile(resolve(path, ".env"), "utf8")).match(/^SECRET_KEY=/gm)
      .length,
    1,
  );
  assert.notEqual((await initializeEnvironment(other, {})).key, one.key);
});

test("initialization migrates a sole .dev.vars file and refuses ambiguous or invalid settings", async (t) => {
  const path = await directory(t);
  await writeFile(
    resolve(path, ".dev.vars"),
    'WEBDAV_URL="https://files.example.com"\n',
  );
  const migrated = await initializeEnvironment(path, {});
  assert.equal(migrated.migrated, true);
  await assert.rejects(access(resolve(path, ".dev.vars")), { code: "ENOENT" });
  await writeFile(resolve(path, ".dev.vars"), 'BACKEND_ROOT="/legacy/"\n');
  const unchanged = await readFile(resolve(path, ".env"), "utf8");
  await assert.rejects(
    initializeEnvironment(path, {}),
    /Both .env and .dev.vars/,
  );
  assert.equal(await readFile(resolve(path, ".env"), "utf8"), unchanged);
  const invalid = await directory(t);
  await writeFile(resolve(invalid, ".env"), 'SECRET_KEY="short"\n');
  await assert.rejects(initializeEnvironment(invalid, {}), /SECRET_KEY/);
  assert.equal(
    await readFile(resolve(invalid, ".env"), "utf8"),
    'SECRET_KEY="short"\n',
  );
});

test("local runtime loads .env with process overrides and retains Wrangler legacy precedence", async (t) => {
  const path = await directory(t);
  await writeFile(
    resolve(path, ".env"),
    `SECRET_KEY="${master}"\nWEBDAV_URL="https://files.example.com/dav/"\n`,
  );
  assert.equal((await loadLocalEnvironment(path, {})).SECRET_KEY, master);
  assert.equal(
    (
      await loadLocalEnvironment(path, {
        WEBDAV_URL: "https://override.example.com",
      })
    ).WEBDAV_URL,
    "https://override.example.com",
  );
  await writeFile(
    resolve(path, ".dev.vars"),
    'WEBDAV_URL="https://legacy.example.com"\n',
  );
  assert.equal(
    (await loadLocalEnvironment(path, {})).WEBDAV_URL,
    "https://legacy.example.com",
  );
  assert.equal((await loadLocalEnvironment(path, {})).SECRET_KEY, undefined);
});

test("CLI reuses .env and prints only a derived URL unless secret output is explicitly requested", async (t) => {
  const path = await directory(t),
    options = { cwd: path, env: cleanEnv() };
  const init = await exec(
    process.execPath,
    [resolve(root, "scripts/init.mjs")],
    options,
  );
  const key = parseLocalVariables(
    await readFile(resolve(path, ".env"), "utf8"),
  ).SECRET_KEY;
  assert.ok(!init.stdout.includes(key));
  assert.ok(!init.stderr.includes(key));
  const args = [
    resolve(root, "scripts/webhook.mjs"),
    "https://dock.example.com",
  ];
  const first = await exec(process.execPath, args, options),
    again = await exec(process.execPath, args, options);
  assert.equal(first.stdout, again.stdout);
  assert.equal(
    first.stdout.trim(),
    `https://dock.example.com/api/certificates/${await deriveSecret(key, CERTIFICATE_WEBHOOK_PURPOSE)}`,
  );
  assert.ok(!first.stdout.includes(key));
  const printed = await exec(
    process.execPath,
    [resolve(root, "scripts/init.mjs"), "--print-secret"],
    options,
  );
  assert.equal(printed.stdout.trim(), key);
});
