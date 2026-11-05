import { initializeEnvironment } from "./site-key.mjs";
import {
  deriveSecret,
  CERTIFICATE_WEBHOOK_PURPOSE,
} from "../worker/secrets.js";

try {
  const origin = new URL(process.argv[2]);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error("Pass an HTTPS Worker origin without a path.");
  const result = await initializeEnvironment();
  const token = await deriveSecret(result.key, CERTIFICATE_WEBHOOK_PURPOSE);
  if (result.created)
    console.error(
      "Initialized SECRET_KEY in .env. Deploy it as a Worker Secret before using this URL.",
    );
  if (result.migrated)
    console.error("Moved the existing .dev.vars settings into .env.");
  console.log(origin.origin + "/api/certificates/" + token);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
