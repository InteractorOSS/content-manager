import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { voteItem, BuildFeedbackError, type CombinedItemType, type ViewerVote } from "@/lib/build-feedback";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    type?: CombinedItemType;
    targetId?: string;
    value?: ViewerVote;
  } | null;
  if (!body?.type || !body.targetId || body.value === undefined) {
    return NextResponse.json({ error: "Missing type, targetId, or value" }, { status: 400 });
  }

  try {
    const result = await voteItem(session.user.email, body.type, body.targetId, body.value);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BuildFeedbackError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
