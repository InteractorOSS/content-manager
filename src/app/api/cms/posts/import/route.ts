import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { applyPostImport } from "@/lib/post-sync";

/**
 * Import a single `.md` file (frontmatter + body) — the write side of
 * FILE-BASED-CONTENT-PLAN.md Phase 1. See src/lib/post-sync.ts for the
 * actual upsert/conflict/publish-gating rules, shared with the inbound
 * GitHub webhook (Phase 2).
 */
export async function POST(req: NextRequest) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:create");
  if (error) return error;

  const body = await req.json().catch(() => null) as { raw?: string; filename?: string } | null;
  if (!body?.raw) {
    return NextResponse.json({ error: "raw file content is required" }, { status: 400 });
  }

  const force = req.nextUrl.searchParams.get("force") === "true";
  const result = await applyPostImport({
    raw: body.raw,
    filename: body.filename,
    actor,
    db,
    force,
    onConflict: "reject",
    siteScope: apiToken?.site_scopes,
  });

  switch (result.kind) {
    case "error":
      return NextResponse.json(
        { error: result.message, ...(result.details && { details: result.details }) },
        { status: result.status }
      );
    case "conflict":
      return NextResponse.json(result.conflict, { status: 409 });
    case "applied": {
      const response: Record<string, unknown> = { data: result.post, created: result.created };
      if (result.warning) response.warning = result.warning;
      return NextResponse.json(response, { status: result.created ? 201 : 200 });
    }
  }
}
