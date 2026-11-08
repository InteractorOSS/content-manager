import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";
import { canManageProfile } from "@/lib/ai/profiles";

type Ctx = { params: Promise<{ id: string; sampleId: string }> };

async function authorize(id: string, sampleId: string) {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return { error };
  // Scoping the parent StyleProfile lookup through `db` is what leak-proofs the
  // child StyleSample: a profile in another org resolves to null → 404, so the
  // sample update/delete below can never reach across tenants.
  const profile = await db.styleProfile.findUnique({ where: { id } });
  if (!profile) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  if (!canManageProfile(actor, profile)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const sample = await db.styleSample.findFirst({
    where: { id: sampleId, profile_id: id },
  });
  if (!sample) {
    return { error: NextResponse.json({ error: "Sample not found" }, { status: 404 }) };
  }
  return { sample, db };
}

// PATCH: record the guided-interview answer ("what do you like about this?")
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id, sampleId } = await params;
  const auth = await authorize(id, sampleId);
  if (auth.error) return auth.error;

  const body = (await req.json().catch(() => ({}))) as { liked_notes?: string };
  const updated = await auth.db.styleSample.update({
    where: { id: sampleId },
    data: { liked_notes: body.liked_notes?.trim() || null },
  });

  return NextResponse.json({
    data: { id: updated.id, liked_notes: updated.liked_notes },
  });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id, sampleId } = await params;
  const auth = await authorize(id, sampleId);
  if (auth.error) return auth.error;

  await auth.db.styleSample.delete({ where: { id: sampleId } });
  return new NextResponse(null, { status: 204 });
}
