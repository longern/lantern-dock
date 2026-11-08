// Only the login adapter knows the external identity. NAS consumers receive
// an opaque site subject that stays stable across restarts and key rotation.
export async function siteSubject(issuer, subject) {
  const input = JSON.stringify(["lantern-dock:subject:v1", issuer, subject]);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  return (
    "ld_" +
    btoa(String.fromCharCode(...hash.subarray(0, 16)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  );
}

// Sixteen bytes use 22 unpadded Base64URL characters. The final character has
// only two data bits; restricting it rejects noncanonical encodings as well.
export function validSiteSubject(subject) {
  return (
    typeof subject === "string" &&
    subject.length === 25 &&
    /^ld_[A-Za-z0-9_-]{21}[AQgw]$/.test(subject)
  );
}
