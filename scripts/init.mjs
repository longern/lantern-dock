import { initializeEnvironment } from "./site-key.mjs";

try {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((value) => value !== "--print-secret"))
    throw new Error("Usage: node scripts/init.mjs [--print-secret]");
  const result = await initializeEnvironment();
  if (arguments_.includes("--print-secret"))
    process.stdout.write(result.key + "\n");
  else
    console.log(
      result.created
        ? "Initialized SECRET_KEY in .env."
        : "Kept the existing SECRET_KEY in .env.",
    );
  if (result.migrated)
    console.error("Moved the existing .dev.vars settings into .env.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
