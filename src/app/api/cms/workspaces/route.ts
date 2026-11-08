import { NextRequest, NextResponse } from "next/server";
import { apiTokenRowFromRequest, requireActor } from "@/lib/guard";
import { connectionAccounts, listWorkspaces } from "@/lib/workspaces";

// Everything the caller's connection can reach, as workspaces
// ("<account>/<organization>/<site>", see src/lib/workspaces.ts): one entry
// per account × organization, and one per site. The Interactor CMS plugin
// binds a folder to one of these. Backs the list_workspaces MCP tool.
//
// A token is read directly rather than through requirePermissionApi, which
// needs a workspace named before it can resolve an actor: listing the
// workspaces is how a caller finds out which to name. Without a token, the
// signed-in session's own organizations.
export async function GET(req: NextRequest) {
  const token = await apiTokenRowFromRequest(req);
  if (token) {
    if (!token.all_organizations && !token.organization_id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const accounts = token.all_organizations ? await connectionAccounts(token) : [];
    return NextResponse.json({
      data: {
        all_organizations: token.all_organizations,
        accounts: accounts.map((a) => a.email),
        workspaces: await listWorkspaces(token),
      },
    });
  }

  const { actor, error } = await requireActor();
  if (error) return error;
  return NextResponse.json({
    data: {
      all_organizations: false,
      accounts: [actor.user.email],
      workspaces: await listWorkspaces({
        id: "session",
        user_id: actor.user.id,
        // Every organization the signed-in account belongs to.
        all_organizations: true,
        organization_id: actor.organizationId,
        site_scopes: [],
      }),
    },
  });
}
