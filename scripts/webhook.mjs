import { initializeEnvironment } from "./site-key.mjs";
import { certificateWebhookUrl, webhookOrigin } from "../shared/site-secret.js";

try {
  const origin = webhookOrigin(process.argv[2]);
  const result = await initializeEnvironment();
  const url = await certificateWebhookUrl(result.key, origin);
  if (result.created)
    console.error(
      "Initialized SECRET_KEY in .env. Deploy it as a Worker Secret before using this URL.",
    );
  if (result.migrated)
    console.error("Moved the existing .dev.vars settings into .env.");
  console.log(url);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
