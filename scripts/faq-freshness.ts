/**
 * CMS G#8 FAQ freshness pass — run monthly by a systemd timer
 * (deploy/systemd/faq-freshness.timer), never interactively expected to
 * publish or otherwise mutate a live answer. See src/lib/faq-freshness.ts
 * for the actual logic; this is just the entrypoint.
 *
 *   npm run faq:freshness
 */
import { runFreshnessPass } from "../src/lib/faq-freshness";

runFreshnessPass()
  .then(({ needsReview, unchangedCount }) => {
    console.log(`FAQ freshness pass done: ${needsReview} need review, ${unchangedCount} re-verified unchanged.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("FAQ freshness pass failed:", err);
    process.exit(1);
  });
