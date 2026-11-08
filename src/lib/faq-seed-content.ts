import type { FaqAudience, FaqCategory, FaqStatus } from "@/lib/faq";

// Seed entries for `npm run faq:seed`. Empty by default: add your own organization's
// FAQ entries here, in the shape below, to seed them.

export interface FaqSeedEntry {
  slug: string;
  question: string;
  answer: string;
  category: FaqCategory;
  audience: FaqAudience;
  status: FaqStatus;
  last_verified: Date | null;
  verify_every_days: number;
  /**
   * PUBLISHED entries carry BARE URLs only. runFreshnessPass() passes each
   * element straight to fetch(), so gluing the doc's "— description" prose onto
   * a URL would make every source unfetchable, trip the "every source failed"
   * guard, and leave the entry permanently due and never re-verified. The
   * descriptions stay in the source doc. Sales-only drafts may name a doc
   * section instead: the freshness pass only ever looks at published entries.
   */
  sources: string[];
  related: string[];
}

export const FAQ_SEED_ENTRIES: readonly FaqSeedEntry[] = [];
