import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";
import { prisma } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ContactDetailActions } from "@/components/cms/contact-detail-actions";
import { formatDateTime } from "@/lib/utils";
import { auth } from "@/lib/auth";
import { hasPermission, loadActor } from "@/lib/rbac";
import { requirePageActor } from "@/lib/server-actor";
import type { Metadata } from "next";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    // Best-effort only — never redirect from metadata generation. The page
    // body below is what actually enforces the session/permission/org gate.
    const session = await auth();
    if (!session?.user) return { title: "Contact" };
    const actor = await loadActor(session.user);
    if (!actor?.organizationId || !hasPermission(actor, "admin:access")) {
      return { title: "Contact" };
    }
    const submission = await prisma.contactSubmission.findFirst({
      where: { id, organization_id: actor.organizationId },
    });
    if (!submission) return { title: "Not Found" };
    return { title: `${submission.firstName} ${submission.lastName} — Contact` };
  } catch {
    return { title: "Contact" };
  }
}

function TypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    contact: "Contact",
    demo: "Demo",
    support: "Support",
    ai_assessment: "AI Assessment",
  };
  return (
    <Badge variant="outline" className="text-xs capitalize">
      {labels[type] ?? type}
    </Badge>
  );
}

export default async function ContactDetailPage({ params }: Props) {
  const { id } = await params;

  // Same permission and org scope as GET /api/contacts/[id] — this page
  // reads via the raw `prisma` client (a Server Component can't hold the
  // request-scoped `db` requirePermission() hands to route handlers), so
  // both checks have to be applied explicitly here.
  const actor = await requirePageActor();
  if (!actor.organizationId || !hasPermission(actor, "admin:access")) notFound();

  const raw = await prisma.contactSubmission.findFirst({
    where: { id, organization_id: actor.organizationId },
  });
  if (!raw) notFound();

  const submission = {
    ...raw,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
    metadata: raw.metadata as Record<string, unknown> | null,
  };

  const fullName = `${submission.firstName} ${submission.lastName}`.trim();

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/contacts">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Contacts
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main info */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contact Information</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground text-xs mb-1">Full Name</p>
                <p className="font-medium">{fullName}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-1">Email</p>
                <a
                  href={`mailto:${submission.email}`}
                  className="font-medium text-primary hover:underline"
                >
                  {submission.email}
                </a>
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-1">Company</p>
                <p className="font-medium">{submission.company ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-1">Job Title</p>
                <p className="font-medium">{submission.jobTitle ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-1">Phone</p>
                <p className="font-medium">{submission.phone ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-1">Country</p>
                <p className="font-medium">{submission.country ?? "—"}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Inquiry Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {submission.productInterest && (
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Product Interest</p>
                  <p className="font-medium capitalize">
                    {submission.productInterest.replace(/_/g, " ")}
                  </p>
                </div>
              )}
              {submission.subject && (
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Subject</p>
                  <p className="font-medium">{submission.subject}</p>
                </div>
              )}
              <div>
                <p className="text-muted-foreground text-xs mb-1">Message</p>
                <div className="bg-muted/50 rounded-md p-3 whitespace-pre-wrap text-sm leading-relaxed">
                  {submission.message}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t">
                <div>
                  <p className="text-muted-foreground text-xs mb-1">IP Address</p>
                  <p className="font-mono text-xs">{submission.ipAddress ?? "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Source</p>
                  <p className="font-medium">{submission.source ?? "—"}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status &amp; Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <TypeBadge type={submission.type} />
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-1">Submitted</p>
                <p className="text-sm font-medium">{formatDateTime(submission.createdAt)}</p>
              </div>
              <div className="border-t pt-4">
                <ContactDetailActions
                  submissionId={submission.id}
                  currentStatus={submission.status}
                  email={submission.email}
                  fullName={fullName}
                />
              </div>
            </CardContent>
          </Card>

          <Button variant="outline" className="w-full gap-2" asChild>
            <a href={`mailto:${submission.email}?subject=Re: ${submission.subject ?? "Your inquiry"}`}>
              <Mail className="h-4 w-4" />
              Reply via Email
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
