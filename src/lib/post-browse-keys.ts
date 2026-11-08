import { randomBytes } from "crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/api-tokens";
import { loadActor, type Actor } from "@/lib/rbac";
import { tenantDb, type TenantDb } from "@/lib/tenant-db";

// Browse keys — the credential behind the writer's post list in Claude's
// browser panel (/write/posts). Links in Claude's chat open in the system
// browser, which Claude can't steer; clicks INSIDE the panel stay there. So
// `open_post_list` (MCP) mints one of these and Claude opens the list page in
// the panel with it, and clicking a post there opens the editor in the same
// panel.
//
// Why a key and not the browser sign-in: it follows the connection Claude
// used, so a writer with two accounts sees the right account's list (the
// panel's cookie can only be one account at a time), and the panel never asks
// them to sign in. Same limits as an edit key (src/lib/post-edit-keys.ts):
//   - the `cms_list_` prefix fails both looksLikeApiToken and
//     looksLikeEditKey, so it authenticates only the /api/edit/* routes that
//     ask for a browse key;
//   - it can list the organization's posts (narrowed to its site and the
//     minting token's own site scope) and open them by minting ordinary edit
//     keys — nothing else;
//   - it expires after BROWSE_KEY_TTL_MS, dies with the token that minted it,
//     and re-reads permissions from the owner's membership on every request.

export const BROWSE_KEY_PREFIX = "cms_list_";
export const BROWSE_KEY_TTL_MS = 8 * 60 * 60 * 1000;

export function looksLikeBrowseKey(value: string): boolean {
  return value.startsWith(BROWSE_KEY_PREFIX);
}

/** Mint a list key; the same person's earlier list key through the same
 *  connection for the same organization is replaced, unless replacePrevious
 *  is false (the "All posts" key open_for_editing hands the editor, which must
 *  not cut off a list the writer already has open). */
export async function mintBrowseKey(input: {
  userId: string;
  organizationId: string;
  apiTokenId: string | null;
  siteScopes: string[];
  site: string | null;
  replacePrevious?: boolean;
  now?: number;
}): Promise<{ key: string; expiresAt: Date }> {
  const now = input.now ?? Date.now();
  const key = `${BROWSE_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(now + BROWSE_KEY_TTL_MS);
  await prisma.$transaction([
    ...(input.replacePrevious === false
      ? []
      : [
          prisma.postBrowseKey.updateMany({
            where: {
              user_id: input.userId,
              organization_id: input.organizationId,
              api_token_id: input.apiTokenId,
              revoked_at: null,
            },
            data: { revoked_at: new Date(now) },
          }),
        ]),
    prisma.postBrowseKey.create({
      data: {
        user_id: input.userId,
        organization_id: input.organizationId,
        api_token_id: input.apiTokenId,
        site_scopes: input.siteScopes,
        site: input.site,
        key_hash: hashToken(key),
        expires_at: expiresAt,
      },
    }),
  ]);
  return { key, expiresAt };
}

export type BrowseKeyAuth = {
  actor: Actor;
  db: TenantDb;
  key: { id: string; api_token_id: string | null; site_scopes: string[]; site: string | null; organization_id: string };
};

/** A live browse key's owner, organization and limits, or null. */
export async function resolveBrowseKey(raw: string, now: Date = new Date()): Promise<BrowseKeyAuth | null> {
  if (!looksLikeBrowseKey(raw)) return null;
  const key = await prisma.postBrowseKey.findUnique({
    where: { key_hash: hashToken(raw) },
    include: { api_token: { select: { revoked_at: true } } },
  });
  if (!key || key.revoked_at || key.expires_at <= now) return null;
  if (key.api_token && key.api_token.revoked_at) return null;

  const actor = await loadActor({ id: key.user_id }, { forceOrganizationId: key.organization_id });
  if (!actor || actor.organizationId !== key.organization_id) return null;

  prisma.postBrowseKey.update({ where: { id: key.id }, data: { last_used_at: now } }).catch(() => {});
  return {
    actor,
    db: tenantDb(key.organization_id),
    key: {
      id: key.id,
      api_token_id: key.api_token_id,
      site_scopes: key.site_scopes || [],
      site: key.site,
      organization_id: key.organization_id,
    },
  };
}

export async function browseKeyFromRequest(req: NextRequest): Promise<BrowseKeyAuth | null> {
  const header = req.headers.get("authorization");
  if (!header || !/^bearer /i.test(header)) return null;
  return resolveBrowseKey(header.slice("bearer ".length).trim());
}
