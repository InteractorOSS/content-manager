import { prisma } from "@/lib/db";
import { factsKeysIn, loadFacts, type FactsSource } from "@/lib/facts";
import { FAQ_SEED_ENTRIES, type FaqSeedEntry } from "@/lib/faq-seed-content";
import type { FaqStatus } from "@/lib/faq";

// CMS G#9 — seeds the customer cloud-cost & sizing FAQ entries (the content
// itself lives in src/lib/faq-seed-content.ts). Script-side, explicitly-global
// code: it uses the raw `prisma` client rather than a tenant-scoped one, the
// same as src/lib/faq-freshness.ts, and therefore sets organization_id
// explicitly on every single write.
//
// Two rules shape this file:
//  1. `--org` is required, never defaulted. Faq is org-scoped
//     (@@unique([organization_id, slug])), so guessing an org would write ten
//     rows into somebody else's tenant.
//  2. Re-running must be safe. Existing entries are SKIPPED, never silently
//     overwritten, so a human's post-seed edit survives a re-run; --force is
//     the explicit opt-in to overwrite, and even then asked_count is never
//     touched (it is intake's counter, not the seeder's).

/** A usage problem the operator can fix — printed as-is, no stack trace. */
export class FaqSeedUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaqSeedUsageError";
  }
}

export interface FaqSeedOptions {
  orgSlug?: string;
  force?: boolean;
  dryRun?: boolean;
}

export type FaqSeedAction = "created" | "updated" | "skipped" | "would-create" | "would-update" | "would-skip";

export interface FaqSeedEntryResult {
  slug: string;
  action: FaqSeedAction;
  /** The status actually written (or that would be) — may differ from the entry's, see the publish guard. */
  status: FaqStatus;
  /** Plain-language reason this entry was held back from `published`, when it was. */
  downgradeReason?: string;
}

export interface FaqSeedResult {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  dryRun: boolean;
  factsSource: FactsSource;
  entries: FaqSeedEntryResult[];
}

export function parseFaqSeedArgs(argv: string[]): FaqSeedOptions {
  const options: FaqSeedOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--org") options.orgSlug = argv[++i];
    else if (arg.startsWith("--org=")) options.orgSlug = arg.slice("--org=".length);
    else if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new FaqSeedUsageError(`Unrecognized argument "${arg}". Usage: npm run faq:seed -- --org <slug> [--force] [--dry-run]`);
  }
  return options;
}

// ─── The publish guard ───────────────────────────────────────────────────────

/**
 * Decide the status an entry is actually seeded with.
 *
 * An entry marked `published` whose answer resolves {{facts.<key>}} tokens at
 * read time is only honest if those facts are real. Today they are not: the
 * live facts endpoint does not exist yet, so facts.ts falls back to
 * `_facts.json`, whose own comment says its values are placeholders to be
 * replaced "before publishing any FAQ entry that resolves them". Publishing
 * such an entry would put invented figures on the unauthenticated public API
 * the instant the row is written.
 *
 * So: seed it as a draft instead, and say why. This is deliberately a runtime
 * check against the facts SOURCE rather than a hardcoded "leave it a draft" —
 * the entry becomes publishable automatically the moment real facts land,
 * with no stale human decision to remember to revisit.
 */
export function resolveSeedStatus(
  entry: Pick<FaqSeedEntry, "slug" | "status" | "answer">,
  factsSource: FactsSource
): { status: FaqStatus; downgradeReason?: string } {
  if (entry.status !== "published") return { status: entry.status };

  const keys = factsKeysIn(entry.answer);
  if (keys.length === 0 || factsSource === "endpoint") return { status: entry.status };

  return {
    status: "draft",
    downgradeReason:
      `Seeded as a draft rather than published: this answer fills in ${keys.map((k) => `"${k}"`).join(" and ")} ` +
      `from the placeholder values in _facts.json, because the live facts endpoint did not answer. ` +
      `Those numbers are stand-ins, not real product figures, and publishing would put them straight onto the public API. ` +
      `Put the real values in _facts.json (or ship the facts endpoint), then re-run with --force to publish this entry.`,
  };
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

async function resolveOrganization(orgSlug: string | undefined) {
  const organizations = await prisma.organization.findMany({
    select: { id: true, slug: true, name: true },
    orderBy: { slug: "asc" },
  });
  const available =
    organizations.length > 0
      ? organizations.map((o) => `  --org ${o.slug}   (${o.name})`).join("\n")
      : "  (none — create an organization in the CMS first)";

  if (!orgSlug) {
    throw new FaqSeedUsageError(
      `--org <slug> is required: FAQ entries belong to one organization, and this seeder will not guess which.\n` +
        `Available organizations:\n${available}`
    );
  }

  const organization = organizations.find((o) => o.slug === orgSlug);
  if (!organization) {
    throw new FaqSeedUsageError(`No organization with slug "${orgSlug}".\nAvailable organizations:\n${available}`);
  }
  return organization;
}

/**
 * Create the seed entries in one organization. Idempotent by
 * (organization_id, slug): an entry that already exists is skipped unless
 * `--force`, and `--dry-run` reports what would happen without writing.
 */
export async function runFaqSeed(options: FaqSeedOptions = {}): Promise<FaqSeedResult> {
  const organization = await resolveOrganization(options.orgSlug);
  const { source: factsSource } = await loadFacts();

  const entries: FaqSeedEntryResult[] = [];

  for (const entry of FAQ_SEED_ENTRIES) {
    const { status, downgradeReason } = resolveSeedStatus(entry, factsSource);

    const existing = await prisma.faq.findUnique({
      where: { organization_id_slug: { organization_id: organization.id, slug: entry.slug } },
      select: { id: true },
    });

    if (existing && !options.force) {
      entries.push({ slug: entry.slug, action: options.dryRun ? "would-skip" : "skipped", status });
      continue;
    }

    // asked_count is deliberately absent from both branches: it belongs to the
    // intake pipeline, and a re-seed must never reset how often a question was
    // actually asked.
    const content = {
      question: entry.question,
      answer: entry.answer,
      category: entry.category,
      audience: entry.audience,
      status,
      last_verified: entry.last_verified,
      verify_every_days: entry.verify_every_days,
      sources: entry.sources,
      related: entry.related,
    };

    if (existing) {
      if (!options.dryRun) await prisma.faq.update({ where: { id: existing.id }, data: content });
      entries.push({ slug: entry.slug, action: options.dryRun ? "would-update" : "updated", status, downgradeReason });
      continue;
    }

    if (!options.dryRun) {
      await prisma.faq.create({
        data: { organization_id: organization.id, slug: entry.slug, ...content },
      });
    }
    entries.push({ slug: entry.slug, action: options.dryRun ? "would-create" : "created", status, downgradeReason });
  }

  return {
    organizationId: organization.id,
    organizationSlug: organization.slug,
    organizationName: organization.name,
    dryRun: options.dryRun === true,
    factsSource,
    entries,
  };
}

/** The per-slug summary the CLI prints. Always printed, dry run or not. */
export function formatFaqSeedSummary(result: FaqSeedResult): string {
  const lines: string[] = [];
  lines.push(
    `FAQ seed — organization ${result.organizationName} (${result.organizationSlug})${result.dryRun ? " — DRY RUN, nothing written" : ""}`
  );
  for (const entry of result.entries) {
    lines.push(`  ${entry.action.padEnd(12)} ${entry.slug} [${entry.status}]`);
    if (entry.downgradeReason) lines.push(`      ${entry.downgradeReason}`);
  }

  const counts = result.entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.action] = (acc[e.action] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(
    Object.entries(counts)
      .map(([action, n]) => `${n} ${action}`)
      .join(", ")
  );
  if (counts.skipped) {
    lines.push("Skipped entries already exist and were left exactly as they are — re-run with --force to overwrite them.");
  }
  return lines.join("\n");
}
