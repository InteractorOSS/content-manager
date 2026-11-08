import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/guard";
import { canManageOrgSettings, slugifyOrgName } from "@/lib/organizations";

const MAX_NAME_LENGTH = 120;

/**
 * Resolve the caller's membership in `id`, or the response to return instead.
 *
 * Both failure modes answer 403 rather than 404, and deliberately use the same
 * wording: distinguishing "no such org" from "not your org" would let any
 * signed-in user probe which org ids exist.
 */
function membershipOr403(
  actor: { organizations: Array<{ id: string; role: string }> },
  id: string
) {
  const membership = actor.organizations.find((o) => o.id === id);
  if (!membership) {
    return {
      error: NextResponse.json(
        { error: "You are not a member of that organization." },
        { status: 403 }
      ),
    };
  }
  return { membership };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { actor, error } = await requireActor();
  if (error) return error;

  const check = membershipOr403(actor, id);
  if (check.error) return check.error;

  const org = await prisma.organization.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      branding: true,
      same_as: true,
      inserted_at: true,
    },
  });
  if (!org) {
    return NextResponse.json({ error: "Organization not found." }, { status: 404 });
  }

  return NextResponse.json({ data: { ...org, role: check.membership.role } });
}

/** Update org settings. Owners and admins only — see ORG_SETTINGS_ROLES. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { actor, error } = await requireActor();
  if (error) return error;

  const check = membershipOr403(actor, id);
  if (check.error) return check.error;

  if (!canManageOrgSettings(check.membership.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin can change organization settings." },
      { status: 403 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Prisma.OrganizationUpdateInput = {};

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json(
        { error: "An organization name is required." },
        { status: 400 }
      );
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Organization name must be ${MAX_NAME_LENGTH} characters or fewer.` },
        { status: 400 }
      );
    }
    data.name = name;
  }

  if (typeof body.slug === "string") {
    // Normalize rather than reject: the slug is a URL handle, so a pasted
    // "My Org" becomes "my-org" instead of erroring on a space.
    const slug = slugifyOrgName(body.slug);
    if (!slug) {
      return NextResponse.json(
        { error: "Slug must contain at least one letter or number." },
        { status: 400 }
      );
    }
    data.slug = slug;
  }

  if (typeof body.logo === "string" || body.logo === null) {
    data.logo = body.logo as string | null;
  }
  if (body.branding !== undefined) {
    data.branding = body.branding as Prisma.InputJsonValue;
  }
  // Resolved seo block JSON-LD `sameAs` (G#33): canonical profile URLs tying
  // the Organization node to one real entity.
  if (Array.isArray(body.same_as) && body.same_as.every((v) => typeof v === "string")) {
    data.same_as = (body.same_as as string[]).map((v) => v.trim()).filter(Boolean);
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  try {
    const org = await prisma.organization.update({
      where: { id },
      data,
      select: { id: true, name: true, slug: true, logo: true, branding: true, same_as: true },
    });
    return NextResponse.json({ data: { ...org, role: check.membership.role } });
  } catch (e) {
    // Slug is globally unique — surface the clash instead of a 500.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { error: "That slug is already in use. Choose another." },
        { status: 409 }
      );
    }
    throw e;
  }
}
