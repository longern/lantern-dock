import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import worker from "./worker/index.js";
import { parseLocalVariables } from "./scripts/local-env.mjs";

async function localEnvironment() {
  const env = { ...process.env };
  try {
    const vars = await readFile(
      new URL("./.dev.vars", import.meta.url),
      "utf8",
    );
    Object.assign(env, parseLocalVariables(vars));
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
