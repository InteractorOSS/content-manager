import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import {
  canGrantRole,
  isOrganizationRole,
  roleGrantDenial,
} from "@/lib/member-roles";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  // Proof of the T4 tenant scope: `db` auto-filters invitations to the actor's
  // org — no explicit `where: { organization_id }` needed here.
  const { db, error } = await requirePermission("users:view");
  if (error) return error;

  const status = req.nextUrl.searchParams.get("status");
  const invitations = await db.invitation.findMany({
    where: status ? { status } : {},
    include: { invited_by: { select: { id: true, name: true, email: true } } },
    orderBy: { inserted_at: "desc" },
  });

  return NextResponse.json({
    data: invitations.map((i) => ({
      id: i.id,
      email: i.email,
      name: i.name,
      role_name: i.role_name,
      status: i.status,
      notes: i.notes,
      invited_by: i.invited_by,
      expires_at: i.expires_at.toISOString(),
      accepted_at: i.accepted_at?.toISOString() ?? null,
      last_sent_at: i.last_sent_at?.toISOString() ?? null,
      inserted_at: i.inserted_at.toISOString(),
    })),
  });
}

/**
 * Invite a teammate. The account itself lives on auth.interactor.com; when that
 * email first signs in here, provisioning applies the invited role and marks
 * the invitation accepted.
 *
 * SECURITY: an invitation is a DEFERRED role grant — applyPendingInvitation()
 * writes Membership.role from `role_name` at first sign-in — so it has to obey
 * the same rules as changing a sitting member's role. It did not, which left
 * the escalation PUT /api/users/[id]/roles refuses wide open one tab over: a
 * users:create holder could invite an address they control as "owner" (or,
 * while applyPendingInvitation still minted user_roles, as a real cross-tenant
 * "super_admin") and sign in as it. Both refusals below are the control; the
 * dialog's filtered picker is only a courtesy.
 */
export async function POST(req: NextRequest) {
  const { actor, db, error } = await requirePermission("users:create");
  if (error) return error;

  const body = (await req.json()) as {
    email?: string;
    name?: string;
    role_name?: string;
    notes?: string;
  };

  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
  }

  const roleName = body.role_name?.trim() || "author";
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role || !role.active) {
    return NextResponse.json(
      { error: `"${roleName}" isn't a role you can assign. Pick one from the role list.` },
      { status: 400 }
    );
  }

  // Same rule, same wording as the members editor (src/lib/member-roles.ts):
  // only an owner or a super administrator hands out "owner", and only a super
  // administrator hands out "super_admin". Refused before anything is written,
  // so no Invitation row exists to be accepted later.
  if (!canGrantRole(actor, roleName)) {
    return NextResponse.json({ error: roleGrantDenial(roleName) }, { status: 403 });
  }

  // Even for a super administrator, "super_admin" is not an ORG role: an
  // invitation only ever writes Membership.role, so inviting someone as
  // super_admin would quietly produce a member whose org role is the string
  // "super_admin" — which grants nothing, yet reads as though it grants
  // everything. The global grant is a separate, deliberate action.
  if (!isOrganizationRole(roleName)) {
    return NextResponse.json(
      {
        error:
          "Super administrator is a global role, not an organization role. Invite this person with an organization role, then grant super administrator from the Members tab once they have signed in.",
      },
      { status: 400 }
    );
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json(
      { error: "A user with this email already exists — assign roles directly instead" },
      { status: 409 }
    );
  }

  const pending = await db.invitation.findFirst({
    where: { email, status: "pending" },
  });
  if (pending) {
    return NextResponse.json(
      { error: "A pending invitation for this email already exists" },
      { status: 409 }
    );
  }

  const invitation = await db.invitation.create({
    data: {
      email,
      name: body.name || null,
      role_name: roleName,
      // Org-scoped (T3): invite into the inviter's current org, so first
      // sign-in provisions a Membership there (see applyPendingInvitation).
      // organization_id is injected automatically by the tenant-scoped `db`.
      notes: body.notes || null,
      token: randomUUID(),
      expires_at: new Date(Date.now() + INVITATION_TTL_MS),
      last_sent_at: new Date(),
      invited_by_id: actor.user.id,
    },
  });

  return NextResponse.json(
    {
      data: {
        id: invitation.id,
        email: invitation.email,
        role_name: invitation.role_name,
        status: invitation.status,
        expires_at: invitation.expires_at.toISOString(),
      },
    },
    { status: 201 }
  );
}
