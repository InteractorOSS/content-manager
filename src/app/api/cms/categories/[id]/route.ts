import { NextRequest, NextResponse } from "next/server";
import { isUniqueViolation } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

 
function formatCategory(c: any) {
  return {
    ...c,
    inserted_at: c.inserted_at.toISOString(),
    updated_at: c.updated_at.toISOString(),
  };
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id } = await params;
  const category = await db.category.findUnique({ where: { id } });
  if (!category) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ data: formatCategory(category) });
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "categories:manage");
  if (error) return error;

  const { id } = await params;
  const body = await req.json() as { category?: Record<string, unknown> };
  const data: Record<string, unknown> = body.category ?? body;

  const existing = await db.category.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const name = data.name !== undefined ? String(data.name) : existing.name;
  const slug = data.slug !== undefined
    ? String(data.slug)
    : (data.name !== undefined ? slugify(name) : existing.slug);

  try {
    const category = await db.category.update({
      where: { id },
      data: {
        name,
        slug,
        ...(data.description !== undefined && { description: String(data.description) || null }),
        ...(data.color !== undefined && { color: String(data.color) || null }),
        ...(data.sort_order !== undefined && { sort_order: Number(data.sort_order) }),
      },
    });
    return NextResponse.json({ data: formatCategory(category) });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json(
        { error: `A category named "${name}" (or slug "${slug}") already exists` },
        { status: 409 }
      );
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "categories:manage");
  if (error) return error;

  const { id } = await params;
  await db.category.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
