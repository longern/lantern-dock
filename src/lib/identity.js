import { t, locale } from "../../shared/i18n.js";
import { coreError } from "./errors.js";
import { DirectTransport } from "./transport.js";
import { backendPaths } from "../../shared/backend-paths.js";
import { safeReturnPath } from "../../shared/routes.js";
import { clearPersistentImages } from "./image-cache.js";
import {
  AUTHORIZATION_METADATA_PATH,
  SESSION_GRANT_TYPE,
  ACCOUNT_SCOPE,
  IDENTITY_PROTOCOL_VERSION,
  canonicalProofURI,
} from "../../shared/identity-protocol.js";
const encoder = new TextEncoder();
const b64 = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
let keyPromise;
async function browserKey() {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("lantern-dock-identity", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keys");
      request.onerror = () =>
        reject(coreError("IDENTITY_STORAGE_REQUIRED"));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const saved = await new Promise((resolve, reject) => {
        const request = db.transaction("keys").objectStore("keys").get("proof");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (
        saved?.privateKey?.extractable === false &&
        saved.privateKey.algorithm.name === "ECDSA" &&
        saved.privateKey.algorithm.namedCurve === "P-256"
      )
        return saved;
      const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      await new Promise((resolve, reject) => {
        const tx = db.transaction("keys", "readwrite");
        tx.objectStore("keys").put(pair, "proof");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return pair;
    } finally {
      db.close();
    }
  })();
  keyPromise.catch(() => {
    keyPromise = null;
  });
  return keyPromise;
}
export async function identityProof(method, url, token, nonce) {
  const pair = await browserKey();
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = {
    kty: publicKey.kty,
    crv: publicKey.crv,
    x: publicKey.x,
    y: publicKey.y,
  };
  const target = new URL(url);
  const payload = {
    htm: method,
    htu: canonicalProofURI(target.origin + target.pathname),
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  };
  if (nonce) payload.nonce = nonce;
  if (token)
    payload.ath = b64(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(token)),
      ),
    );
  const input =
    b64(
      encoder.encode(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk })),
    ) +
    "." +
    b64(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    encoder.encode(input),
  );
  return input + "." + b64(new Uint8Array(signature));
}
async function result(response, parsed) {
  const value = parsed ?? (await response.json().catch(() => ({})));
  if (!response.ok) {
    const error = new Error(
      value.message ||
        value.error_description ||
        value.error ||
        t("core.error.ACCOUNT_SERVICE_ERROR", { status: response.status }),
    );
    error.code = value.code;
    error.status = response.status;
    throw error;
  }
  return value;
}
export async function identitySession(signal) {
  return result(
    await fetch("/api/auth/session", {
      cache: "no-store",
      headers: { "Accept-Language": locale },
      credentials: "same-origin",
      signal,
    }),
  );
}
export async function beginLogin(signal) {
  signal?.throwIfAborted();
  const proof = await identityProof(
    "POST",
    location.origin + "/api/auth/login",
  );
  signal?.throwIfAborted();
  const value = await result(
    await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { DPoP: proof, "Accept-Language": locale, "Content-Type": "application/json" },
      body: JSON.stringify({ returnTo: location.pathname === "/account" ? safeReturnPath(new URLSearchParams(location.search).get("return")) : location.pathname + location.search }),
      signal,
    }),
  );
  signal?.throwIfAborted();
  await clearPersistentImages();
  signal?.throwIfAborted();
  location.assign(value.url);
}
export async function endLogin() {
  tokenNonce = undefined;
  const value = await result(
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Accept-Language": locale },
    }),
  );
  await clearPersistentImages();
  return value;
}
let tokenNonce;
export async function requestNASGrant(signal, scope = ACCOUNT_SCOPE) {
  const metadata = await result(
    await fetch(AUTHORIZATION_METADATA_PATH, { cache: "no-store", headers: { "Accept-Language": locale }, signal }),
  );
  const endpoint = new URL(metadata.token_endpoint);
  if (
    metadata.issuer !== location.origin ||
    metadata.lantern_dock?.protocol_version !== IDENTITY_PROTOCOL_VERSION ||
    metadata.lantern_dock?.resource !== location.origin + "/nas" ||
    endpoint.origin !== location.origin ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !metadata.grant_types_supported?.includes(SESSION_GRANT_TYPE) ||
    !metadata.dpop_signing_alg_values_supported?.includes("ES256")
  )
    throw coreError("AUTHORIZATION_MISMATCH");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept-Language": locale,
        DPoP: await identityProof("POST", endpoint.href, undefined, tokenNonce),
      },
      body: new URLSearchParams({
        grant_type: SESSION_GRANT_TYPE,
        client_id: location.origin + "/",
        resource: location.origin + "/nas",
        scope,
      }),
    });
    const value = await response.json().catch(() => ({}));
    const nonce = response.headers.get("DPoP-Nonce");
    if (
      nonce &&
      nonce.length <= 2048 &&
      /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(nonce)
    )
      tokenNonce = nonce;
    if (
      attempt === 0 &&
      response.status === 400 &&
      value.error === "use_dpop_nonce" &&
      nonce === tokenNonce
    )
      continue;
    const grant = await result(response, value);
    if (
      grant.token_type !== "DPoP" ||
      typeof grant.access_token !== "string" ||
      !grant.access_token ||
      grant.access_token.length > 8192 ||
      !Number.isInteger(grant.expires_in) ||
      grant.expires_in <= 0 ||
      grant.expires_in > 60
    )
      throw coreError("INVALID_NAS_GRANT");
    return grant;
  }
}
export async function accountConnection(signal) {
  const config = await result(
    await fetch("/api/config", { cache: "no-store", headers: { "Accept-Language": locale }, signal }),
  );
  if (
    config.setupRequired ||
    !config.backend ||
    config.backend.transport === "demo"
  )
    throw coreError("NAS_NOT_CONFIGURED");
  const grant = await requestNASGrant(signal);
  const transport = new DirectTransport(config.backend);
  try {
    const path = backendPaths.account;
    const resourceOrigin =
      config.backend.transport === "http"
        ? new URL(config.backend.endpoint).origin
        : location.origin;
    const info = await result(
      await transport.request(path, {
        headers: {
          Authorization: "DPoP " + grant.access_token,
          DPoP: await identityProof(
            "GET",
            resourceOrigin + path,
            grant.access_token,
          ),
        },
        signal,
      }),
    );
    // Connection ownership and destination come from local configuration, not
    // overridable fields in the resource server response.
    return { ...info, transport, backend: config.backend };
  } catch (error) {
    transport.close();
    throw error;
  }
}
