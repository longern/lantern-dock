import {
  deriveSecret,
  CERTIFICATE_WEBHOOK_PURPOSE,
} from "../shared/site-secret.js";
export {
  deriveSecret,
  validateSecretKey,
  CERTIFICATE_WEBHOOK_PURPOSE,
} from "../shared/site-secret.js";

export async function certificateWebhookTokens(env) {
  const tokens = [];
  if (env.SECRET_KEY !== undefined)
    tokens.push(
      await deriveSecret(env.SECRET_KEY, CERTIFICATE_WEBHOOK_PURPOSE),
    );
  // An explicit legacy credential stays valid until the maintainer removes it.
  if (
    typeof env.CERT_WEBHOOK_SECRET === "string" &&
    env.CERT_WEBHOOK_SECRET.length >= 32
  )
    tokens.push(env.CERT_WEBHOOK_SECRET);
  return tokens;
}
