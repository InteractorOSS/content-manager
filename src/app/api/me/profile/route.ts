import { NextRequest, NextResponse } from "next/server";
import { prisma, isUniqueViolation } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { updateAuthorProfile, validateProfilePatch } from "@/lib/author-profile";
import { authorDisplayName } from "@/lib/rbac";

// The signed-in person's own profile: the byline name they want on their
// posts, a short bio, and the entity fields (G#31) an author page and Person
// JSON-LD are built from. Session-only on purpose — this edits a person, not
// content, and a leaked content token has no business renaming its owner.
export async function GET() {
  const { actor, error } = await requirePermission();
  if (error) return error;
  const user = await prisma.user.findUnique({
    where: { id: actor.user.id },
    select: {
      email: true,
      name: true,
      display_name: true,
      bio: true,
      avatar_url: true,
      author_slug: true,
      job_title: true,
      same_as: true,
    },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // `byline` is what a new post will be credited as right now.
  return NextResponse.json({ data: { ...user, byline: authorDisplayName(user) } });
}

export async function PATCH(req: NextRequest) {
  const { actor, error } = await requirePermission();
  if (error) return error;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const parsed = validateProfilePatch(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const result = await updateAuthorProfile(prisma, actor.user, {
      display_name: parsed.display_name,
      bio: parsed.bio,
      author_slug: parsed.author_slug,
      job_title: parsed.job_title,
      same_as: parsed.same_as,
    });
    return NextResponse.json({ data: result });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "That author_slug is already taken" }, { status: 409 });
    }
    throw e;
  }
}
