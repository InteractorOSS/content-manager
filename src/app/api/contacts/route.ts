import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { INTERACTOR_ORG_ID } from "@/lib/tenant-db";
import { sendSlackNotification } from "@/lib/slack";
import { processFaqIntake } from "@/lib/faq-intake";

// Public: Submit a contact form
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { firstName, lastName, email, company, jobTitle, phone, productInterest, country, subject, message, type, source } = body as {
      firstName?: string;
      lastName?: string;
      email?: string;
      company?: string;
      jobTitle?: string;
      phone?: string;
      productInterest?: string;
      country?: string;
      subject?: string;
      message?: string;
      type?: string;
      source?: string;
    };

    if (!firstName || !lastName || !email || !message) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Parity with the old CMS: demo and AI-assessment requests also require
    // company, product interest, and country.
    if (type === "demo" || type === "ai_assessment") {
      const missing = [
        !company && "company",
        !productInterest && "productInterest",
        !country && "country",
      ].filter(Boolean);
      if (missing.length > 0) {
        return NextResponse.json(
          { error: `Missing required fields for ${type}: ${missing.join(", ")}` },
          { status: 400 }
        );
      }
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
    }

    const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? undefined;
    const userAgent = request.headers.get("user-agent") ?? undefined;

    // Public, unauthenticated write: no actor to scope by, so pin to the
    // Interactor org (punchlist §P / D4). Uses the raw client deliberately.
    const submission = await prisma.contactSubmission.create({
      data: {
        organization_id: INTERACTOR_ORG_ID,
        firstName,
        lastName,
        email,
        company: company ?? null,
        jobTitle: jobTitle ?? null,
        phone: phone ?? null,
        productInterest: productInterest ?? null,
        country: country ?? null,
        subject: subject ?? null,
        message,
        type: type ?? "contact",
        source: source ?? null,
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
      },
    });

    await sendSlackNotification(type ?? "contact", { firstName, lastName, email, company });

    // Fire-and-forget: `next start` is a persistent process (see
    // deploy/systemd/), not serverless, so this keeps running after the
    // response returns. A "question" submission must still succeed even if
    // FAQ intake fails downstream (AI/write-API errors) — never let it
    // fail the contact-form request.
    if (type === "question") {
      processFaqIntake(message).catch((e) => console.error("FAQ intake failed:", e));
    }

    return NextResponse.json({ success: true, id: submission.id }, { status: 201 });
  } catch (error) {
    console.error("Contact submission error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// Admin: List contact submissions
export async function GET(request: NextRequest) {
  const { db, error } = await requirePermission("admin:access");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const type = searchParams.get("type");

  const submissions = await db.contactSubmission.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(submissions);
}
