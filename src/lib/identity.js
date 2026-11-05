import { DirectTransport } from "./transport.js";
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
        reject(new Error("登录需要浏览器允许本站存储安全密钥。"));
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
export async function identityProof(method, url, token) {
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
    htu: target.origin + target.pathname,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  };
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
async function result(response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      value.error || `账户服务返回 ${response.status}，请检查连接配置。`,
    );
    error.code = value.code;
    throw error;
  }
  return value;
}
export async function identitySession(signal) {
  return result(
    await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    }),
  );
}
export async function beginLogin() {
  const proof = await identityProof(
    "POST",
    location.origin + "/api/auth/login",
  );
  const value = await result(
    await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { DPoP: proof },
    }),
  );
  location.assign(value.url);
}
export async function endLogin() {
  return result(
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    }),
  );
}
export async function accountConnection(signal) {
  const config = await result(
    await fetch("/api/config", { cache: "no-store", signal }),
  );
  if (
    config.setupRequired ||
    !config.backend ||
    config.backend.transport === "demo"
  )
    throw new Error("NAS 尚未完成连接配置，身份已登录，可先复制 sub。 ");
  const proof = await identityProof(
    "POST",
    location.origin + "/api/auth/token",
  );
  const grant = await result(
    await fetch("/api/auth/token", {
      method: "POST",
      credentials: "same-origin",
      headers: { DPoP: proof },
      signal,
    }),
  );
  const transport = new DirectTransport(config.backend);
  try {
    const path = "/api/account";
    const info = await result(
      await transport.request(path, {
        headers: {
          Authorization: "DPoP " + grant.accessToken,
          DPoP: await identityProof(
            "GET",
            location.origin + path,
            grant.accessToken,
          ),
        },
        signal,
      }),
    );
    return { transport, ...info };
  } catch (error) {
    transport.close();
    throw error;
  }
}
