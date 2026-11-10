export const AUTHORIZATION_METADATA_PATH =
  "/.well-known/oauth-authorization-server";
export const SESSION_GRANT_TYPE =
  "urn:lantern-dock:params:oauth:grant-type:session";
export const ACCOUNT_SCOPE = "account:read";
export const LINKS_READ_SCOPE = "links:read";
export const LINKS_WRITE_SCOPE = "links:write";
export const INBOX_READ_SCOPE = "inbox:read";
export const INBOX_WRITE_SCOPE = "inbox:write";
export const NAS_SCOPES = Object.freeze([
  ACCOUNT_SCOPE,
  LINKS_READ_SCOPE,
  LINKS_WRITE_SCOPE,
  INBOX_READ_SCOPE,
  INBOX_WRITE_SCOPE,
  "users:read",
  "users:write",
]);
export const GRANT_SECONDS = 60;
export const IDENTITY_PROTOCOL_VERSION = 2;

export function canonicalProofURI(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /[?#]/.test(String(value))
  )
    throw new Error("Invalid DPoP target URI");
  const path = url.pathname.replace(/%[0-9a-f]{2}/gi, (encoded) => {
    const character = String.fromCharCode(parseInt(encoded.slice(1), 16));
    return /^[A-Za-z0-9._~-]$/.test(character)
      ? character
      : encoded.toUpperCase();
  });
  return url.origin + path;
}
