import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { initiateOAuth, InteractorError } from "@/lib/interactor";
import { env } from "@/lib/env";

function formatConnection(c: {
  inserted_at: Date;
  updated_at: Date;
  [key: string]: unknown;
}) {
  return { ...c, inserted_at: c.inserted_at.toISOString(), updated_at: c.updated_at.toISOString() };
}

export async function GET() {
  const { error } = await requirePermission("content:view");
  if (error) return error;

  const connection = await prisma.contentSyncConnection.findFirst({
    orderBy: { inserted_at: "desc" },
    include: { connected_by: { select: { id: true, name: true, email: true } } },
  });
  return NextResponse.json({ data: connection ? formatConnection(connection) : null });
}

/**
 * Connect the content repo: creates a pending connection row and starts
 * Interactor's hosted OAuth flow for the "github" SKB service, same shape
 * as /api/social/channels. The response's authorization_url is where the
 * browser redirects; GitHub authorizes, Interactor sends the browser back
 * to /api/content-sync/connect/callback with a credential_id.
 */
export async function POST(req: NextRequest) {
  const { actor, error } = await requirePermission("admin:settings");
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { repo?: string; branch?: string };
  const repo = String(body.repo ?? "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return NextResponse.json({ error: 'repo must look like "owner/repo"' }, { status: 400 });
  }

  const connection = await prisma.contentSyncConnection.create({
    data: {
      service_id: "github",
      external_user_id: actor.user.id,
      repo,
      branch: body.branch?.trim() || "main",
      status: "pending",
      connected_by_id: actor.user.id,
    },
  });

  try {
    const flow = await initiateOAuth({
      serviceId: "github",
      externalUserId: actor.user.id,
      scopes: ["repo"],
      successRedirectUrl: `${env.NEXTAUTH_URL}/api/content-sync/connect/callback?connection_id=${connection.id}`,
      metadata: { connection_id: connection.id, app: "content-management" },
    });
    return NextResponse.json(
      {
        data: {
          connection: formatConnection(connection),
          authorization_url: flow.authorization_url,
          flow_id: flow.flow_id,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    await prisma.contentSyncConnection.delete({ where: { id: connection.id } });
    const message =
      err instanceof InteractorError ? err.message : "Failed to start OAuth flow";
    const status = err instanceof InteractorError && err.status === 402 ? 402 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE() {
  const { error } = await requirePermission("admin:settings");
  if (error) return error;

  await prisma.contentSyncConnection.deleteMany({});
  return new NextResponse(null, { status: 204 });
}
