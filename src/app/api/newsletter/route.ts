import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { INTERACTOR_ORG_ID } from "@/lib/tenant-db";
import { sendSlackNotification } from "@/lib/slack";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { email, firstName, lastName, company, source } = body as {
      email?: string;
      firstName?: string;
      lastName?: string;
      company?: string;
      source?: string;
    };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
    }

    // Public path pinned to the Interactor org (punchlist §P / D4); email
    // uniqueness is now per-org, so the dedupe check is scoped to that org too.
    const existing = await prisma.newsletterSubscription.findFirst({
      where: { email, organization_id: INTERACTOR_ORG_ID },
    });
    if (existing) {
      if (existing.status === "active") {
        // alreadySubscribed lets the website show its duplicate flash; kept a
        // 200 because callers treat non-2xx as an outage and fall back to a
        // local insert, which would duplicate the lead.
        return NextResponse.json({
          success: true,
          alreadySubscribed: true,
          message: "Already subscribed",
        });
      }
      // Re-subscribe
      await prisma.newsletterSubscription.update({
        where: { id: existing.id },
        data: { status: "active", confirmedAt: new Date() },
      });
      return NextResponse.json({ success: true });
    }

    await prisma.newsletterSubscription.create({
      data: {
        organization_id: INTERACTOR_ORG_ID,
        email,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        company: company ?? null,
        source: source ?? null,
        confirmedAt: new Date(),
      },
    });

    await sendSlackNotification("newsletter", { email });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error("Newsletter subscription error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET() {
  const { db, error } = await requirePermission("admin:access");
  if (error) return error;

  const subscriptions = await db.newsletterSubscription.findMany({
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(subscriptions);
}
