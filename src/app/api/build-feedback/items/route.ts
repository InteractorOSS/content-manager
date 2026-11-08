import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchMyItems, BuildFeedbackError, type ListQuery, type CombinedItemType, type SortField, type SortOrder } from "@/lib/build-feedback";

const TYPES: CombinedItemType[] = ["feedback", "idea", "ticket"];
const SORTS: SortField[] = ["date", "status", "votes"];
const ORDERS: SortOrder[] = ["asc", "desc"];

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const type = sp.get("type");
  const sort = sp.get("sort");
  const order = sp.get("order");
  const limit = sp.get("limit");

  const query: ListQuery = {
    type: type && TYPES.includes(type as CombinedItemType) ? (type as CombinedItemType) : undefined,
    status: sp.get("status") ?? undefined,
    sort: sort && SORTS.includes(sort as SortField) ? (sort as SortField) : undefined,
    order: order && ORDERS.includes(order as SortOrder) ? (order as SortOrder) : undefined,
    limit: limit ? Number(limit) : undefined,
    cursor: sp.get("cursor") ?? undefined,
  };

  try {
    const result = await fetchMyItems(session.user.email, query);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BuildFeedbackError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
