import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Accept the wizard's JSON-quoted values and the existing single-quoted examples.
export function parseLocalVariables(source) {
  const values = {};
  for (const line of source.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'"))
      value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export async function loadLocalEnvironment(
  directory,
  environment = process.env,
) {
  // Match Wrangler: a legacy .dev.vars file takes precedence if it still exists.
  for (const name of [".dev.vars", ".env"]) {
    try {
      return {
        ...parseLocalVariables(
          await readFile(resolve(directory, name), "utf8"),
        ),
        ...environment,
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { ...environment };
}
