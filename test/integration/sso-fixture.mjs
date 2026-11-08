import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";

export const identitySubject = "fixture-identity-user";
export const siteIdentitySubject =
  "ld_-TYdm_tjfPUQRGnIAmmSNw";
export async function startSSO(portalOrigin, metadata) {
  const source = resolve(process.env.SSO_SOURCE || "../workers-sso");
  const require = createRequire(resolve(source, "package.json"));
  const {
    Miniflare,
    convertV4MiniflareOptions,
    Response,
  } = require("miniflare");
  const issuer = "https://sso.example";
  const secret = "fixture-only-workers-sso-secret-0123456789";
  const root = resolve(source, "dist/workers_sso");
  const files = [
    "index.js",
    ...(await readdir(resolve(root, "assets")))
      .filter((p) => p.endsWith(".js"))
      .map((p) => "assets/" + p),
  ];
  let metadataRequests = 0;
  const consent = `<!doctype html><html><body><h1>测试 SSO 授权</h1><button id="allow">允许登录 LanternDock</button><script>document.getElementById('allow').onclick=async()=>{const r=await fetch('/api/auth/oauth2/consent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accept:true,oauth_query:location.search.slice(1)})});const d=await r.json();location.assign(d.url);};</script></body></html>`;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: files.map((p) => ({ type: "ESModule", path: resolve(root, p) })),
      modulesRoot: root,
      compatibilityDate: "2026-09-19",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      bindings: { BETTER_AUTH_URL: issuer, BETTER_AUTH_SECRET: secret },
      d1Databases: ["DB"],
      serviceBindings: {
        ASSETS: () =>
          new Response(consent, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      },
      outboundService: async (request) => {
        if (request.url === portalOrigin + "/api/auth/oidc/client.json") {
          metadataRequests++;
          return Response.json(await metadata());
        }
        throw new Error("Unexpected SSO outbound request");
      },
    }),
  );
  const db = await mf.getD1Database("DB");
  const sql = await readFile(
    resolve(source, "migrations/0001_better_auth.sql"),
    "utf8",
  );
  for (const statement of sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .filter((s) => s.trim()))
    await db.prepare(statement).run();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
    )
    .bind(
      identitySubject,
      "测试用户 <b>plain text</b>",
      "fixture@example.com",
      1,
      now,
      now,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO session (id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)",
    )
    .bind(
      "fixture-session",
      now + 3600000,
      "fixture-session-token",
      now,
      now,
      identitySubject,
    )
    .run();
  const signed =
    "fixture-session-token." +
    createHmac("sha256", secret)
      .update("fixture-session-token")
      .digest("base64");
  return {
    issuer,
    async fetch(request) {
      return mf.dispatchFetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(!["GET", "HEAD"].includes(request.method)
          ? { body: await request.arrayBuffer() }
          : {}),
        redirect: "manual",
      });
    },
    async browser(context) {
      await context.addCookies([
        {
          name: "__Secure-workers-sso.session_token",
          value: encodeURIComponent(signed),
          url: issuer,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ]);
      await context.route(issuer + "/**", async (route) => {
        const request = route.request();
        const r = await mf.dispatchFetch(request.url(), {
          method: request.method(),
          headers: {
            ...(await request.allHeaders()),
            "MF-Sec-Fetch-Mode":
              request.resourceType() === "document" ? "navigate" : "cors",
          },
          ...(request.postDataBuffer()
            ? { body: request.postDataBuffer() }
            : {}),
          redirect: "manual",
        });
        const headers = Object.fromEntries(r.headers);
        delete headers["set-cookie"];
        await route.fulfill({
          status: r.status,
          headers,
          body: Buffer.from(await r.arrayBuffer()),
        });
      });
    },
    get metadataRequests() {
      return metadataRequests;
    },
    stop: () => mf.dispose(),
  };
}
