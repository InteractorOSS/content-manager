import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";

type Ctx = { params: Promise<{ slug: string }> };

// Only GET (public read) gets CORS, per D5 — POST stays a same-origin/
// server-side write, so the preflight response advertises GET only.
export const OPTIONS = publicCorsPreflight;

function formatComment(c: {
  id: string;
  author_name: string;
  content: string;
  inserted_at: Date;
}) {
  return {
    id: c.id,
    author_name: c.author_name,
    content: c.content,
    inserted_at: c.inserted_at.toISOString(),
  };
}

// GET: published comments for a post, oldest first. Public, unauthenticated
// — no different from reading the post itself.
export const GET = withPublicCors(async function GET(_req: NextRequest, { params }: Ctx) {
  const { slug } = await params;

  const post = await prisma.post.findFirst({ where: { slug }, select: { id: true } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const comments = await prisma.comment.findMany({
    where: { post_id: post.id, status: "published" },
    orderBy: { inserted_at: "asc" },
    select: { id: true, author_name: true, content: true, inserted_at: true },
  });

  return NextResponse.json({ data: comments.map(formatComment) });
});

// POST: submit a new comment. Public, unauthenticated — every new comment
// lands as "pending", never auto-published (see schema.prisma's Comment
// model doc comment for why). The consuming website's own spam-guard runs
// before this is ever called; this endpoint does basic field validation
// only, matching the existing style of /api/contacts and /api/newsletter
// (neither of which layers spam protection here either).
export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;

  const post = await prisma.post.findFirst({
    where: { slug, status: "published" },
    select: { id: true },
  });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const authorName = typeof body?.author_name === "string" ? body.author_name.trim() : "";
  const authorEmail = typeof body?.author_email === "string" ? body.author_email.trim() : "";
  const content = typeof body?.content === "string" ? body.content.trim() : "";

  if (!authorName || !authorEmail || !content) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }
  if (content.length > 2000) {
    return NextResponse.json({ error: "Comment is too long" }, { status: 400 });
  }

  const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0] ?? undefined;
  const userAgent = req.headers.get("user-agent") ?? undefined;

  const comment = await prisma.comment.create({
    data: {
      post_id: post.id,
      author_name: authorName,
      author_email: authorEmail,
      content,
      status: "pending",
      ip_address: ipAddress ?? null,
      user_agent: userAgent ?? null,
    },
  });

  return NextResponse.json({ data: { id: comment.id, status: comment.status } }, { status: 201 });
}
