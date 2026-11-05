import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, extname } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { X509Certificate, createHash } from "node:crypto";
import worker from "../../worker/index.js";
import {
  deriveSecret,
  CERTIFICATE_WEBHOOK_PURPOSE,
} from "../../worker/secrets.js";

const exec = promisify(execFile);
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const gatewayToken = "fixture-gateway-token";
export const backendToken = "fixture-backend-token";
export const textFile =
  "LanternDock → real WebTransport bridge → WebDAV\n中文路径与流式传输。\n";
const picture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#cbdedb"/><circle cx="900" cy="180" r="80" fill="#f4cd88"/></svg>';
const items = [
  { name: "照片", folder: true },
  { name: "hello.txt", data: textFile, mime: "text/plain; charset=utf-8" },
  { name: "coast.svg", data: picture, mime: "image/svg+xml" },
  { name: "chunked.txt", data: textFile, mime: "text/plain", chunked: true },
  {
    name: "slow.bin",
    size: 64 * 1024 * 1024,
    mime: "application/octet-stream",
  },
];
const xml = (path) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[{ name: "", folder: true }, ...items].map((item) => `<d:response><d:href>${path}${encodeURIComponent(item.name)}${item.folder && item.name ? "/" : ""}</d:href><d:propstat><d:prop><d:resourcetype>${item.folder ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${item.size || Buffer.byteLength(item.data || "")}</d:getcontentlength><d:getlastmodified>Wed, 04 Nov 2026 08:30:00 GMT</d:getlastmodified><d:getcontenttype>${item.mime || ""}</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`;

export async function startFixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "lantern-bridge-test-"));
  const source = resolve(process.env.BRIDGE_SOURCE || "../webtransport-bridge");
  const go = process.env.GO_BIN || "go";
  const requests = [],
    cancellations = [],
    pins = new Map();
  let processBridge, frontend, backend;
  let logs = "";
  const stop = async () => {
    if (processBridge && processBridge.exitCode === null) {
      const exited = new Promise((resolve) =>
        processBridge.once("exit", resolve),
      );
      processBridge.kill("SIGTERM");
      await exited;
    }
    if (frontend) await close(frontend);
    if (backend) await close(backend);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    // Resolve dependencies in a disposable modfile, keeping the sibling checkout intact.
    const modfile = resolve(directory, "bridge.go.mod");
    await writeFile(modfile, await readFile(resolve(source, "go.mod")));
    const binary = process.env.BRIDGE_BIN || resolve(directory, "bridge");
    if (!process.env.BRIDGE_BIN)
      await exec(
        go,
        [
          "build",
          "-mod=mod",
          "-modfile",
          modfile,
          "-o",
          binary,
          "./cmd/bridge",
        ],
        { cwd: source },
      );
    const certDirectory = resolve(directory, "frontend-certs");
    await exec(
      go,
      [
        "run",
        "-mod=mod",
        "-modfile",
        modfile,
        "./cmd/certgen",
        "--host",
        "localhost",
        "--out",
        certDirectory,
      ],
      { cwd: source },
    );
    backend = http.createServer(async (req, res) => {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(body).toString(),
      });
      if (req.headers.authorization !== `Bearer ${backendToken}`) {
        res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="fixture"' });
        res.end("Backend login required");
        return;
      }
      if (req.method === "PROPFIND") {
        res.writeHead(207, { "Content-Type": "application/xml" });
        res.end(xml(req.url));
        return;
      }
      const name = decodeURIComponent(req.url.split("/").pop());
      const item = items.find((item) => item.name === name);
      if (!item || item.folder) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (name === "slow.bin") {
        res.writeHead(200, {
          "Content-Type": item.mime,
          "Content-Length": item.size,
        });
        let sent = 0;
        const timer = setInterval(() => {
          sent += 65536;
          res.write(Buffer.alloc(65536, 42));
          if (sent >= item.size) {
            clearInterval(timer);
            res.end();
          }
        }, 20);
        res.on("close", () => {
          clearInterval(timer);
          if (!res.writableFinished) cancellations.push(req.url);
        });
        return;
      }
      const data = Buffer.from(item.data);
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
      if (range) {
        const start = Number(range[1]),
          end = Math.min(Number(range[2]), data.length - 1);
        res.writeHead(206, {
          "Content-Type": item.mime,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${data.length}`,
        });
        res.end(data.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, {
        "Content-Type": item.mime,
        ...(!item.chunked ? { "Content-Length": data.length } : {}),
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      if (item.chunked) {
        res.write(data.subarray(0, 7));
        setTimeout(() => res.end(data.subarray(7)), 30);
      } else res.end(data);
    });
    await listen(backend);
    const udp = dgram.createSocket("udp4");
    await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
    const bridgePort = udp.address().port;
    await new Promise((resolve) => udp.close(resolve));
    const endpoint = `https://127.0.0.1:${bridgePort}/webtransport`;
    const masterKey = "fixture-site-secret-key-0123456789abcdef";
    const secret = await deriveSecret(masterKey, CERTIFICATE_WEBHOOK_PURPOSE);
    const env = {
      BACKEND_NAME: "Bridge 测试资源",
      BACKEND_TRANSPORT: "webtransport",
      BACKEND_ENDPOINT: endpoint,
      BACKEND_ROOT: "/public/",
      BACKEND_AUTH: "bearer",
      GATEWAY_AUTH: "true",
      SECRET_KEY: masterKey,
      KV: {
        async get(key) {
          return pins.has(key) ? JSON.parse(pins.get(key)) : null;
        },
        async put(key, value) {
          pins.set(key, value);
        },
      },
    };
    frontend = https.createServer(
      {
        key: await readFile(resolve(certDirectory, "key.pem")),
        cert: await readFile(resolve(certDirectory, "cert.pem")),
      },
      async (req, res) => {
        try {
          if (req.url.startsWith("/__test/lib/")) {
            const name = req.url.slice("/__test/lib/".length);
            if (!["transport.js", "dav.js", "http-wire.js"].includes(name)) {
              res.writeHead(404);
              res.end();
              return;
            }
            res.writeHead(200, { "Content-Type": "text/javascript" });
            res.end(await readFile(resolve("src/lib", name)));
            return;
          }
          const method = req.method || "GET";
          const request = new Request(
            `https://localhost:${frontend.address().port}${req.url}`,
            {
              method,
              headers: req.headers,
              ...(!["GET", "HEAD"].includes(method)
                ? { body: Readable.toWeb(req), duplex: "half" }
                : {}),
            },
          );
          env.ASSETS = {
            async fetch(request) {
              const pathname = decodeURIComponent(
                new URL(request.url).pathname,
              );
              const file = resolve(
                "dist",
                "." + (pathname === "/" ? "/index.html" : pathname),
              );
              if (!file.startsWith(resolve("dist") + "/"))
                return new Response("Not found", { status: 404 });
              try {
                return new Response(await readFile(file), {
                  headers: {
                    "Content-Type":
                      {
                        ".html": "text/html",
                        ".js": "text/javascript",
                        ".css": "text/css",
                      }[extname(file)] || "application/octet-stream",
                  },
                });
              } catch {
                return new Response("Not found", { status: 404 });
              }
            },
          };
          const response = await worker.fetch(request, env, {});
          res.writeHead(response.status, Object.fromEntries(response.headers));
          if (response.body) Readable.fromWeb(response.body).pipe(res);
          else res.end();
        } catch (error) {
          res.writeHead(500);
          res.end(error.message);
        }
      },
    );
    await listen(frontend);
    const origin = `https://localhost:${frontend.address().port}`;
    processBridge = spawn(
      binary,
      [
        `--listen=127.0.0.1:${bridgePort}`,
        `--backend=http://127.0.0.1:${backend.address().port}`,
        `--origins=${origin}`,
        "--paths=/public",
        "--methods=GET,HEAD,PROPFIND",
        `--cert=${resolve(certDirectory, "cert.pem")}`,
        `--key=${resolve(certDirectory, "key.pem")}`,
      ],
      {
        env: { ...process.env, BRIDGE_TOKEN: gatewayToken },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    processBridge.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    processBridge.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    const certPEM = await readFile(resolve(certDirectory, "cert.pem"));
    const certificate = new X509Certificate(certPEM);
    const payload = JSON.stringify({
      version: 1,
      certificates: [
        {
          algorithm: "sha-256",
          value: createHash("sha256").update(certificate.raw).digest("base64"),
          notBefore: new Date(certificate.validFrom).toISOString(),
          notAfter: new Date(certificate.validTo).toISOString(),
        },
      ],
    });
    // Supply the fixture CA only to this webhook client; no system trust changes.
    const webhookStatus = await new Promise((resolve, reject) => {
      const request = https.request(
        `${origin}/api/certificates/${secret}`,
        {
          method: "PUT",
          ca: certPEM,
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end(payload);
    });
    if (webhookStatus !== 204 || !pins.size)
      throw new Error("Certificate webhook did not confirm storage");
    for (
      let attempt = 0;
      !logs.includes("listening on UDP") && attempt < 50;
      attempt++
    ) {
      if (processBridge.exitCode !== null) throw new Error(logs);
      await sleep(100);
    }
    return {
      origin,
      endpoint,
      env,
      pins,
      requests,
      cancellations,
      stop,
      get logs() {
        return logs;
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
