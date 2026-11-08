import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCredential } from "@/lib/interactor";

/**
 * Landing point for Interactor's hosted OAuth success redirect:
 *   ?connection_id=<ours>&credential_id=<interactor>
 * Activates the pending connection and bounces the browser to the settings
 * page. Mirrors /api/social/channels/callback.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const connectionId = url.searchParams.get("connection_id");
  const credentialId = url.searchParams.get("credential_id");

  const dest = (query: string) =>
    NextResponse.redirect(new URL(`/settings/content-sync?${query}`, req.url));

  if (!connectionId || !credentialId) {
    return dest("connected=0&reason=missing_params");
  }

  const connection = await prisma.contentSyncConnection.findUnique({
    where: { id: connectionId },
  });
  if (!connection) return dest("connected=0&reason=unknown_connection");

  let metadata: { credential_status: string | null; scopes: string[] | null } | undefined;
  try {
    const cred = await getCredential(credentialId);
    if (cred) {
      metadata = { credential_status: cred.status ?? null, scopes: cred.scopes ?? null };
    }
  } catch {
    // identity enrichment is best-effort
  }

  await prisma.contentSyncConnection.update({
    where: { id: connection.id },
    data: { credential_id: credentialId, status: "active", ...(metadata ? { metadata } : {}) },
  });

  return dest("connected=1");
}
