import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/guard";

/**
 * Switch the caller's active organization (T5).
 *
 * Writes `User.current_organization_id`, which `resolveOrganizationId()` in
 * src/lib/rbac.ts treats as authoritative — see the ORDER MATTERS comment
 * there for why the column has to beat the session's sign-in-time snapshot,
 * and why this endpoint would otherwise appear to do nothing.
 */
export async function POST(req: NextRequest) {
  const { actor, error } = await requireActor();
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as {
    organization_id?: unknown;
  };
  const target =
    typeof body.organization_id === "string" ? body.organization_id : "";

  if (!target) {
    return NextResponse.json(
      { error: "An organization id is required." },
      { status: 400 }
    );
  }

  // Authorization: the target is checked against the caller's OWN memberships,
  // which came from their session — never from the request. A caller who
  // guesses another tenant's id gets 403 and their active org is untouched.
  const membership = actor.organizations.find((o) => o.id === target);
  if (!membership) {
    return NextResponse.json(
      { error: "You are not a member of that organization." },
      { status: 403 }
    );
  }

  await prisma.user.update({
    where: { id: actor.user.id },
    data: { current_organization_id: target },
  });

  return NextResponse.json({
    data: { current_organization_id: target, organization: membership },
  });
}
