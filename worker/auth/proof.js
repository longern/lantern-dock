import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from "jose";
import { canonicalProofURI } from "../../shared/identity-protocol.js";

export async function proof(request, site, expectedThumbprint) {
  const raw = request.headers.get("DPoP");
  if (!raw || raw.length > 8192) throw new Error("Proof required");
  const header = decodeProtectedHeader(raw);
  const jwk = header.jwk;
  if (
    header.alg !== "ES256" ||
    header.typ !== "dpop+jwt" ||
    !jwk ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    "d" in jwk
  )
    throw new Error("Invalid proof key");
  const { payload } = await jwtVerify(raw, await importJWK(jwk, "ES256"), {
    algorithms: ["ES256"],
    typ: "dpop+jwt",
    maxTokenAge: "60s",
    clockTolerance: 5,
  });
  const target = site + new URL(request.url).pathname;
  if (
    payload.htm !== request.method ||
    canonicalProofURI(payload.htu) !== canonicalProofURI(target) ||
    typeof payload.jti !== "string" ||
    payload.jti.length < 16 ||
    payload.jti.length > 128
  )
    throw new Error("Proof mismatch");
  const thumbprint = await calculateJwkThumbprint(jwk);
  if (expectedThumbprint && expectedThumbprint !== thumbprint)
    throw new Error("Browser key changed");
  return { thumbprint, payload };
}
