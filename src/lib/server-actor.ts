import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { loadActor, type Actor } from "@/lib/rbac";

/**
 * Session guard for Server Components that read tenant data directly via
 * `src/lib/server-data.ts` (which takes an organizationId rather than the
 * request-scoped `db` requirePermission() hands to route handlers). Redirects
 * to /login exactly like the (cms) layout's own `auth()` check, plus the
 * membership resolution that check was missing — see server-data.ts's org
 * filtering for why an actor is required before any of those queries run.
 */
export async function requirePageActor(): Promise<Actor> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const actor = await loadActor(session.user);
  if (!actor) redirect("/login");
  return actor;
}
