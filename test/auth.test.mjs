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
import {
  AUTHORIZATION_METADATA_PATH,
  SESSION_GRANT_TYPE,
  ACCOUNT_SCOPE,
  NAS_SCOPES,
} from "../shared/identity-protocol.js";
import { certificateWebhookTokens } from "../worker/secrets.js";
import { deriveSecret } from "../shared/site-secret.js";
import { siteSubject, validSiteSubject } from "../worker/site-identity.js";

const site = "https://portal.example";
const issuer = "https://sso.example";
const expectedSiteSubject = "ld_1KzSHPuTIpRkcYiSJTXRlA";
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
      assert.equal(
        request.redirect,
        "manual",
        "OIDC requests must reject redirects with a Workers-supported mode",
      );
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
  async function proof(path, other = pair, patch = {}) {
    const jwk = other === pair ? publicProof : await exportJWK(other.publicKey);
    return new SignJWT({
      htm: "POST",
      htu: site + path,
      jti: crypto.randomUUID(),
      ...patch,
    })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .setIssuedAt()
      .sign(other.privateKey);
  }
  const jar = new Map();
  async function request(
    path,
    { method = "GET", headers = {}, cookie = true, body } = {},
  ) {
    const response = await worker.fetch(
      new Request(site + path, {
        method,
        headers: {
          ...(method === "POST" ? { Origin: site } : {}),
          ...(path === "/api/auth/token"
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...(cookie
            ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }
            : {}),
          ...headers,
        },
        ...(method === "POST" && path === "/api/auth/token"
          ? {
              body:
                body ??
                new URLSearchParams({
                  grant_type: SESSION_GRANT_TYPE,
                  client_id: site + "/",
                  scope: ACCOUNT_SCOPE,
                  resource: site + "/nas",
                }),
            }
          : body !== undefined ? { body } : {}),
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
  let nonce;
  async function grant(scope = ACCOUNT_SCOPE) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request("/api/auth/token", {
        method: "POST",
        body: new URLSearchParams({ grant_type: SESSION_GRANT_TYPE, client_id: site + "/", scope }),
        headers: {
          DPoP: await proof("/api/auth/token", pair, nonce ? { nonce } : {}),
        },
      });
      nonce = response.headers.get("DPoP-Nonce") || nonce;
      if (
        attempt === 0 &&
        (await response.clone().json()).error === "use_dpop_nonce"
      )
        continue;
      return response;
    }
  }
  async function begin(returnTo) {
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { DPoP: await proof("/api/auth/login") },
      ...(returnTo === undefined ? {} : { body: JSON.stringify({ returnTo }) }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const value = await response.json();
    flow = new URL(value.url).searchParams;
    return response;
  }
  async function login(returnTo) {
    await begin(returnTo);
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
    grant,
    nonce: () => nonce,
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
  assert.equal(response.headers.get("Location"), site + "/account");
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const value of cookies) {
    assert.match(value, /HttpOnly; Secure; SameSite=Lax/);
    assert.match(value, /Path=\//);
    assert.ok(!value.includes("test-user"));
  }
  const session = await (await f.request("/api/auth/session")).json();
  assert.equal(session.user.sub, expectedSiteSubject);
  assert.equal(session.user.issuer, site);
  assert.equal(session.authenticated, true);
  assert.ok(!("accessToken" in session));
  const token = await (await f.grant()).json();
  assert.equal(token.token_type, "DPoP");
  assert.equal(token.expires_in, 60);
  assert.equal(token.scope, ACCOUNT_SCOPE);
  const jwks = await (await f.request("/api/auth/jwks.json")).json();
  assert.ok(!JSON.stringify(jwks).includes('"d"'));
  const verified = await jwtVerify(
    token.access_token,
    createLocalJWKSet(jwks),
    {
      issuer: site,
      audience: site + "/nas",
      algorithms: ["EdDSA"],
    },
  );
  assert.equal(verified.payload.sub, expectedSiteSubject);
  assert.equal(verified.payload.lantern_dock.protocol_version, 2);
  assert.ok(!("identity_issuer" in verified.payload));
  assert.ok(!JSON.stringify(verified.payload).includes(issuer));
  assert.equal(verified.payload.client_id, site + "/");
  assert.equal(verified.payload.scope, ACCOUNT_SCOPE);
  assert.equal(
    verified.payload.cnf.jkt,
    await calculateJwkThumbprint(f.publicProof),
  );
  assert.equal(verified.payload.exp - verified.payload.iat, 60);
  assert.ok(!JSON.stringify(token).includes("never-return-this-to-browser"));
  const calls = f.calls();
  assert.equal((await f.grant()).status, 200);
  assert.equal(f.calls(), calls, "grant renewal must not call SSO");
});

test("OIDC state preserves local deep links and rejects external or credential-bearing destinations", async () => {
  for (const [requested, expected] of [["/files/trip/photo.jpg?view=album", "/files/trip/photo.jpg?view=album"], ["/admin/inbox", "/admin/inbox"], ["//evil.example", "/account"], ["/upload#token=secret", "/account"]]) {
    const f = await fixture();
    const response = await f.login(requested);
    assert.equal(response.headers.get("Location"), site + expected);
  }
});

test("a cancelled login retains a validated local destination on the account error page", async () => {
  const f = await fixture();
  await f.begin("/files/trip/photo.jpg?view=album");
  const response = await f.request("/auth/callback?" + new URLSearchParams({ state: f.flow().get("state"), iss: issuer, error: "access_denied" }));
  const destination = new URL(response.headers.get("Location"));
  assert.equal(destination.pathname, "/account");
  assert.equal(destination.searchParams.get("return"), "/files/trip/photo.jpg?view=album");
  assert.ok(destination.searchParams.get("error"));
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
  assert.equal(response.status, 400);
  response = await good.request("/api/auth/token", {
    method: "POST",
    cookie: false,
    headers: { DPoP: await good.proof("/api/auth/token") },
  });
  assert.equal(response.status, 400);
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
  t.mock.method(Date, "now", () => timestamp + 61 * 60 * 1000);
  assert.equal(
    (await (await f.request("/api/auth/session")).json()).authenticated,
    false,
  );
});
test("only verified management grants renew the one-hour idle window", async (t) => {
  let timestamp = Math.floor(Date.now() / 1000) * 1000;
  t.mock.method(Date, "now", () => timestamp);
  const f = await fixture();
  await f.login();
  const originalCookie = f.jar.get("__Host-lantern-session");
  const initial = await (await f.request("/api/auth/session")).json();
  assert.equal(Date.parse(initial.expiresAt), timestamp + 60 * 60 * 1000);
  timestamp += 40 * 60 * 1000;
  for (const path of ["/", "/api/config", "/api/auth/session"])
    assert.equal((await f.request(path)).headers.get("Set-Cookie"), null);
  const account = await f.grant();
  assert.equal(account.status, 200);
  assert.equal(account.headers.get("Set-Cookie"), null);
  assert.equal(f.jar.get("__Host-lantern-session"), originalCookie);
  // Neither a nonce challenge, a bad proof, nor a foreign origin is activity.
  for (const headers of [
    { DPoP: await f.proof("/api/auth/token") },
    { DPoP: "invalid-proof" },
    { Origin: "https://other.example" },
  ]) {
    const response = await f.request("/api/auth/token", {
      method: "POST", headers,
      body: new URLSearchParams({ grant_type: SESSION_GRANT_TYPE, client_id: site + "/", scope: "links:read" }),
    });
    assert.notEqual(response.status, 200);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(f.jar.get("__Host-lantern-session"), originalCookie);
  }
  const management = await f.grant("links:read");
  assert.equal(management.status, 200);
  assert.match(management.headers.get("Set-Cookie"), /Max-Age=3600; HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await management.json()).expires_in, 60);
  assert.notEqual(f.jar.get("__Host-lantern-session"), originalCookie);
  timestamp += 20 * 60 * 1000;
  const renewed = await (await f.request("/api/auth/session")).json();
  assert.equal(renewed.authenticated, true);
  assert.equal(Date.parse(renewed.expiresAt), timestamp + 40 * 60 * 1000);
  timestamp += 40 * 60 * 1000;
  assert.equal((await (await f.request("/api/auth/session")).json()).authenticated, false);
  const expired = await f.grant("inbox:read");
  assert.equal((await expired.json()).code, "LOGIN_REQUIRED");
  assert.equal(expired.headers.get("Set-Cookie"), null);
});

test("frequent management requests renew only after half the one-hour lifetime", async (t) => {
  const started = Math.floor(Date.now() / 1000) * 1000;
  let timestamp = started;
  t.mock.method(Date, "now", () => timestamp);
  const f = await fixture();
  await f.login();
  const original = f.jar.get("__Host-lantern-session");
  for (const minutes of [1, 5, 15, 29]) {
    timestamp = started + minutes * 60 * 1000;
    const response = await f.grant("links:read");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(f.jar.get("__Host-lantern-session"), original);
  }
  timestamp = started + 30 * 60 * 1000;
  assert.match((await f.grant("links:read")).headers.get("Set-Cookie"), /Max-Age=3600;/);
  const renewed = f.jar.get("__Host-lantern-session");
  timestamp = started + 59 * 60 * 1000;
  assert.equal((await f.grant("links:read")).headers.get("Set-Cookie"), null);
  assert.equal(f.jar.get("__Host-lantern-session"), renewed);
  timestamp = started + 60 * 60 * 1000;
  assert.match((await f.grant("links:read")).headers.get("Set-Cookie"), /Max-Age=3600;/);
});

test("continued management activity cannot exceed eight hours from login", async (t) => {
  const started = Math.floor(Date.now() / 1000) * 1000;
  let timestamp = started;
  t.mock.method(Date, "now", () => timestamp);
  const f = await fixture();
  await f.login();
  let latestRenewal;
  for (let minutes = 20; minutes <= 460; minutes += 20) {
    timestamp = started + minutes * 60 * 1000;
    const latest = await f.grant("inbox:read");
    assert.equal(latest.status, 200);
    if (latest.headers.has("Set-Cookie")) latestRenewal = { response: latest, at: timestamp };
  }
  const deadline = started + 8 * 60 * 60 * 1000;
  assert.match(latestRenewal.response.headers.get("Set-Cookie"), new RegExp(`Max-Age=${(deadline - latestRenewal.at) / 1000};`));
  assert.equal(Date.parse((await (await f.request("/api/auth/session")).json()).expiresAt), deadline);
  timestamp = deadline - 1000;
  const last = await f.grant("links:write");
  assert.equal(last.status, 200);
  assert.equal(last.headers.get("Set-Cookie"), null);
  timestamp = deadline;
  assert.equal((await (await f.request("/api/auth/session")).json()).authenticated, false);
  const expired = await f.grant("links:write");
  assert.equal((await expired.json()).code, "LOGIN_REQUIRED");
  assert.equal(expired.headers.get("Set-Cookie"), null);
});

test("a fixed-lifetime cookie keeps its original login time when upgraded", async (t) => {
  const started = Math.floor(Date.now() / 1000) * 1000;
  let timestamp = started;
  t.mock.method(Date, "now", () => timestamp);
  const f = await fixture();
  await f.login();
  const name = "__Host-lantern-session";
  const key = await crypto.subtle.importKey("raw", Buffer.from(await deriveSecret(f.env.SECRET_KEY,
    "lantern-dock:identity-cookies:v1:" + site), "hex"), "AES-GCM", false, ["encrypt", "decrypt"]);
  const decode = async () => {
    const bytes = Buffer.from(f.jar.get(name), "base64url");
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: encoder.encode(name) }, key, bytes.subarray(12))));
  };
  const session = await decode();
  delete session.startedAt;
  session.expires = started / 1000 + 30 * 60;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(name) }, key, encoder.encode(JSON.stringify(session)));
  f.jar.set(name, encode(Buffer.concat([iv, Buffer.from(encrypted)])));
  timestamp += 20 * 60 * 1000;
  assert.equal((await f.grant("links:read")).status, 200);
  assert.equal((await decode()).startedAt, started / 1000);
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

test("authorization metadata and token errors expose the supported session-grant contract", async () => {
  const f = await fixture();
  const response = await f.request(AUTHORIZATION_METADATA_PATH);
  const metadata = await response.json();
  assert.equal(metadata.issuer, site);
  assert.equal(metadata.jwks_uri, site + "/api/auth/jwks.json");
  assert.equal(metadata.token_endpoint, site + "/api/auth/token");
  assert.deepEqual(metadata.grant_types_supported, [SESSION_GRANT_TYPE]);
  assert.deepEqual(metadata.response_types_supported, []);
  assert.deepEqual(metadata.dpop_signing_alg_values_supported, ["ES256"]);
  assert.deepEqual(metadata.scopes_supported, NAS_SCOPES);
  assert.equal(metadata.lantern_dock.resource, site + "/nas");
  assert.match(response.headers.get("Cache-Control"), /max-age=300/);
  assert.ok(!JSON.stringify(metadata).includes(f.env.SECRET_KEY));
  for (const [patch, expected] of [
    [{ grant_type: "client_credentials" }, "unsupported_grant_type"],
    [{ client_id: "other" }, "invalid_client"],
    [{ resource: "https://other.example/nas" }, "invalid_target"],
    [{ scope: "files:write" }, "invalid_scope"],
    [{ scope: "" }, "invalid_scope"],
    [{ scope: "account:read links:write other" }, "invalid_scope"],
    [{ scope: "links:write links:write" }, "invalid_scope"],
    [{ scope: "links:write\tinbox:read" }, "invalid_scope"],
  ]) {
    const r = await f.request("/api/auth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: SESSION_GRANT_TYPE,
        client_id: site + "/",
        ...patch,
      }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, expected);
    assert.equal(r.headers.get("Cache-Control"), "no-store");
  }
  const duplicate = await f.request("/api/auth/token", {
    method: "POST",
    body: `grant_type=${encodeURIComponent(SESSION_GRANT_TYPE)}&grant_type=other`,
  });
  assert.equal((await duplicate.json()).error, "invalid_request");
  const oversized = await f.request("/api/auth/token", {
    method: "POST",
    body: "x".repeat(8193),
  });
  assert.equal((await oversized.json()).error, "invalid_request");
  const noCookie = await f.request("/api/auth/token", {
    method: "POST",
    cookie: false,
  });
  assert.equal((await noCookie.json()).error, "invalid_grant");
});

test("token issuance requires a fresh server nonce and valid key, method, URL and proof type", async (t) => {
  const f = await fixture();
  await f.login();
  const post = async (patch = {}, headers = {}) =>
    f.request("/api/auth/token", {
      method: "POST",
      headers: {
        DPoP: await f.proof("/api/auth/token", f.pair, patch),
        ...headers,
      },
    });
  const challenge = await post();
  assert.equal(challenge.status, 400);
  assert.equal((await challenge.json()).error, "use_dpop_nonce");
  const nonce = challenge.headers.get("DPoP-Nonce");
  assert.match(nonce, /^[A-Za-z0-9_-]+$/);
  assert.ok(!nonce.includes(f.env.SECRET_KEY));
  const wrongType = await new SignJWT({
    nonce,
    htm: "POST",
    htu: site + "/api/auth/token",
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", jwk: f.publicProof })
    .setIssuedAt()
    .sign(f.pair.privateKey);
  assert.equal(
    (await (await post({}, { DPoP: wrongType })).json()).error,
    "invalid_dpop_proof",
  );
  for (const patch of [
    { htm: "GET" },
    { htu: site + "/other" },
    { htu: site + "/api/auth/token?x=1" },
    { jti: "short" },
  ]) {
    const r = await post({ nonce, ...patch });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, "invalid_dpop_proof");
  }
  const r = await post({ nonce });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Pragma"), "no-cache");
  assert.ok((await r.json()).access_token);
  assert.equal(
    (await (await post({ nonce: nonce + "x" })).json()).error,
    "use_dpop_nonce",
  );
  // No downgrade after a challenge, even if the session itself is still valid.
  assert.equal((await (await post()).json()).error, "use_dpop_nonce");
  const timestamp = Date.now();
  t.mock.method(Date, "now", () => timestamp + 61000);
  assert.equal((await (await post({ nonce })).json()).error, "use_dpop_nonce");
});

test("signing versions allow prepublication, overlap and retirement without changing sessions or webhooks", async () => {
  const f = await fixture();
  await f.login();
  const sessionCookie = f.jar.get("__Host-lantern-session");
  const webhook = await certificateWebhookTokens(f.env);
  const first = await (await f.grant()).json();
  const initial = await (await f.request("/api/auth/jwks.json")).json();
  f.env.AUTH_SIGNING_KEY_VERSIONS = '["v1","v2"]';
  const prepared = await (await f.request("/api/auth/jwks.json")).json();
  assert.equal(prepared.keys[0].kid, initial.keys[0].kid);
  assert.equal(prepared.keys.length, 2);
  assert.ok(prepared.keys.every((key) => !("d" in key)));
  f.env.AUTH_SIGNING_KEY_VERSIONS = '["v2","v1"]';
  const secondResponse = await f.grant();
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  const overlap = await (await f.request("/api/auth/jwks.json")).json();
  assert.notEqual(
    decodeJwt(first.access_token).jti,
    decodeJwt(second.access_token).jti,
  );
  for (const token of [first, second])
    await jwtVerify(token.access_token, createLocalJWKSet(overlap), {
      issuer: site,
      audience: site + "/nas",
      typ: "at+jwt",
    });
  // Prepublished keys already verify tokens minted after the switch.
  await jwtVerify(second.access_token, createLocalJWKSet(prepared));
  f.env.AUTH_SIGNING_KEY_VERSIONS = '["v2"]';
  const retired = await (await f.request("/api/auth/jwks.json")).json();
  await assert.rejects(
    jwtVerify(first.access_token, createLocalJWKSet(retired)),
  );
  await jwtVerify(second.access_token, createLocalJWKSet(retired));
  assert.equal(f.jar.get("__Host-lantern-session"), sessionCookie);
  assert.equal(
    (await (await f.request("/api/auth/session")).json()).authenticated,
    true,
  );
  assert.deepEqual(await certificateWebhookTokens(f.env), webhook);
  for (const invalid of ["[]", '["v2","v2"]', "null", '["bad:label"]', "[1]"]) {
    f.env.AUTH_SIGNING_KEY_VERSIONS = invalid;
    assert.equal((await f.request("/api/auth/jwks.json")).status, 503);
    const failed = await f.grant();
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, "temporarily_unavailable");
  }
});

test("site subjects are stable, namespace external identities, and survive signing-secret changes", async () => {
  assert.equal(await siteSubject(issuer, "test-user"), expectedSiteSubject);
  assert.notEqual(
    await siteSubject("https://other-sso.example", "test-user"),
    expectedSiteSubject,
  );
  assert.notEqual(
    await siteSubject(issuer, "another-user"),
    expectedSiteSubject,
  );
  assert.notEqual(
    await siteSubject("https://a.example", "b:c"),
    await siteSubject("https://a.example:b", "c"),
  );
  const f = await fixture();
  f.env.SECRET_KEY = "a-new-site-secret-key-0123456789abcdef";
  await f.login();
  assert.equal(
    (await (await f.request("/api/auth/session")).json()).user.sub,
    expectedSiteSubject,
  );
});

test("site subjects use the first 16 digest bytes with stable UTF-8 JSON test vectors", async () => {
  for (const [inputIssuer, subject, expected] of [
    [issuer, "test-user", "ld_1KzSHPuTIpRkcYiSJTXRlA"],
    [issuer, "fixture-identity-user", "ld_-TYdm_tjfPUQRGnIAmmSNw"],
    ["https://a.example", "b:c", "ld_sfyNuavPlDB6cei7AN9ymQ"],
    ["https://a.example:b", "c", "ld_5mQqWbjReftz6wBFcMsr1w"],
    [issuer, "\u7528\u6237,\u2713", "ld_b_Tk6rVICWspYAam7rXx8w"],
  ]) {
    const actual = await siteSubject(inputIssuer, subject);
    assert.equal(actual, expected);
    assert.equal(actual.length, 25);
    assert.equal(validSiteSubject(actual), true);
  }
});

test("site subject validation accepts only canonical 25-character IDs", () => {
  for (const suffix of ["A", "Q", "g", "w"]) {
    assert.equal(validSiteSubject("ld_" + "A".repeat(21) + suffix), true);
  }
  for (const subject of [
    undefined, null, 25, {}, "", "upstream,subject",
    "ld_" + "A".repeat(43), // Legacy full SHA-256 ID.
    "ld_" + "A".repeat(21) + "B", // Nonzero unused Base64 bits.
    "ld_" + "+".repeat(21) + "A", "ld_" + "/".repeat(21) + "A",
    "LD_" + "A".repeat(22), expectedSiteSubject + "=",
    expectedSiteSubject + "\n", " " + expectedSiteSubject,
    expectedSiteSubject.slice(0, -1), expectedSiteSubject + "A",
  ]) {
    assert.equal(validSiteSubject(subject), false, String(subject));
  }
});

test("legacy or malformed site subjects cannot keep sessions or mint NAS grants", async () => {
  const f = await fixture();
  await f.login();
  const name = "__Host-lantern-session";
  const original = f.jar.get(name);
  const bytes = Buffer.from(original, "base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(await deriveSecret(f.env.SECRET_KEY, "lantern-dock:identity-cookies:v1:" + site), "hex"),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const session = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: encoder.encode(name) },
    key,
    bytes.subarray(12),
  )));
  for (const sub of [
    "ld_1KzSHPuTIpRkcYiSJTXRlCJhVX0uRCVptuP6f7tF0rM",
    "upstream,subject",
    "ld_" + "A".repeat(21) + "B",
    expectedSiteSubject + "=",
  ]) {
    session.user.sub = sub;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
      key,
      encoder.encode(JSON.stringify(session)),
    );
    f.jar.set(name, encode(Buffer.concat([iv, Buffer.from(encrypted)])));
    assert.equal((await (await f.request("/api/auth/session")).json()).authenticated, false);
    const grant = await f.grant();
    assert.equal(grant.status, 400);
    assert.equal((await grant.json()).error, "invalid_grant");
  }
  f.jar.set(name, original);
  assert.equal((await (await f.request("/api/auth/session")).json()).authenticated, true);
  assert.equal((await f.grant()).status, 200);
});

test("site subjects are canonical comma-free IDs even when upstream subjects contain delimiters", async () => {
  const subjects = ["owner", "owner,other", 'owner"other', "owner other", "[owner]", "owner/other"];
  const ids = await Promise.all(subjects.map((subject) => siteSubject(issuer, subject)));
  for (const id of ids) {
    assert.match(id, /^ld_[A-Za-z0-9_-]{22}$/);
    assert.equal(validSiteSubject(id), true);
    const bytes = Buffer.from(id.slice(3), "base64url");
    assert.equal(bytes.length, 16);
    assert.equal(bytes.toString("base64url"), id.slice(3));
    assert.equal(id.split(",").length, 1);
  }
  assert.equal(new Set(ids).size, subjects.length);
  assert.deepEqual(ids.join(",").split(","), ids);
});

test("a site session and NAS grant no longer depend on external login configuration or availability", async () => {
  const f = await fixture();
  await f.login();
  const calls = f.calls();
  delete f.env.OIDC_ISSUER_URL;
  f.env.SSO_SERVICE = {
    fetch() {
      throw new Error("SSO must not be contacted after login");
    },
  };
  const session = await (await f.request("/api/auth/session")).json();
  assert.equal(session.authenticated, true);
  assert.equal(session.user.issuer, site);
  assert.equal(session.user.sub, expectedSiteSubject);
  assert.equal((await f.request(AUTHORIZATION_METADATA_PATH)).status, 200);
  assert.equal((await f.request("/api/auth/jwks.json")).status, 200);
  const response = await f.grant();
  assert.equal(response.status, 200);
  const payload = decodeJwt((await response.json()).access_token);
  assert.equal(payload.iss, site);
  assert.equal(payload.sub, expectedSiteSubject);
  assert.equal(payload.lantern_dock.protocol_version, 2);
  assert.ok(!("identity_issuer" in payload));
  assert.equal(f.calls(), calls);
  const login = await f.request("/api/auth/login", {
    method: "POST",
    headers: { DPoP: await f.proof("/api/auth/login") },
  });
  assert.equal(login.status, 503);
  assert.equal((await login.json()).code, "OIDC_NOT_CONFIGURED");
  await f.request("/api/auth/logout", { method: "POST" });
  assert.equal(
    (await (await f.request("/api/auth/session")).json()).authenticated,
    false,
  );
});

test("Worker infers its HTTPS origin, isolates domains, and ignores forwarded host headers", async () => {
  const f = await fixture();
  delete f.env.SITE_ORIGIN;
  const metadata = await (await f.request("/api/auth/oidc/client.json")).json();
  assert.equal(metadata.client_id, site + "/api/auth/oidc/client.json");
  assert.deepEqual(metadata.redirect_uris, [site + "/auth/callback"]);
  await f.login();
  const response = await f.request("/api/auth/session", {
    headers: {
      Host: "attacker.example",
      "X-Forwarded-Host": "attacker.example",
      "X-Forwarded-Proto": "http",
    },
  });
  assert.equal((await response.json()).user.issuer, site);
  const grant = decodeJwt((await (await f.grant()).json()).access_token);
  assert.equal(grant.iss, site);
  const keys = await (await f.request("/api/auth/jwks.json")).json();
  const alternate = "https://alternate.example";
  const alternateMetadata = await (
    await worker.fetch(
      new Request(alternate + AUTHORIZATION_METADATA_PATH),
      f.env,
    )
  ).json();
  assert.equal(alternateMetadata.issuer, alternate);
  const alternateKeys = await (
    await worker.fetch(new Request(alternate + "/api/auth/jwks.json"), f.env)
  ).json();
  assert.notEqual(alternateKeys.keys[0].kid, keys.keys[0].kid);
  const copiedCookie = [...f.jar]
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
  const alternateSession = await worker.fetch(
    new Request(alternate + "/api/auth/session", {
      headers: { Cookie: copiedCookie },
    }),
    f.env,
  );
  assert.equal((await alternateSession.json()).authenticated, false);
  const forbidden = await f.request("/api/auth/logout", {
    method: "POST",
    headers: { Origin: alternate },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(
    (await (await f.request("/api/auth/session")).json()).authenticated,
    true,
  );
  const insecure = await worker.fetch(
    new Request("http://portal.example/api/auth/session"),
    f.env,
  );
  assert.equal(insecure.status, 400);
  assert.equal((await insecure.json()).code, "INVALID_SITE_ORIGIN");
  assert.equal(f.env.SITE_ORIGIN, undefined);
});

test("login identifies Discovery failures without returning upstream bodies or exception details", async () => {
  const cases = [
    {
      fetch: () => new Response("private-canary", { status: 403 }),
      code: "OIDC_DISCOVERY_HTTP_ERROR",
      message: /HTTP 403/,
    },
    {
      fetch: () =>
        new Response("private-canary", {
          status: 302,
          headers: { Location: "https://attacker.example" },
        }),
      code: "OIDC_DISCOVERY_HTTP_ERROR",
      message: /HTTP 302/,
    },
    {
      fetch: () => {
        throw new Error("private-canary");
      },
      code: "OIDC_DISCOVERY_UNREACHABLE",
    },
    {
      fetch: () => new Response("private-canary"),
      code: "OIDC_DISCOVERY_INVALID",
    },
    { patch: { issuer: issuer + "/" }, code: "OIDC_ISSUER_MISMATCH" },
    {
      patch: { client_id_metadata_document_supported: false },
      code: "OIDC_CIMD_UNSUPPORTED",
    },
    {
      patch: { code_challenge_methods_supported: [] },
      code: "OIDC_PKCE_UNSUPPORTED",
    },
    {
      patch: { jwks_uri: "http://private-canary" },
      code: "OIDC_DISCOVERY_INVALID",
    },
  ];
  for (const entry of cases) {
    const f = await fixture();
    const fetch = f.env.SSO_SERVICE.fetch;
    f.env.SSO_SERVICE.fetch = async (request) => {
      if (entry.fetch) return entry.fetch();
      const response = await fetch(request);
      return Response.json({ ...(await response.json()), ...entry.patch });
    };
    const response = await f.request("/api/auth/login", {
      method: "POST",
      headers: { DPoP: await f.proof("/api/auth/login") },
    });
    assert.equal(response.status, 503);
    const value = await response.json();
    assert.equal(value.code, entry.code);
    if (entry.message) assert.match(value.error, entry.message);
    assert.ok(!JSON.stringify(value).includes("private-canary"));
  }
});

test("authentication localizes display messages but keeps OAuth identifiers stable", async () => {
  const f = await fixture();
  for (const [language, expected] of [
    ["en", "This endpoint requires a POST request."],
    ["zh-CN", "此接口需要 POST 请求。"],
  ]) {
    const response = await f.request("/api/auth/token", {
      headers: { "Accept-Language": language },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
    assert.equal(response.headers.get("Content-Language"), language);
    assert.equal(response.headers.get("Vary"), "Cookie, Accept-Language");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const value = await response.json();
    assert.equal(value.error, "invalid_request");
    assert.equal(value.code, "invalid_request");
    assert.equal(value.error_description, "Use POST for token requests.");
    assert.equal(value.message, expected);
  }
  for (const path of [AUTHORIZATION_METADATA_PATH, "/api/auth/jwks.json"]) {
    const metadata = await f.request(path, {
      headers: { "Accept-Language": "zh-CN" },
    });
    assert.equal(metadata.headers.get("Content-Language"), null);
    assert.equal(metadata.headers.get("Vary"), null);
    assert.equal(metadata.headers.get("Cache-Control"), "public, max-age=300");
  }
});

test("concurrent OIDC discovery failures retain the request language and privacy", async () => {
  const f = await fixture();
  const pending = [];
  f.env.SSO_SERVICE.fetch = () =>
    new Promise((resolve) => {
      pending.push(resolve);
      if (pending.length === 2)
        for (const complete of pending.reverse())
          complete(new Response("private-canary", { status: 403 }));
    });
  const requests = await Promise.all(
    ["zh-CN", "en"].map(async (language) =>
      f.request("/api/auth/login", {
        method: "POST",
        headers: {
          "Accept-Language": language,
          DPoP: await f.proof("/api/auth/login"),
        },
      }),
    ),
  );
  for (const [index, response] of requests.entries()) {
    assert.equal(response.status, 503);
    const value = await response.json();
    assert.equal(value.code, "OIDC_DISCOVERY_HTTP_ERROR");
    assert.match(
      value.error,
      index === 0 ? /登录服务.*HTTP 403/ : /sign-in service.*HTTP 403/,
    );
    assert.ok(!JSON.stringify(value).includes("private-canary"));
    assert.equal(
      response.headers.get("Content-Language"),
      index === 0 ? "zh-CN" : "en",
    );
  }
});

test("callback errors use the browser language and remain encoded in a private redirect", async () => {
  const f = await fixture();
  for (const [language, expected] of [
    [
      "en",
      "The sign-in request expired or was replaced. Please sign in again.",
    ],
    ["zh-CN", "登录请求已过期或已更新，请重新登录。"],
  ]) {
    const response = await f.request("/auth/callback?error=private-canary", {
      headers: { "Accept-Language": language },
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("Content-Language"), language);
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(
      response.headers.get("Location"),
      site + "/account?error=" + encodeURIComponent(expected),
    );
    assert.ok(
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.includes("Max-Age=0")),
    );
  }
});


test("NAS grants carry only explicitly requested supported scopes and never assert admin", async () => {
  const f = await fixture();
  await f.login();
  for (const requested of ["links:read", "links:write", "inbox:read", "inbox:read links:write account:read"]) {
    const response = await f.grant(requested);
    assert.equal(response.status, 200);
    const token = await response.json();
    const expected = NAS_SCOPES.filter((scope) => requested.split(" ").includes(scope)).join(" ");
    assert.equal(token.scope, expected);
    const payload = decodeJwt(token.access_token);
    assert.equal(payload.scope, expected);
    assert.equal(payload.sub, expectedSiteSubject);
    assert.equal(payload.role, undefined);
    assert.equal(payload.admin, undefined);
    assert.ok(payload.cnf.jkt);
  }
});
