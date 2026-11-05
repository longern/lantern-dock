import { randomBytes } from "node:crypto";
import {
  open,
  readFile,
  appendFile,
  rename,
  chmod,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { parseLocalVariables } from "./local-env.mjs";
import { validateSecretKey } from "../worker/secrets.js";

async function optionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function initializeEnvironment(
  directory = process.cwd(),
  environment = process.env,
) {
  const path = resolve(directory, ".env"),
    legacyPath = resolve(directory, ".dev.vars"),
    lockPath = resolve(directory, ".env.init.lock");
  let lock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!lock)
    throw new Error(
      "Another initialization is running; check .env.init.lock if it was interrupted.",
    );
  try {
    let source = await optionalFile(path);
    const legacy = await optionalFile(legacyPath);
    if (source !== undefined && legacy !== undefined)
      throw new Error(
        "Both .env and .dev.vars exist. Merge the settings into .env and remove .dev.vars before initialization.",
      );
    let migrated = false;
    if (source === undefined && legacy !== undefined) {
      await rename(legacyPath, path);
      source = legacy;
      migrated = true;
    }
    const values = parseLocalVariables(source || "");
    let created = false;
    if (Object.hasOwn(values, "SECRET_KEY"))
      validateSecretKey(values.SECRET_KEY);
    else {
      values.SECRET_KEY = validateSecretKey(
        environment.SECRET_KEY ?? randomBytes(32).toString("hex"),
      );
      const prefix = source && !source.endsWith("\n") ? "\n" : "";
      await appendFile(
        path,
        prefix + "SECRET_KEY=" + JSON.stringify(values.SECRET_KEY) + "\n",
        { mode: 0o600 },
      );
      created = true;
    }
    await chmod(path, 0o600);
    return {
      key: validateSecretKey(environment.SECRET_KEY ?? values.SECRET_KEY),
      created,
      migrated,
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
