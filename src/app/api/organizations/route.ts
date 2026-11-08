import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireActor } from "@/lib/guard";
import { createOrganizationWithOwner } from "@/lib/organizations";

/**
 * The caller's own organizations (T5). Never a directory of all orgs — the
 * list is read straight off the actor's memberships, so there is no id a
 * caller could supply to see someone else's tenant.
 */
export async function GET() {
  const { actor, error } = await requireActor();
  if (error) return error;

  // Same element shape as /api/me's `organizations`, so both feed the switcher.
  return NextResponse.json({
    data: actor.organizations.map((o) => ({
      ...o,
      active: o.id === actor.organizationId,
    })),
    meta: { current_organization_id: actor.organizationId },
  });
}

const MAX_NAME_LENGTH = 120;

/**
 * Create an organization; the caller becomes its owner.
 *
 * Authenticated-but-membership-less callers are allowed on purpose — that is
 * the self-serve signup path (U1). Nothing here reads an org id from the
 * request, so this cannot be used to touch an existing tenant.
 */
export async function POST(req: NextRequest) {
  const { actor, error } = await requireActor();
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    return NextResponse.json(
      { error: "An organization name is required." },
      { status: 400 }
    );
  }
  // Bounded before it reaches the database: `name` is untrusted input on a
  // column with no length cap of its own.
  if (name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `Organization name must be ${MAX_NAME_LENGTH} characters or fewer.` },
      { status: 400 }
    );
  }

  try {
    const org = await createOrganizationWithOwner(actor.user.id, name);
    return NextResponse.json({ data: org }, { status: 201 });
  } catch (e) {
    // Lost the slug race against a concurrent create (see deriveUniqueOrgSlug).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { error: "That organization name is already taken. Try another." },
        { status: 409 }
      );
    }
    throw e;
  }
}
