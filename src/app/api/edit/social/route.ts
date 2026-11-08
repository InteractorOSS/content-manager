import { NextRequest, NextResponse } from "next/server";
import { authorizeEdit } from "@/lib/edit-session";
import { canEditPost, editPostRefusalMessage } from "@/lib/rbac";
import { listPostSocial, parseSocialSave, savePostSocial } from "@/lib/post-social";
import { syncPostSocialDelivery } from "@/lib/post-social-delivery";

// The writer editor's Social tab: the post's social copy per network
// (src/lib/post-social.ts), the same drafts save_social_draft writes.
//   GET → { data: PostSocialDraft[] }
//   PUT { network, body } → { data: PostSocialDraft | null }

export async function GET(req: NextRequest) {
  const session = await authorizeEdit(req, "content:view");
  if (session.error) return session.error;
  return NextResponse.json(
    { data: await listPostSocial(session.auth.db, session.post.id) },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function PUT(req: NextRequest) {
  const session = await authorizeEdit(req, "content:edit");
  if (session.error) return session.error;
  if (!canEditPost(session.auth.actor, session.post)) {
    return NextResponse.json({ error: editPostRefusalMessage(session.post) }, { status: 403 });
  }
  const parsed = parseSocialSave(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const saved = await savePostSocial(session.auth.db, {
    postId: session.post.id,
    ...parsed,
    userId: session.auth.actor.user.id,
  });
  // Attach the post's destinations and its backlink to the draft just saved.
  await syncPostSocialDelivery(session.auth.db, session.post.id);
  return NextResponse.json({ data: saved });
}
