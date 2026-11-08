import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { INTERACTOR_ORG_ID } from "@/lib/tenant-db";
import { sendSlackNotification } from "@/lib/slack";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { email, source } = body as { email?: string; source?: string };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
    }

    const existing = await prisma.waitlist.findUnique({ where: { email } });
    if (existing) {
      // alreadySubscribed lets the website show its duplicate flash; kept a
      // 200 because callers treat non-2xx as an outage and fall back to a
      // local insert, which would duplicate the lead.
      return NextResponse.json({
        success: true,
        alreadySubscribed: true,
        message: "Already on waitlist",
      });
    }

    const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0] ?? undefined;
    const userAgent = request.headers.get("user-agent") ?? undefined;

    // Public path with no actor — pin to the Interactor org (punchlist §P / D4).
    await prisma.waitlist.create({
      data: {
        organization_id: INTERACTOR_ORG_ID,
        email,
        source: source ?? null,
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
      },
    });

    await sendSlackNotification("waitlist", { email });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error("Waitlist signup error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET() {
  const { db, error } = await requirePermission("admin:access");
  if (error) return error;

  const entries = await db.waitlist.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json(entries);
}
