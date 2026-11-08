// FAQ content type — shared constants and the server-side visibility filter.
// A plain allowlist + type guard, no DB enum. Unlike the distribution sites
// in src/lib/sites.ts — which became a per-org registry in G#18 — these stay a
// closed compile-time set: a FAQ category is an editorial taxonomy this app
// defines, not something a tenant registers.

export const FAQ_CATEGORIES = [
  "pricing",
  "self-hosting",
  "security",
  "hosted-fleet",
  "ci",
  "billing",
] as const;
export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

export const FAQ_AUDIENCES = ["public", "sales-only"] as const;
export type FaqAudience = (typeof FAQ_AUDIENCES)[number];
export const DEFAULT_FAQ_AUDIENCE: FaqAudience = "sales-only";

export const FAQ_STATUSES = ["draft", "review", "published"] as const;
export type FaqStatus = (typeof FAQ_STATUSES)[number];
export const DEFAULT_FAQ_STATUS: FaqStatus = "draft";

export const DEFAULT_VERIFY_EVERY_DAYS = 365;

export function isFaqCategory(value: unknown): value is FaqCategory {
  return typeof value === "string" && (FAQ_CATEGORIES as readonly string[]).includes(value);
}

export function isFaqAudience(value: unknown): value is FaqAudience {
  return typeof value === "string" && (FAQ_AUDIENCES as readonly string[]).includes(value);
}

export function isFaqStatus(value: unknown): value is FaqStatus {
  return typeof value === "string" && (FAQ_STATUSES as readonly string[]).includes(value);
}

/**
 * The ONLY place that decides what the public API may return. Both the list
 * and single-entry public routes filter through this — never re-derive the
 * condition inline — so a sales-only or non-published entry can never leak
 * through one route because the other route's copy of the filter drifted.
 */
export const PUBLIC_FAQ_WHERE = {
  status: "published" satisfies FaqStatus,
  audience: "public" satisfies FaqAudience,
} as const;
