import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyWebhookSignature, webhookSigningConfigured } from "@/lib/interactor";

/**
 * Interactor Core webhook receiver. Subscribed events:
 *   credential.ready / credential.expired / credential.revoked /
 *   credential.refresh_failed → keep channel status in sync so the UI can
 *   prompt for reconnection before a scheduled post fails.
 *
 * This route is unauthenticated by necessity (it is on the proxy's public
 * allowlist — Core has no CMS session), so the HMAC signature is the ONLY
 * thing standing between a stranger and a write to every matching tenant's
 * channels. Two refusals, deliberately distinct:
 *   503 — we have no secret to verify against; nobody can be authenticated.
 *   401 — we checked, and this delivery is not from Core.
 */
export async function POST(req: NextRequest) {
  if (!webhookSigningConfigured()) {
    console.error(
      "[interactor-webhook] refused a delivery: INTERACTOR_WEBHOOK_SECRET is not set, " +
        "so no delivery can be verified and social channel status will not stay in sync."
    );
    return NextResponse.json(
      {
        error:
          "This webhook receiver is not configured yet, so we can't tell a real " +
          "delivery from a forged one and nothing was changed. Set " +
          "INTERACTOR_WEBHOOK_SECRET to the signing secret from the Interactor Core " +
          "webhook registration and restart the app.",
      },
      { status: 503 }
    );
  }

  const rawBody = await req.text();
  const ok = verifyWebhookSignature(
    rawBody,
    req.headers.get("x-interactor-timestamp"),
    req.headers.get("x-interactor-signature")
  );
  if (!ok) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const credentialId =
    (event.data?.credential_id as string | undefined) ??
    (event.data?.id as string | undefined);

  if (event.type?.startsWith("credential.") && credentialId) {
    const statusByEvent: Record<string, string> = {
      "credential.ready": "active",
      "credential.expired": "expired",
      "credential.revoked": "revoked",
      "credential.refresh_failed": "error",
    };
    const status = statusByEvent[event.type];
    if (status) {
      await prisma.socialChannel.updateMany({
        where: { credential_id: credentialId },
        data: { status },
      });
    }
  }

  return NextResponse.json({ received: true });
}
