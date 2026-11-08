import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { publishDuePosts } from "@/lib/social/publisher";

/**
 * Manual/cron scheduler tick: publishes every scheduled post whose time has
 * passed. The in-process interval (instrumentation.ts) calls the same
 * function; this route exists for external cron services and for admins to
 * force a run. The CRON_SECRET bearer is checked first and is NOT a PAT — it
 * has no organization or actor, it only proves "this is our cron", so it's
 * kept as its own literal header check rather than routed through
 * requirePermissionApi (which would try to resolve it as a personal access
 * token and correctly fail it).
 */
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (cronSecret && header === `Bearer ${cronSecret}`) {
    const processed = await publishDuePosts();
    return NextResponse.json({ data: { processed } });
  }

  const { error } = await requirePermissionApi(req, "content:publish");
  if (error) return error;

  const processed = await publishDuePosts();
  return NextResponse.json({ data: { processed } });
}
