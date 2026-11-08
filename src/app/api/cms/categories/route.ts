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

export async function GET(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const categories = await db.category.findMany({
    orderBy: [{ sort_order: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ data: categories.map(formatCategory) });
}

export async function POST(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "categories:manage");
  if (error) return error;

  const body = await req.json() as { category?: Record<string, unknown> };
  const data: Record<string, unknown> = body.category ?? body;

  const name = String(data.name ?? "");
  const slug = String(data.slug || slugify(name));

  try {
    const category = await db.category.create({
      data: {
        name,
        slug,
        description: data.description ? String(data.description) : null,
        color: data.color ? String(data.color) : null,
        sort_order: Number(data.sort_order ?? 0),
      },
    });
    return NextResponse.json({ data: formatCategory(category) }, { status: 201 });
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
