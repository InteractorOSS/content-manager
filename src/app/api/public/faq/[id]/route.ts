import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { PUBLIC_FAQ_WHERE } from "@/lib/faq";
import { getFacts } from "@/lib/facts";
import { formatPublicFaq } from "../route";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";

type Ctx = { params: Promise<{ id: string }> };

export const OPTIONS = publicCorsPreflight;

// The `id` segment is the FAQ's human-readable slug (e.g.
// "self-hosting-cloud-cost") — see the comment on Faq.slug in schema.prisma.
// `findFirst` with PUBLIC_FAQ_WHERE spread in means a sales-only or
// non-published entry 404s here exactly as if it didn't exist — there is no
// separate authenticated path through this route to leak it by id.
export const GET = withPublicCors(async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;

  const faq = await prisma.faq.findFirst({
    where: { slug: id, ...PUBLIC_FAQ_WHERE },
  });
  if (!faq) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const facts = await getFacts();
  return NextResponse.json({ data: formatPublicFaq(faq, facts) });
});
