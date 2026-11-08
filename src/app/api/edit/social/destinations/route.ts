import { NextRequest, NextResponse } from "next/server";
import { authorizeEdit } from "@/lib/edit-session";
import { canEditPost, editPostRefusalMessage } from "@/lib/rbac";
import {
  listPostDestinations,
  parseDestinationsSave,
  setPostDestinations,
} from "@/lib/post-social-delivery";

// The writer editor's Social tab: where this post's social copy goes
// (src/lib/post-social-delivery.ts).
//   GET → { data: { destinations, overridden, backlink } }
//   PUT { channel_ids: string[] | null } → the same, after saving the choice.
//       null goes back to the channels' own defaults.

const GONE = "This post no longer exists.";

export async function GET(req: NextRequest) {
  const session = await authorizeEdit(req, "content:view");
  if (session.error) return session.error;
  const data = await listPostDestinations(session.auth.db, session.post.id);
  if (!data) return NextResponse.json({ error: GONE }, { status: 404 });
  return NextResponse.json({ data }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const session = await authorizeEdit(req, "content:edit");
  if (session.error) return session.error;
  if (!canEditPost(session.auth.actor, session.post)) {
    return NextResponse.json({ error: editPostRefusalMessage(session.post) }, { status: 403 });
  }
  const parsed = parseDestinationsSave(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const data = await setPostDestinations(session.auth.db, session.post.id, parsed.channelIds);
  if (!data) return NextResponse.json({ error: GONE }, { status: 404 });
  return NextResponse.json({ data });
}
