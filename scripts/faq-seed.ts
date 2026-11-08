/**
 * CMS G#9 — seed the customer cloud-cost & sizing FAQ entries into one
 * organization. See src/lib/faq-seed.ts for the logic (including the publish
 * guard that keeps a facts-resolving answer out of the public API while
 * _facts.json still holds placeholders); this is just the entrypoint.
 *
 *   npm run faq:seed -- --org <slug> [--force] [--dry-run]
 */
import { FaqSeedUsageError, formatFaqSeedSummary, parseFaqSeedArgs, runFaqSeed } from "../src/lib/faq-seed";

async function main() {
  const result = await runFaqSeed(parseFaqSeedArgs(process.argv.slice(2)));
  console.log(formatFaqSeedSummary(result));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof FaqSeedUsageError) console.error(err.message);
    else console.error("FAQ seed failed:", err);
    process.exit(1);
  });
