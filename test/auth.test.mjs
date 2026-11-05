import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  decodeJwt,
  createLocalJWKSet,
  jwtVerify,
  calculateJwkThumbprint,
} from "jose";
import worker from "../worker/index.js";

const site = "https://portal.example";
const issuer = "https://sso.example";
const encoder = new TextEncoder();
const encode = (bytes) => Buffer.from(bytes).toString("base64url");
async function fixture() {
  const providerKey = await generateKeyPair("EdDSA");
  const publicKey = await exportJWK(providerKey.publicKey);
  publicKey.kid = "sso";
  const env = {
    SITE_ORIGIN: site,
    OIDC_ISSUER_URL: issuer,
    SECRET_KEY: "test-master-key-0123456789abcdef-0123456789",
    ASSETS: {
      async fetch() {
        return new Response("<html>app</html>");
      },
    },
  };
  let flow;
  let patch = {};
  let profile = { sub: "test-user", name: "<script>not HTML</script>" };
  let calls = 0;
  let validCode = true;
  env.SSO_SERVICE = {
    async fetch(request) {
      calls++;
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          client_id_metadata_document_supported: true,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/keys",
          userinfo_endpoint: issuer + "/userinfo",
          code_challenge_methods_supported: ["S256"],
        });
      if (path === "/keys") return Response.json({ keys: [publicKey] });
      if (path === "/userinfo") {
        assert.equal(
          request.headers.get("Authorization"),
          "Bearer never-return-this-to-browser",
        );
        return Response.json(profile);
      }
      if (path === "/token") {
        const params = new URLSearchParams(await request.text());
        assert.equal(
          params.get("client_id"),
          site + "/api/auth/oidc/client.json",
        );
        assert.equal(params.get("redirect_uri"), site + "/auth/callback");
        assert.equal(params.get("client_secret"), null);
        const hash = encode(
          await crypto.subtle.digest(
            "SHA-256",
            encoder.encode(params.get("code_verifier")),
          ),
        );
        assert.equal(hash, flow.get("code_challenge"));
        if (!validCode || params.get("code") !== "one-time-code")
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        validCode = false;
        const id_token = await new SignJWT({
          nonce: flow.get("nonce"),
          name: "<script>not HTML</script>",
          ...patch,
        })
          .setProtectedHeader({ alg: "EdDSA", kid: "sso" })
          .setIssuer(issuer)
          .setSubject("test-user")
          .setAudience(site + "/api/auth/oidc/client.json")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(providerKey.privateKey);
        return Response.json({
          id_token,
          access_token: "never-return-this-to-browser",
          token_type: "Bearer",
        });
      }
      throw new Error("Unexpected SSO request");
    },
  };
  const pair = await generateKeyPair("ES256");
  const publicProof = await exportJWK(pair.publicKey);
  async function proof(path, other = pair) {
    const jwk = other === pair ? publicProof : await exportJWK(other.publicKey);
    return new SignJWT({
      htm: "POST",
      htu: site + path,
      jti: crypto.randomUUID(),
    })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .setIssuedAt()
      .sign(other.privateKey);
  }
  const jar = new Map();
  async function request(
    path,
    { method = "GET", headers = {}, cookie = true } = {},
  ) {
    const response = await worker.fetch(
      new Request(site + path, {
        method,
        headers: {
          ...(method === "POST" ? { Origin: site } : {}),
          ...(cookie
            ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }
            : {}),
          ...headers,
        },
      }),
      env,
    );
    for (const value of response.headers.getSetCookie()) {
      const [name, data] = value.split(";", 1)[0].split("=");
      if (data) jar.set(name, data);
      else jar.delete(name);
    }
    return response;
  }
  async function begin() {
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { DPoP: await proof("/api/auth/login") },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const value = await response.json();
    flow = new URL(value.url).searchParams;
    return response;
  }
  async function login() {
    await begin();
    return request(
      "/auth/callback?" +
        new URLSearchParams({
          state: flow.get("state"),
          code: "one-time-code",
          iss: issuer,
        }),
    );
  }
  return {
    env,
    jar,
    request,
    begin,
    login,
    proof,
    pair,
    publicProof,
    patch: (value) => {
      patch = value;
    },
    profile: (value) => {
      profile = value;
    },
    flow: () => flow,
    calls: () => calls,
  };
}

test("CIMD describes the app, and site cookies are encrypted, HttpOnly and separate from NAS grants", async () => {
  const f = await fixture();
  const metadata = await (await f.request("/api/auth/oidc/client.json")).json();
  assert.equal(metadata.client_id, site + "/api/auth/oidc/client.json");
  assert.deepEqual(metadata.redirect_uris, [site + "/auth/callback"]);
  assert.equal(metadata.token_endpoint_auth_method, "none");
  assert.ok(!JSON.stringify(metadata).includes(f.env.SECRET_KEY));
  const response = await f.login();
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), site + "/#/account");
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const value of cookies) {
    assert.match(value, /HttpOnly; Secure; SameSite=Lax/);
    assert.match(value, /Path=\//);
    assert.ok(!value.includes("test-user"));
  }
  const session = await (await f.request("/api/auth/session")).json();
  assert.equal(session.user.sub, "test-user");
  assert.equal(session.authenticated, true);
  assert.ok(!("accessToken" in session));
  const token = await (
    await f.request("/api/auth/token", {
      method: "POST",
      headers: { DPoP: await f.proof("/api/auth/token") },
    })
  ).json();
  const jwks = await (await f.request("/api/auth/jwks.json")).json();
  assert.ok(!JSON.stringify(jwks).includes('"d"'));
  const verified = await jwtVerify(token.accessToken, createLocalJWKSet(jwks), {
    issuer: site,
    audience: site + "/nas",
    algorithms: ["EdDSA"],
  });
  assert.equal(verified.payload.sub, "test-user");
  assert.equal(verified.payload.identity_issuer, issuer);
  assert.equal(
    verified.payload.cnf.jkt,
    await calculateJwkThumbprint(f.publicProof),
  );
  assert.equal(verified.payload.exp - verified.payload.iat, 60);
  assert.ok(!JSON.stringify(token).includes("never-return-this-to-browser"));
  const calls = f.calls();
  await f.request("/api/auth/token", {
    method: "POST",
    headers: { DPoP: await f.proof("/api/auth/token") },
  });
  assert.equal(f.calls(), calls, "grant renewal must not call SSO");
});
test("login binds state, nonce, PKCE and provider; a copied grant cannot renew a session", async () => {
  const f = await fixture();
  await f.begin();
  let response = await f.request(
    "/auth/callback?state=wrong&code=one-time-code",
  );
  assert.equal(response.status, 303);
  assert.ok(response.headers.get("Location").includes("error="));
  assert.equal(
    (await (await f.request("/api/auth/session")).json()).authenticated,
    false,
  );
  await f.begin();
  f.patch({ nonce: "wrong" });
  response = await f.request(
    "/auth/callback?" +
      new URLSearchParams({
        state: f.flow().get("state"),
        code: "one-time-code",
      }),
  );
  assert.ok(response.headers.get("Location").includes("error="));
  const good = await fixture();
  await good.login();
  const other = await generateKeyPair("ES256");
  response = await good.request("/api/auth/token", {
    method: "POST",
    headers: { DPoP: await good.proof("/api/auth/token", other) },
  });
  assert.equal(response.status, 401);
  response = await good.request("/api/auth/token", {
    method: "POST",
    cookie: false,
    headers: { DPoP: await good.proof("/api/auth/token") },
  });
  assert.equal(response.status, 401);
  response = await good.request("/api/auth/logout", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(response.status, 403);
  response = await good.request("/api/auth/login", {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
      DPoP: await good.proof("/api/auth/login"),
    },
  });
  assert.equal(response.status, 403);
  await good.request("/api/auth/logout", { method: "POST" });
  assert.equal(
    (await (await good.request("/api/auth/session")).json()).authenticated,
    false,
  );
});
test("expired and tampered session cookies fail closed; secret rotation changes signing keys", async (t) => {
  const f = await fixture();
  await f.login();
  const original = f.jar.get("__Host-lantern-session");
  f.jar.set("__Host-lantern-session", original + "a");
  assert.equal(
    (await (await f.request("/api/auth/session")).json()).authenticated,
    false,
  );
  f.jar.set("__Host-lantern-session", original);
  const key = await (await f.request("/api/auth/jwks.json")).json();
  const rotated = {
    ...f.env,
    SECRET_KEY: "a-different-master-key-0123456789abcdef",
  };
  const response = await worker.fetch(
    new Request(site + "/api/auth/jwks.json"),
    rotated,
  );
  assert.notEqual((await response.json()).keys[0].kid, key.keys[0].kid);
  const timestamp = Date.now();
  t.mock.method(Date, "now", () => timestamp + 31 * 60 * 1000);
  assert.equal(
    (await (await f.request("/api/auth/session")).json()).authenticated,
    false,
  );
});
test("UserInfo is fetched server-side and must match the verified ID token subject", async () => {
  const good = await fixture();
  good.profile({
    sub: "test-user",
    name: "Profile name",
    email: "user@example.com",
  });
  await good.login();
  const session = await (await good.request("/api/auth/session")).json();
  assert.equal(session.user.name, "Profile name");
  assert.equal(session.user.email, "user@example.com");
  const bad = await fixture();
  bad.profile({ sub: "someone-else", name: "Wrong identity" });
  const response = await bad.login();
  assert.ok(response.headers.get("Location").includes("error="));
  assert.equal(
    (await (await bad.request("/api/auth/session")).json()).authenticated,
    false,
  );
});
test("portal responses prevent inline scripts and browser credential configuration is explicit", async () => {
  const f = await fixture();
  const response = await f.request("/");
  assert.match(
    response.headers.get("Content-Security-Policy"),
    /script-src 'self'/,
  );
  assert.ok(
    !response.headers.get("Content-Security-Policy").includes("unsafe-eval"),
  );
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  const disabled = await worker.fetch(
    new Request(site + "/api/auth/session"),
    {},
  );
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).code, "AUTH_NOT_CONFIGURED");
  const mismatch = await worker.fetch(
    new Request("https://other.example/api/auth/oidc/client.json"),
    f.env,
  );
  assert.equal(mismatch.status, 400);
});
