/**
 * Database side of the MCP connector's OAuth server: client registration,
 * authorization codes, and issuing/refreshing/revoking the tokens.
 *
 * The access token a connector receives is an ordinary `cms_pat_` ApiToken
 * row — bound to one organization, optionally site-scoped, verified by the
 * same guard as a hand-minted PAT. That is deliberate: the MCP tools delegate
 * to the /api/cms routes with the caller's bearer (src/lib/mcp/delegate.ts),
 * so a token shape the routes already trust is what keeps RBAC, tenancy, site
 * scopes and `whoami` working with no second code path.
 */

import { prisma } from "@/lib/db";
import { displayPrefix, generateRawToken, hashToken } from "@/lib/api-tokens";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  SUPPORTED_SCOPE,
  digestsEqual,
  generateAuthorizationCode,
  generateClientId,
  generateClientSecret,
  generateRefreshToken,
  sha256,
  verifyPkce,
  type ClientRegistration,
  type PresentedClientCredentials,
} from "@/lib/oauth/protocol";

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type";

export class OAuthError extends Error {
  constructor(
    public code: OAuthErrorCode,
    public description: string
  ) {
    super(description);
  }

  /** invalid_client is the one error RFC 6749 §5.2 answers with 401. */
  get status(): number {
    return this.code === "invalid_client" ? 401 : 400;
  }
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

// ─── Clients ────────────────────────────────────────────────────────────────

export async function registerClient(reg: ClientRegistration) {
  const secret = reg.token_endpoint_auth_method === "none" ? null : generateClientSecret();
  const client = await prisma.oAuthClient.create({
    data: {
      client_id: generateClientId(),
      client_secret_hash: secret ? sha256(secret) : null,
      client_name: reg.client_name,
      redirect_uris: reg.redirect_uris,
      token_endpoint_auth_method: reg.token_endpoint_auth_method,
    },
  });
  return { client, secret };
}

export function findClient(clientId: string | null | undefined) {
  if (!clientId) return Promise.resolve(null);
  return prisma.oAuthClient.findUnique({ where: { client_id: clientId } });
}

/** Authenticate the client on a token/revoke request, per its registered method. */
export async function authenticateClient(creds: PresentedClientCredentials) {
  const client = await findClient(creds.client_id);
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id.");

  if (client.client_secret_hash) {
    if (!creds.client_secret || !digestsEqual(sha256(creds.client_secret), client.client_secret_hash)) {
      throw new OAuthError("invalid_client", "Client authentication failed.");
    }
  }
  return client;
}

// ─── Authorization codes ────────────────────────────────────────────────────

export async function issueAuthorizationCode(input: {
  clientDbId: string;
  userId: string;
  /** Null for a workspace connection (allOrganizations). */
  organizationId: string | null;
  allOrganizations?: boolean;
  /** Other accounts the person signed in as on the consent page. */
  linkedUserIds?: string[];
  siteScopes: string[];
  redirectUri: string;
  codeChallenge: string;
  scope: string | null;
}): Promise<string> {
  const code = generateAuthorizationCode();
  await prisma.oAuthAuthorizationCode.create({
    data: {
      code_hash: sha256(code),
      client_id: input.clientDbId,
      user_id: input.userId,
      organization_id: input.organizationId,
      all_organizations: input.allOrganizations ?? false,
      linked_user_ids: (input.linkedUserIds ?? []).filter((id) => id !== input.userId),
      site_scopes: input.siteScopes,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      scope: input.scope,
      expires_at: new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
    },
  });
  return code;
}

async function assertStillMember(userId: string, organizationId: string) {
  const membership = await prisma.membership.findFirst({
    where: { user_id: userId, organization_id: organizationId },
    select: { id: true },
  });
  if (!membership) {
    throw new OAuthError(
      "invalid_grant",
      "The account that approved this connection is no longer a member of its organization."
    );
  }
}

function tokenPair() {
  const access = generateRawToken();
  const refresh = generateRefreshToken();
  const now = Date.now();
  return {
    access,
    refresh,
    columns: {
      token_prefix: displayPrefix(access),
      token_hash: hashToken(access),
      expires_at: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
      refresh_token_hash: sha256(refresh),
      refresh_expires_at: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
  };
}

function tokenResponse(access: string, refresh: string): TokenResponse {
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope: SUPPORTED_SCOPE,
  };
}

/** grant_type=authorization_code */
export async function exchangeAuthorizationCode(input: {
  client: { id: string; client_name: string };
  code: string | null;
  redirectUri: string | null;
  codeVerifier: string | null;
}): Promise<TokenResponse> {
  if (!input.code || !input.codeVerifier) {
    throw new OAuthError("invalid_request", "code and code_verifier are required.");
  }
  const row = await prisma.oAuthAuthorizationCode.findUnique({
    where: { code_hash: sha256(input.code) },
  });
  if (!row || row.client_id !== input.client.id) {
    throw new OAuthError("invalid_grant", "Unknown authorization code.");
  }
  if (row.used_at || row.expires_at < new Date()) {
    throw new OAuthError("invalid_grant", "Authorization code expired or already used.");
  }
  // §4.1.3: must be identical to the one on the authorize request.
  if (input.redirectUri !== null && input.redirectUri !== row.redirect_uri) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.");
  }
  if (!verifyPkce(input.codeVerifier, row.code_challenge)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed.");
  }

  // Claim the code atomically: of two concurrent redemptions exactly one wins.
  const claimed = await prisma.oAuthAuthorizationCode.updateMany({
    where: { id: row.id, used_at: null },
    data: { used_at: new Date() },
  });
  if (claimed.count !== 1) {
    throw new OAuthError("invalid_grant", "Authorization code already used.");
  }

  if (row.all_organizations) return issueWorkspaceConnection(row, input.client);
  if (!row.organization_id) throw new OAuthError("invalid_grant", "Authorization code names no organization.");
  const organizationId = row.organization_id;

  await assertStillMember(row.user_id, organizationId);

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  const { access, refresh, columns } = tokenPair();

  await prisma.$transaction([
    // Reconnecting the same app to the same org replaces the old connection
    // rather than stacking up a row per sign-in.
    prisma.apiToken.updateMany({
      where: {
        user_id: row.user_id,
        organization_id: organizationId,
        oauth_client_id: input.client.id,
        revoked_at: null,
      },
      data: { revoked_at: new Date() },
    }),
    prisma.apiToken.create({
      data: {
        user_id: row.user_id,
        organization_id: organizationId,
        site_scopes: row.site_scopes,
        oauth_client_id: input.client.id,
        name: `${input.client.client_name}${org ? ` — ${org.name}` : ""}`.slice(0, 200),
        ...columns,
      },
    }),
  ]);

  return tokenResponse(access, refresh);
}

/**
 * A workspace connection (src/lib/workspaces.ts): not bound to one
 * organization, covering the approving account plus any it linked on the
 * consent page. Each linked account signed in in the same browser to be added.
 * Reconnecting the same app replaces the previous workspace connection.
 */
async function issueWorkspaceConnection(
  row: { user_id: string; linked_user_ids: string[]; site_scopes: string[] },
  client: { id: string; client_name: string }
): Promise<TokenResponse> {
  // Signing in again from the same app ADDS to its connection rather than
  // replacing it: a writer connects each account from the folder that uses
  // it, and every earlier account stays on. See existingConnectionAccounts.
  const earlier = await existingConnectionAccounts(client.id);
  const ids = [
    row.user_id,
    ...[...row.linked_user_ids, ...earlier].filter((id, i, all) => id !== row.user_id && all.indexOf(id) === i),
  ];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
  const withMembership = await prisma.membership.findMany({
    where: { user_id: { in: ids } },
    select: { user_id: true },
    distinct: ["user_id"],
  });
  if (!users.some((u) => u.id === row.user_id) || withMembership.length === 0) {
    throw new OAuthError("invalid_grant", "None of the accounts on this connection belongs to an organization.");
  }
  const emails = ids.flatMap((id) => users.filter((u) => u.id === id).map((u) => u.email));
  const { access, refresh, columns } = tokenPair();

  await prisma.$transaction(async (tx) => {
    // The app's earlier workspace connection is folded into this one.
    await tx.apiToken.updateMany({
      where: { all_organizations: true, oauth_client_id: client.id, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    const token = await tx.apiToken.create({
      data: {
        user_id: row.user_id,
        organization_id: null,
        all_organizations: true,
        site_scopes: row.site_scopes,
        oauth_client_id: client.id,
        name: `${client.client_name} — all organizations (${emails.join(", ")})`.slice(0, 200),
        ...columns,
      },
    });
    const linked = ids.slice(1).filter((id) => users.some((u) => u.id === id));
    if (linked.length) {
      await tx.apiTokenAccount.createMany({ data: linked.map((user_id) => ({ api_token_id: token.id, user_id })) });
    }
  });

  return tokenResponse(access, refresh);
}

/**
 * The accounts on an app's live workspace connection (owner first), or [].
 *
 * An OAuth client registration belongs to one Claude installation: the code
 * for it is delivered to that installation's own redirect and redeemed with
 * its PKCE verifier, so only that installation can finish a sign-in for it.
 * Claude keeps one sign-in per connection, so a second sign-in (the writer
 * connecting their other account from the folder that uses it) used to
 * replace the first and drop its account. Every account here signed in
 * through this same app before.
 */
export async function existingConnectionAccounts(clientDbId: string): Promise<string[]> {
  const live = await prisma.apiToken.findMany({
    where: {
      oauth_client_id: clientDbId,
      all_organizations: true,
      revoked_at: null,
      refresh_expires_at: { gt: new Date() },
    },
    select: { user_id: true, linked_accounts: { select: { user_id: true } } },
    orderBy: { inserted_at: "asc" },
  });
  const ids: string[] = [];
  for (const t of live) for (const id of [t.user_id, ...t.linked_accounts.map((a) => a.user_id)]) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** grant_type=refresh_token — rotates both tokens in place on the same row. */
export async function refreshAccessToken(input: {
  client: { id: string };
  refreshToken: string | null;
}): Promise<TokenResponse> {
  if (!input.refreshToken) {
    throw new OAuthError("invalid_request", "refresh_token is required.");
  }
  const row = await prisma.apiToken.findUnique({
    where: { refresh_token_hash: sha256(input.refreshToken) },
  });
  if (
    !row ||
    row.oauth_client_id !== input.client.id ||
    row.revoked_at ||
    !row.refresh_expires_at ||
    row.refresh_expires_at < new Date() ||
    (!row.organization_id && !row.all_organizations)
  ) {
    throw new OAuthError("invalid_grant", "Refresh token is invalid, expired, or revoked.");
  }

  // A workspace connection checks membership per request, per organization.
  if (row.organization_id) await assertStillMember(row.user_id, row.organization_id);

  const { access, refresh, columns } = tokenPair();
  // Conditional on the hash we just read, so a refresh token replayed
  // concurrently can rotate the row at most once.
  const rotated = await prisma.apiToken.updateMany({
    where: { id: row.id, refresh_token_hash: row.refresh_token_hash, revoked_at: null },
    data: columns,
  });
  if (rotated.count !== 1) {
    throw new OAuthError("invalid_grant", "Refresh token already used.");
  }
  return tokenResponse(access, refresh);
}

/**
 * RFC 7009 revocation. Either token kills the whole connection row. Unknown
 * or foreign tokens are silently ignored (§2.2: respond 200 regardless).
 */
export async function revokeToken(input: { client: { id: string }; token: string | null }) {
  if (!input.token) return;
  const row = await prisma.apiToken.findFirst({
    where: {
      OR: [{ token_hash: hashToken(input.token) }, { refresh_token_hash: sha256(input.token) }],
    },
    select: { id: true, oauth_client_id: true },
  });
  if (!row || row.oauth_client_id !== input.client.id) return;
  await prisma.apiToken.update({ where: { id: row.id }, data: { revoked_at: new Date() } });
}
