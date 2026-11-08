import { NextRequest, NextResponse } from "next/server";
import { etagOf } from "@/lib/post-edit-keys";
import { authorizeEdit, editDocToFile, notModified, parseDetails, saveEdit, toEditDoc } from "@/lib/edit-session";
import { prisma } from "@/lib/db";
import { trashPosts } from "@/lib/post-trash";

// The writer editor's endpoint (/write): the same editing session as the
// plugin's /api/edit/file, but as JSON the browser page can use directly —
// title, excerpt and the Markdown body — instead of a frontmatter file.
//
//   GET  → { data: EditDoc }, ETag = version (If-None-Match → 304)
//   PUT  → { title?, excerpt?, body, details? } with If-Match; `details` is
//          the Details panel (slug, category, tags, sites, featured image,
//          SEO fields), any subset. Every other frontmatter key comes from the
//          post itself, so nothing the page doesn't show can be dropped by
//          saving from it.
//   DELETE → move the post to the trash (content:delete) and end the session.

function docResponse(doc: ReturnType<typeof toEditDoc>, warning?: string): NextResponse {
  return NextResponse.json(
    { data: doc, ...(warning && { warning }) },
    { headers: { etag: etagOf(doc.version), "cache-control": "no-store" } }
  );
}

export async function GET(req: NextRequest) {
  const session = await authorizeEdit(req, "content:view");
  if (session.error) return session.error;
  return notModified(req, session.post) ?? docResponse(toEditDoc(session.post, session.auth));
}

export async function PUT(req: NextRequest) {
  const session = await authorizeEdit(req, "content:edit");
  if (session.error) return session.error;

  const body = (await req.json().catch(() => null)) as {
    title?: unknown;
    excerpt?: unknown;
    body?: unknown;
    details?: unknown;
  } | null;
  if (!body || typeof body.body !== "string") {
    return NextResponse.json({ error: "body (the post's Markdown) is required" }, { status: 400 });
  }
  if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim())) {
    return NextResponse.json({ error: "The title can't be empty." }, { status: 400 });
  }
  if (body.excerpt !== undefined && typeof body.excerpt !== "string") {
    return NextResponse.json({ error: "excerpt must be a string" }, { status: 400 });
  }
  const details = parseDetails(body.details);
  if ("error" in details) return NextResponse.json({ error: details.error }, { status: 400 });
  if (session.post.content_format !== "markdown") {
    return NextResponse.json(
      { error: "This post is stored as HTML, which the writer editor can't edit. Open it in the CMS editor." },
      { status: 409 }
    );
  }

  const raw = editDocToFile(session.post, {
    title: body.title as string | undefined,
    excerpt: body.excerpt as string | undefined,
    body: body.body,
    details: details.details,
  });
  const result = await saveEdit(req, session.auth, session.post, raw);
  if (result.error) return result.error;
  return docResponse(toEditDoc(result.saved, session.auth), result.warning);
}

export async function DELETE(req: NextRequest) {
  const session = await authorizeEdit(req, "content:delete");
  if (session.error) return session.error;
  await trashPosts(session.auth.db, [session.post], session.auth.actor);
  await prisma.postEditKey.updateMany({ where: { post_id: session.post.id, revoked_at: null }, data: { revoked_at: new Date() } });
  return new NextResponse(null, { status: 204 });
}
