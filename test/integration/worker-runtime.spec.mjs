import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

test("the LanternDock Worker discovers OIDC in workerd and rejects redirects", async () => {
  const source = resolve(process.env.SSO_SOURCE || "../workers-sso");
  const require = createRequire(resolve(source, "package.json"));
  const { build } = require("esbuild");
  const { experimental_readRawConfig } = require("wrangler");
  const { rawConfig } = experimental_readRawConfig({
    config: "wrangler.jsonc",
  });
  const {
    Miniflare,
    convertV4MiniflareOptions,
    Response,
  } = require("miniflare");
  const directory = await mkdtemp(resolve(tmpdir(), "lantern-worker-runtime-"));
  const file = resolve(directory, "worker.mjs");
  const site = "https://portal.example";
  const issuer = "https://sso.example";
  try {
    await build({
      entryPoints: ["worker/index.js"],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outfile: file,
      logLevel: "error",
    });
    for (const status of [200, 302]) {
      const requests = [];
      const mf = new Miniflare(
        convertV4MiniflareOptions({
          modules: [{ type: "ESModule", path: file }],
          modulesRoot: directory,
          // Match the sibling fixture's installed workerd; use deployment flags.
          compatibilityDate: "2026-09-19",
          compatibilityFlags: rawConfig.compatibility_flags,
          bindings: {
            SECRET_KEY: "fixture-only-master-key-0123456789abcdef",
            OIDC_ISSUER_URL: issuer,
          },
          outboundService(request) {
            requests.push(request.url);
            if (status === 302)
              return new Response(null, {
                status,
                headers: { Location: "https://attacker.example/discovery" },
              });
            return Response.json({
              issuer,
              authorization_endpoint: issuer + "/authorize",
              token_endpoint: issuer + "/token",
              jwks_uri: issuer + "/keys",
              client_id_metadata_document_supported: true,
              code_challenge_methods_supported: ["S256"],
            });
          },
        }),
      );
      try {
        const { publicKey, privateKey } = await generateKeyPair("ES256");
        const proof = await new SignJWT({
          htm: "POST",
          htu: site + "/api/auth/login",
          jti: crypto.randomUUID(),
        })
          .setProtectedHeader({
            alg: "ES256",
            typ: "dpop+jwt",
            jwk: await exportJWK(publicKey),
          })
          .setIssuedAt()
          .sign(privateKey);
        const response = await mf.dispatchFetch(site + "/api/auth/login", {
          method: "POST",
          headers: {
            Origin: site,
            DPoP: proof,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ returnTo: "/account" }),
        });
        const body = await response.json();
        if (status === 200) {
          expect(response.status, body.code ?? body.error).toBe(200);
          const target = new URL(body.url);
          expect(target.origin).toBe(issuer);
          expect(target.searchParams.get("redirect_uri")).toBe(
            site + "/auth/callback",
          );
          expect(response.headers.get("set-cookie")).toContain(
            "__Host-lantern-oidc=",
          );
        } else {
          expect(response.status).toBe(503);
          expect(body.code).toBe("OIDC_DISCOVERY_HTTP_ERROR");
          expect(body.error).toContain("HTTP 302");
          expect(response.headers.get("set-cookie")).toBeNull();
        }
        expect(requests).toEqual([
          issuer + "/.well-known/openid-configuration",
        ]);
      } finally {
        await mf.dispose();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
