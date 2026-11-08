import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";
import { tenantDb } from "@/lib/tenant-db";
import { orgSites } from "@/lib/sites-server";

/**
 * The sites a token for `?organization_id=` may be scoped to (G#21) — exactly
 * the list POST /api/cms/tokens validates `site_scopes` against.
 *
 * Not GET /api/cms/sites: that answers for the caller's ACTIVE org and also
 * folds in unregistered slugs already in use, so the minting dialog would show
 * the wrong org's sites whenever a multi-org user picks another org, and offer
 * slugs the mint would then refuse. Session-only like the rest of /tokens.
 */
export async function GET(req: NextRequest) {
  const { actor, error } = await requirePermission();
  if (error) return error;

  const organizationId =
    req.nextUrl.searchParams.get("organization_id")?.trim() || actor.organizationId;
  // Membership in the named org is the authorization — a guessed id is a 403,
  // never another tenant's site list.
  if (!organizationId || !actor.organizations.some((o) => o.id === organizationId)) {
    return NextResponse.json(
      { error: "You are not a member of that organization" },
      { status: 403 }
    );
  }

  return NextResponse.json({ data: await orgSites(tenantDb(organizationId)) });
}
