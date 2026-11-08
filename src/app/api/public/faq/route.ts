import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { PUBLIC_FAQ_WHERE, isFaqCategory } from "@/lib/faq";
import { getFacts, substituteFacts, UnknownFactsKeyError } from "@/lib/facts";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";

export const OPTIONS = publicCorsPreflight;

// Public, unauthenticated (see src/proxy.ts's /api/public prefix allowlist).
// The published+public filter lives ONLY in PUBLIC_FAQ_WHERE — never repeat
// it inline here or in the [id] route, so the two routes can't drift apart.
export const GET = withPublicCors(async function GET(req: NextRequest) {
  const category = req.nextUrl.searchParams.get("category");
  if (category && !isFaqCategory(category)) {
    return NextResponse.json({ error: `Unknown category "${category}"` }, { status: 400 });
  }

  const where: Record<string, unknown> = { ...PUBLIC_FAQ_WHERE };
  if (category) where.category = category;

  const faqs = await prisma.faq.findMany({
    where,
    orderBy: [{ category: "asc" }, { question: "asc" }],
  });

  const facts = await getFacts();
  return NextResponse.json({ data: faqs.map((faq) => formatPublicFaq(faq, facts)) });
});

export function formatPublicFaq(
  faq: {
    slug: string;
    question: string;
    answer: string;
    category: string;
    last_verified: Date | null;
    verify_every_days: number;
    sources: string[];
    related: string[];
    asked_count: number;
  },
  facts: Record<string, string | number>
) {
  let answer = faq.answer;
  let answer_error: string | null = null;
  try {
    answer = substituteFacts(faq.answer, facts);
  } catch (e) {
    if (!(e instanceof UnknownFactsKeyError)) throw e;
    answer_error = e.message;
  }

  return {
    id: faq.slug,
    question: faq.question,
    answer,
    answer_error,
    category: faq.category,
    last_verified: faq.last_verified?.toISOString() ?? null,
    verify_every_days: faq.verify_every_days,
    sources: faq.sources,
    related: faq.related,
    asked_count: faq.asked_count,
  };
}
