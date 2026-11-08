import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";

// Matches the admin gating already used for the other submission-review
// surfaces (contacts/newsletter/waitlist all use admin:access, not a
// dedicated content:* permission) — kept consistent rather than
// introducing a new permission just for this one surface.
export async function GET(req: NextRequest) {
  const { actor, db, error } = await requirePermissionApi(req, "admin:access");
  if (error) return error;

  const status = req.nextUrl.searchParams.get("status");

  // Comment has no organization_id of its own; it inherits its tenant from the
  // parent Post (see tenant-db.ts). Scope by the parent so this admin list
  // can't surface another org's comments.
  // A null org (an actor with no membership) can't own any post, so the ""
  // fallback simply matches nothing rather than leaking — Post.organization_id
  // is NOT NULL, so no row equals "".
  const comments = await db.comment.findMany({
    where: {
      ...(status ? { status } : {}),
      post: { organization_id: actor.organizationId ?? "" },
    },
    orderBy: { inserted_at: "desc" },
    include: { post: { select: { title: true, slug: true } } },
  });

  return NextResponse.json(
    comments.map((c) => ({
      id: c.id,
      postId: c.post_id,
      postTitle: c.post.title,
      postSlug: c.post.slug,
      authorName: c.author_name,
      authorEmail: c.author_email,
      content: c.content,
      status: c.status,
      ipAddress: c.ip_address,
      userAgent: c.user_agent,
      createdAt: c.inserted_at.toISOString(),
      updatedAt: c.updated_at.toISOString(),
    })),
  );
}
