import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(mjs|js)$/.test(file)) {
      const r = spawnSync(process.execPath, ["--check", file], {
        stdio: "inherit",
      });
      if (r.status) process.exit(r.status);
    }
  }
}
await walk("src");
await walk("shared");
await walk("worker");
await walk("scripts");
await walk("test");
const html = await readFile("index.html", "utf8");
for (const asset of ["/src/main.jsx"])
  if (!html.includes(asset)) throw new Error("Missing frontend asset " + asset);
console.log("JavaScript syntax and frontend entry points verified.");
