// Only the login adapter knows the external identity. NAS consumers receive
// an opaque site subject that stays stable across restarts and key rotation.
export async function siteSubject(issuer, subject) {
  const input = JSON.stringify(["lantern-dock:subject:v1", issuer, subject]);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  return (
    "ld_" +
    btoa(String.fromCharCode(...hash))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  );
}
