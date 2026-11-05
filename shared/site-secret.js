export const CERTIFICATE_WEBHOOK_PURPOSE =
  "lantern-dock:certificate-webhook:v1";

export function validateSecretKey(secretKey) {
  if (
    typeof secretKey !== "string" ||
    secretKey.length < 32 ||
    secretKey.trim() !== secretKey ||
    /[\r\n]/.test(secretKey)
  ) {
    throw new Error(
      "SECRET_KEY must contain at least 32 characters without surrounding whitespace.",
    );
  }
  return secretKey;
}

// Each capability gets a separate token; the site's master key stays private.
export async function deriveSecret(secretKey, purpose) {
  validateSecretKey(secretKey);
  if (typeof purpose !== "string" || !purpose)
    throw new Error("A secret purpose is required.");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(purpose),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function generateSecretKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
