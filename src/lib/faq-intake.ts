import { prisma } from "@/lib/db";
import { INTERACTOR_ORG_ID } from "@/lib/tenant-db";
import { PUBLIC_FAQ_WHERE, DEFAULT_FAQ_AUDIENCE } from "@/lib/faq";
import { matchFaqQuestion, guessFaqCategory } from "@/lib/faq/match";
import { createFaqDraft, incrementFaqAskedCount } from "@/lib/faq-automation-client";
import { sendSlackNotification } from "@/lib/slack";
import { env } from "@/lib/env";

// CMS G#8 (FAQ intake automation) — INTAKE half. Source is the website
// contact-form pipeline's new "question" type (POST /api/contacts), not
// Slack/email: see G#8's own description for why. Match-or-draft, one
// question at a time; every outcome is logged (src/lib/faq/match.ts's
// matchFaqQuestion already treats the question as untrusted data, not an
// instruction — this module doesn't add a second place that needs to
// remember that).

const DEFAULT_MAX_DRAFTS_PER_DAY = 20;

function maxDraftsPerDay(): number {
  const raw = process.env.FAQ_INTAKE_MAX_DRAFTS_PER_DAY;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_DRAFTS_PER_DAY;
}

function startOfToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Process one inbound question end to end: match against published entries,
 * increment asked_count on a match, or draft a new sales-only review entry
 * (rate-limited) on no match. Can throw (network/AI/write-API failures) —
 * the contact-form submission this runs after must still succeed either
 * way, so the caller (`/api/contacts`) fires this without awaiting it and
 * catches/logs rather than failing the request.
 */
export async function processFaqIntake(question: string): Promise<void> {
  const published = await prisma.faq.findMany({
    where: { organization_id: INTERACTOR_ORG_ID, ...PUBLIC_FAQ_WHERE },
    select: { id: true, question: true, answer: true },
  });

  const { matchedId, confidence } = await matchFaqQuestion(question, published);

  if (matchedId) {
    await incrementFaqAskedCount(matchedId);
    await prisma.faqIntakeLog.create({
      data: {
        organization_id: INTERACTOR_ORG_ID,
        question,
        outcome: "matched",
        matched_faq_id: matchedId,
        confidence,
      },
    });
    return;
  }

  const draftedToday = await prisma.faqIntakeLog.count({
    where: { organization_id: INTERACTOR_ORG_ID, outcome: "drafted", inserted_at: { gte: startOfToday() } },
  });
  if (draftedToday >= maxDraftsPerDay()) {
    await prisma.faqIntakeLog.create({
      data: { organization_id: INTERACTOR_ORG_ID, question, outcome: "rate_limited", confidence },
    });
    return;
  }

  const category = await guessFaqCategory(question);
  const draft = await createFaqDraft({
    question,
    category,
    audience: DEFAULT_FAQ_AUDIENCE,
    // No answer/sources: drafting a cited answer from public + repo docs
    // needs a doc-retrieval pipeline this goal doesn't build (see G#8's
    // description) — the write API's own "TODO" placeholder applies, same
    // as G#7's seeded stub entries.
  });

  await prisma.faqIntakeLog.create({
    data: {
      organization_id: INTERACTOR_ORG_ID,
      question,
      outcome: "drafted",
      confidence,
      created_faq_id: draft?.id ?? null,
    },
  });

  if (draft) {
    // No per-entry route exists in the CMS UI (src/app/(cms)/faqs/page.tsx
    // is a single table-driven page, not URL-addressable per entry) — link
    // to the list; the question text in this same message is how the
    // reviewer finds the right row.
    await sendSlackNotification("faq_draft", {
      question,
      url: `${env.NEXTAUTH_URL}/faqs`,
    });
  }
}
