import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import worker from "./worker/index.js";

async function localEnvironment() {
  const env = { DEMO_MODE: "true", ...process.env };
  try {
    const vars = await readFile(
      new URL("./.dev.vars", import.meta.url),
      "utf8",
    );
    for (const line of vars.split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      env[match[1]] = value;
    }
    if (
      !("DEMO_MODE" in process.env) &&
      /BACKEND_ENDPOINT=/.test(vars) &&
      !/^DEMO_MODE=/m.test(vars)
    )
      env.DEMO_MODE = "false";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return env;
}

function connectionAPI() {
  const setup = async (server) => {
    const env = await localEnvironment();
    server.middlewares.use("/api", async (req, res, next) => {
      try {
        const method = req.method || "GET";
        const request = new Request(
          `http://localhost${req.originalUrl || "/api" + req.url}`,
          {
            method,
            headers: req.headers,
            ...(!["GET", "HEAD"].includes(method)
              ? { body: Readable.toWeb(req), duplex: "half" }
              : {}),
          },
        );
        const response = await worker.fetch(request, env, {});
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body && method !== "HEAD")
          Readable.fromWeb(response.body).pipe(res);
        else res.end();
      } catch (error) {
        next(error);
      }
    });
  };
  return {
    name: "lantern-dock-connection-api",
    configureServer: setup,
    configurePreviewServer: setup,
  };
}

export default defineConfig({
  plugins: [preact(), connectionAPI()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 8787),
    strictPort: true,
  },
  preview: { host: "127.0.0.1", port: 8787, strictPort: true },
  build: { target: "es2022" },
});
