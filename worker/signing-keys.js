import { calculateJwkThumbprint } from "jose";
import { deriveSecret } from "../shared/site-secret.js";

const cache = new WeakMap();

// The first version signs; the others are public verification keys only.
// v1 preserves the key used before configurable rotation was introduced.
export async function signingKeys(env, site) {
  const raw = env.AUTH_SIGNING_KEY_VERSIONS ?? '["v1"]';
  let state = cache.get(env);
  if (
    state?.secret === env.SECRET_KEY &&
    state.site === site &&
    state.raw === raw
  )
    return state.promise;
  const versions = JSON.parse(raw);
  if (
    !Array.isArray(versions) ||
    versions.length < 1 ||
    versions.length > 8 ||
    new Set(versions).size !== versions.length ||
    versions.some(
      (v) => typeof v !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(v),
    )
  )
    throw new Error(
      "AUTH_SIGNING_KEY_VERSIONS must be an ordered JSON array of unique versions",
    );
  state = { secret: env.SECRET_KEY, site, raw };
  state.promise = Promise.all(
    versions.map(async (version) => {
      const purpose =
        "lantern-dock:identity-signing:v1:" +
        site +
        (version === "v1" ? "" : ":key-version:" + version);
      const seed = Uint8Array.from(
        (await deriveSecret(env.SECRET_KEY, purpose)).match(/../g),
        (x) => parseInt(x, 16),
      );
      const prefix = Uint8Array.from([
        48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32,
      ]);
      const key = await crypto.subtle.importKey(
        "pkcs8",
        new Uint8Array([...prefix, ...seed]),
        "Ed25519",
        true,
        ["sign"],
      );
      const exported = await crypto.subtle.exportKey("jwk", key);
      const jwk = {
        kty: "OKP",
        crv: "Ed25519",
        x: exported.x,
        alg: "EdDSA",
        use: "sig",
      };
      jwk.kid = await calculateJwkThumbprint(jwk);
      return { key, jwk };
    }),
  ).then((keys) => ({
    active: keys[0],
    jwks: { keys: keys.map((k) => k.jwk) },
  }));
  cache.set(env, state);
  return state.promise;
}
