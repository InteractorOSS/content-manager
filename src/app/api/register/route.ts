import { NextRequest, NextResponse } from "next/server";

const AUTH_SERVER_URL =
  process.env.ACCOUNT_SERVER_URL || "https://auth.interactor.com";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { email?: string; password?: string };

  if (!body.email || !body.password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  // Self-serve signup (SMM-CONSOLIDATION-PUNCHLIST U1): the global
  // invitation gate that used to stand here is gone. It was the right rule
  // when one org owned the whole install and a new account could only ever be
  // an Interactor staff account; with tenancy, a stranger signing up gets an
  // organization of their own and can see nothing of anyone else's — the
  // tenant boundary, not the registration door, is what protects existing data.
  //
  // Invitation-only joining of an EXISTING org is unchanged: membership in
  // someone else's org still comes only from a pending invitation, applied on
  // first sign-in by applyPendingInvitation() in src/lib/rbac.ts. Signing up
  // without one lands you in your own org (ensureOwnOrganization), never in
  // an existing tenant.
  let res: Response;
  try {
    res = await fetch(`${AUTH_SERVER_URL}/api/v1/admin/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: body.email, password: body.password }),
    });
  } catch {
    return NextResponse.json({ error: "Auth server unreachable." }, { status: 502 });
  }

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
