import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The token side of the connector. What must hold: a code is single-use,
 * PKCE-bound and client-bound; the issued token is an ordinary org-bound
 * ApiToken row carrying the consent page's choices; refresh rotates in place
 * and a replayed refresh token is dead; losing membership kills the grant.
 */

const codeFindUnique = vi.fn();
const codeUpdateMany = vi.fn();
const tokenFindUnique = vi.fn();
const tokenUpdateMany = vi.fn();
const tokenCreate = vi.fn();
const membershipFindFirst = vi.fn();
const membershipFindMany = vi.fn();
const userFindMany = vi.fn();
const accountCreateMany = vi.fn();
const tokenFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    oAuthAuthorizationCode: {
      findUnique: (...a: unknown[]) => codeFindUnique(...a),
      updateMany: (...a: unknown[]) => codeUpdateMany(...a),
    },
    apiToken: {
      findUnique: (...a: unknown[]) => tokenFindUnique(...a),
      updateMany: (...a: unknown[]) => tokenUpdateMany(...a),
      create: (...a: unknown[]) => tokenCreate(...a),
      findMany: (...a: unknown[]) => tokenFindMany(...a),
    },
    membership: {
      findFirst: (...a: unknown[]) => membershipFindFirst(...a),
      findMany: (...a: unknown[]) => membershipFindMany(...a),
    },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    apiTokenAccount: { createMany: (...a: unknown[]) => accountCreateMany(...a) },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: "Acme" }) },
    // Array form for the one-organization path, callback form for a workspace
    // connection (which needs the new row's id for its linked accounts).
    $transaction: (ops: unknown) =>
      typeof ops === "function"
        ? (ops as (tx: unknown) => unknown)({
            apiToken: { updateMany: tokenUpdateMany, create: tokenCreate },
            apiTokenAccount: { createMany: accountCreateMany },
          })
        : Promise.all(ops as unknown[]),
  },
}));

import { exchangeAuthorizationCode, refreshAccessToken, OAuthError } from "./server";
import { sha256 } from "./protocol";

const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const CLIENT = { id: "client-db-1", client_name: "Claude" };

function codeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "code-1",
    client_id: CLIENT.id,
    user_id: "u1",
    organization_id: "org-acme",
    site_scopes: ["website"],
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: CHALLENGE,
    expires_at: new Date(Date.now() + 60_000),
    used_at: null,
    ...overrides,
  };
}

const exchange = (overrides: Partial<Parameters<typeof exchangeAuthorizationCode>[0]> = {}) =>
  exchangeAuthorizationCode({
    client: CLIENT,
    code: "the-code",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeVerifier: VERIFIER,
    ...overrides,
  });

async function expectGrantError(p: Promise<unknown>, code = "invalid_grant") {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(OAuthError);
  expect((err as OAuthError).code).toBe(code);
}

beforeEach(() => {
  vi.clearAllMocks();
  codeFindUnique.mockResolvedValue(codeRow());
  codeUpdateMany.mockResolvedValue({ count: 1 });
  tokenUpdateMany.mockResolvedValue({ count: 1 });
  tokenCreate.mockResolvedValue({});
  membershipFindFirst.mockResolvedValue({ id: "m1" });
});

describe("exchangeAuthorizationCode", () => {
  it("issues an org-bound, site-scoped cms_pat_ connection and replaces the previous one", async () => {
    const res = await exchange();
    expect(res.token_type).toBe("Bearer");
    expect(res.access_token.startsWith("cms_pat_")).toBe(true);
    expect(res.refresh_token.startsWith("cms_rt_")).toBe(true);

    const data = tokenCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      user_id: "u1",
      organization_id: "org-acme",
      site_scopes: ["website"],
      oauth_client_id: CLIENT.id,
      name: "Claude — Acme",
      token_hash: sha256(res.access_token),
      refresh_token_hash: sha256(res.refresh_token),
    });
    // Prior live connection from the same app+user+org is revoked.
    expect(tokenUpdateMany.mock.calls[0][0].where).toMatchObject({
      user_id: "u1",
      organization_id: "org-acme",
      oauth_client_id: CLIENT.id,
      revoked_at: null,
    });
  });

  it("refuses a wrong PKCE verifier", async () => {
    await expectGrantError(exchange({ codeVerifier: "w".repeat(64) }));
    expect(tokenCreate).not.toHaveBeenCalled();
  });

  it("refuses a code issued to another client", async () => {
    codeFindUnique.mockResolvedValue(codeRow({ client_id: "someone-else" }));
    await expectGrantError(exchange());
  });

  it("refuses a mismatched redirect_uri", async () => {
    await expectGrantError(exchange({ redirectUri: "https://claude.ai/other" }));
  });

  it("refuses an expired or used code", async () => {
    codeFindUnique.mockResolvedValue(codeRow({ expires_at: new Date(Date.now() - 1) }));
    await expectGrantError(exchange());
    codeFindUnique.mockResolvedValue(codeRow({ used_at: new Date() }));
    await expectGrantError(exchange());
  });

  it("lets only one of two concurrent redemptions win", async () => {
    codeUpdateMany.mockResolvedValue({ count: 0 });
    await expectGrantError(exchange());
    expect(tokenCreate).not.toHaveBeenCalled();
  });

  it("refuses when the approving member has since left the organization", async () => {
    membershipFindFirst.mockResolvedValue(null);
    await expectGrantError(exchange());
    expect(tokenCreate).not.toHaveBeenCalled();
  });

  it("requires code and verifier", async () => {
    await expectGrantError(exchange({ codeVerifier: null }), "invalid_request");
  });
});

describe("refreshAccessToken", () => {
  function tokenRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "tok-1",
      user_id: "u1",
      organization_id: "org-acme",
      oauth_client_id: CLIENT.id,
      revoked_at: null,
      refresh_token_hash: sha256("cms_rt_old"),
      refresh_expires_at: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  it("rotates both tokens on the same row, conditional on the old refresh hash", async () => {
    tokenFindUnique.mockResolvedValue(tokenRow());
    const res = await refreshAccessToken({ client: CLIENT, refreshToken: "cms_rt_old" });
    const call = tokenUpdateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "tok-1", refresh_token_hash: sha256("cms_rt_old"), revoked_at: null });
    expect(call.data.token_hash).toBe(sha256(res.access_token));
    expect(call.data.refresh_token_hash).toBe(sha256(res.refresh_token));
  });

  it("refuses a revoked, expired, or other client's connection", async () => {
    for (const o of [
      { revoked_at: new Date() },
      { refresh_expires_at: new Date(Date.now() - 1) },
      { oauth_client_id: "someone-else" },
    ]) {
      tokenFindUnique.mockResolvedValue(tokenRow(o));
      await expectGrantError(refreshAccessToken({ client: CLIENT, refreshToken: "cms_rt_old" }));
    }
  });

  it("treats a replayed refresh token that lost the rotation race as dead", async () => {
    tokenFindUnique.mockResolvedValue(tokenRow());
    tokenUpdateMany.mockResolvedValue({ count: 0 });
    await expectGrantError(refreshAccessToken({ client: CLIENT, refreshToken: "cms_rt_old" }));
  });

  it("refuses once the member has left the organization", async () => {
    tokenFindUnique.mockResolvedValue(tokenRow());
    membershipFindFirst.mockResolvedValue(null);
    await expectGrantError(refreshAccessToken({ client: CLIENT, refreshToken: "cms_rt_old" }));
  });
});

describe("a workspace connection (All my organizations)", () => {
  beforeEach(() => {
    codeUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    tokenUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    tokenCreate.mockReset().mockResolvedValue({ id: "tok-new" });
    accountCreateMany.mockReset().mockResolvedValue({ count: 1 });
    userFindMany.mockReset().mockResolvedValue([
      { id: "u1", email: "admin@example.com" },
      { id: "u2", email: "writer@example.com" },
    ]);
    membershipFindMany.mockReset().mockResolvedValue([{ user_id: "u1" }, { user_id: "u2" }]);
    tokenFindMany.mockReset().mockResolvedValue([]);
  });

  it("issues a token bound to no organization, with the linked accounts", async () => {
    codeFindUnique.mockResolvedValue(
      codeRow({ organization_id: null, all_organizations: true, linked_user_ids: ["u2"], site_scopes: [] })
    );
    const res = await exchange();
    expect(res.access_token).toMatch(/^cms_pat_/);
    expect(tokenCreate.mock.calls[0][0].data).toMatchObject({
      user_id: "u1",
      organization_id: null,
      all_organizations: true,
      oauth_client_id: CLIENT.id,
    });
    expect(tokenCreate.mock.calls[0][0].data.name).toContain("admin@example.com, writer@example.com");
    expect(accountCreateMany).toHaveBeenCalledWith({ data: [{ api_token_id: "tok-new", user_id: "u2" }] });
    // Reconnecting replaces the previous workspace connection for this app.
    expect(tokenUpdateMany.mock.calls[0][0].where).toMatchObject({ all_organizations: true, oauth_client_id: CLIENT.id });
  });

  it("signing in again from the same app adds the account instead of replacing the first", async () => {
    // The app's live connection holds admin@example.com (u1); the writer now
    // signs in as writer@example.com (u2) from their other folder.
    tokenFindMany.mockResolvedValue([{ user_id: "u1", linked_accounts: [] }]);
    codeFindUnique.mockResolvedValue(
      codeRow({ user_id: "u2", organization_id: null, all_organizations: true, linked_user_ids: [], site_scopes: [] })
    );
    await exchange();
    expect(tokenFindMany.mock.calls[0][0].where).toMatchObject({ oauth_client_id: CLIENT.id, all_organizations: true, revoked_at: null });
    expect(tokenCreate.mock.calls[0][0].data).toMatchObject({ user_id: "u2", all_organizations: true });
    expect(accountCreateMany).toHaveBeenCalledWith({ data: [{ api_token_id: "tok-new", user_id: "u1" }] });
    // The earlier connection is folded in, whoever owned it.
    expect(tokenUpdateMany.mock.calls[0][0].where).not.toHaveProperty("user_id");
  });

  it("refuses when none of its accounts belongs to an organization", async () => {
    codeFindUnique.mockResolvedValue(codeRow({ organization_id: null, all_organizations: true, linked_user_ids: [] }));
    membershipFindMany.mockResolvedValue([]);
    await expect(exchange()).rejects.toBeInstanceOf(OAuthError);
    expect(tokenCreate).not.toHaveBeenCalled();
  });
});
