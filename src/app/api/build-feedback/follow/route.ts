import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { followItem, unfollowItem, BuildFeedbackError, type CombinedItemType } from "@/lib/build-feedback";

async function handle(request: NextRequest, follow: boolean) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    type?: CombinedItemType;
    targetId?: string;
  } | null;
  if (!body?.type || !body.targetId) {
    return NextResponse.json({ error: "Missing type or targetId" }, { status: 400 });
  }

  try {
    const result = follow
      ? await followItem(session.user.email, body.type, body.targetId)
      : await unfollowItem(session.user.email, body.type, body.targetId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BuildFeedbackError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function POST(request: NextRequest) {
  return handle(request, true);
}

export async function DELETE(request: NextRequest) {
  return handle(request, false);
}
