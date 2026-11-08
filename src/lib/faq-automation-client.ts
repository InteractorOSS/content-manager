import { env } from "@/lib/env";
import type { FaqCategory, FaqAudience } from "@/lib/faq";

// CMS G#8 (FAQ intake automation). Calls this same app's own
// /api/automation/faq write API the way any external automation caller
// would — a personal access token over HTTP, not a direct Prisma write —
// so the structural "this path can never publish" guarantee in that route
// stays the ONE place that's enforced (see src/app/api/automation/faq).

export interface CreateFaqDraftInput {
  question: string;
  category: FaqCategory;
  audience: FaqAudience;
  answer?: string;
  sources?: string[];
}

export interface FaqAutomationResult {
  id: string;
}

function authorized(): boolean {
  return Boolean(env.FAQ_AUTOMATION_API_TOKEN);
}

/**
 * Draft a new FAQ entry (status=draft, set by the write API itself — this
 * client never sends a status). Returns null without making a request when
 * FAQ_AUTOMATION_API_TOKEN isn't configured, so the intake pipeline can log
 * and skip rather than throw in an environment where it hasn't been set up.
 */
export async function createFaqDraft(input: CreateFaqDraftInput): Promise<FaqAutomationResult | null> {
  if (!authorized()) return null;

  const response = await fetch(`${env.NEXTAUTH_URL}/api/automation/faq`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.FAQ_AUTOMATION_API_TOKEN}`,
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(`createFaqDraft failed: ${response.status} ${await response.text()}`);
  }

  const { data } = (await response.json()) as { data: { id: string } };
  return { id: data.id };
}

/** Increment asked_count on an existing FAQ entry via the write API. */
export async function incrementFaqAskedCount(id: string): Promise<void> {
  if (!authorized()) return;

  const response = await fetch(`${env.NEXTAUTH_URL}/api/automation/faq/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.FAQ_AUTOMATION_API_TOKEN}`,
    },
    body: JSON.stringify({ increment_asked_count: true }),
  });

  if (!response.ok) {
    throw new Error(`incrementFaqAskedCount failed: ${response.status} ${await response.text()}`);
  }
}

/**
 * Update last_verified only — the write BOTH freshness outcomes make via
 * this API. Deliberately never sends `answer` or `status`: proposing a new
 * answer is a FaqRevision row (src/lib/faq-freshness.ts creates it directly
 * via Prisma, since no write-API route exists for "propose a revision
 * without touching the live row" — the automation write API only edits the
 * Faq row itself, and editing a published row's `answer` in place is
 * exactly what must never happen).
 */
export async function touchFaqLastVerified(id: string, lastVerified: Date): Promise<void> {
  if (!authorized()) return;

  const response = await fetch(`${env.NEXTAUTH_URL}/api/automation/faq/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.FAQ_AUTOMATION_API_TOKEN}`,
    },
    body: JSON.stringify({ last_verified: lastVerified.toISOString() }),
  });

  if (!response.ok) {
    throw new Error(`touchFaqLastVerified failed: ${response.status} ${await response.text()}`);
  }
}
