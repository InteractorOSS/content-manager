import { describe, expect, it, vi, beforeEach } from "vitest";

const { postFindUnique } = vi.hoisted(() => ({ postFindUnique: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { post: { findUnique: postFindUnique } },
}));

import {
  signPreviewToken,
  verifyPreviewToken,
  mintPreviewToken,
  previewUrl,
  livePreviewUrl,
  resolvePreviewLink,
  PREVIEW_LINK_TTL_MS,
} from "./preview-link";

const SECRET = "test-secret";
const POST_ID = "post123";
const NOW = 1_700_000_000_000;

beforeEach(() => {
  postFindUnique.mockReset();
});

describe("signPreviewToken / verifyPreviewToken", () => {
  it("round-trips a valid token to the same post id and expiry", () => {
    const expiresAt = NOW + 1000;
    const token = signPreviewToken(POST_ID, expiresAt, SECRET);
    const verified = verifyPreviewToken(token, SECRET);
    expect(verified).toEqual({ postId: POST_ID, expiresAt });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signPreviewToken(POST_ID, NOW + 1000, "other-secret");
    expect(verifyPreviewToken(token, SECRET)).toBeNull();
  });

  it("rejects a tampered payload (post id swapped)", () => {
    const token = signPreviewToken(POST_ID, NOW + 1000, SECRET);
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [, expiresAt, sig] = decoded.split(".");
    const tampered = Buffer.from(`other-post.${expiresAt}.${sig}`, "utf8").toString("base64url");
    expect(verifyPreviewToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a tampered signature (single flipped character)", () => {
    const token = signPreviewToken(POST_ID, NOW + 1000, SECRET);
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [postId, expiresAt, sig] = decoded.split(".");
    const flipped = sig[0] === "a" ? "b" : "a";
    const tampered = Buffer.from(`${postId}.${expiresAt}.${flipped}${sig.slice(1)}`, "utf8").toString(
      "base64url"
    );
    expect(verifyPreviewToken(tampered, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyPreviewToken("not-base64url-shaped-!!!", SECRET)).toBeNull();
    expect(verifyPreviewToken(Buffer.from("only.two").toString("base64url"), SECRET)).toBeNull();
    expect(verifyPreviewToken(Buffer.from("id.not-a-number.sig").toString("base64url"), SECRET)).toBeNull();
  });
});

describe("mintPreviewToken", () => {
  it("defaults to a 7-day TTL and produces a verifiable token", () => {
    const { token, expiresAt } = mintPreviewToken(POST_ID, undefined, NOW);
    expect(expiresAt.getTime()).toBe(NOW + PREVIEW_LINK_TTL_MS);
    const verified = verifyPreviewToken(token);
    expect(verified?.postId).toBe(POST_ID);
    expect(verified?.expiresAt).toBe(NOW + PREVIEW_LINK_TTL_MS);
  });
});

describe("previewUrl / livePreviewUrl", () => {
  it("builds an absolute /preview/<token> URL", () => {
    const url = previewUrl("abc");
    expect(url).toMatch(/\/preview\/abc$/);
  });

  it("returns null when there is no active preview link", () => {
    expect(livePreviewUrl({ id: POST_ID, preview_token_expires_at: null }, NOW)).toBeNull();
  });

  it("returns null once the active link has expired", () => {
    expect(
      livePreviewUrl({ id: POST_ID, preview_token_expires_at: new Date(NOW - 1) }, NOW)
    ).toBeNull();
  });

  it("returns an openable URL for a live link", () => {
    const url = livePreviewUrl({ id: POST_ID, preview_token_expires_at: new Date(NOW + 1000) }, NOW);
    expect(url).toMatch(/\/preview\//);
  });
});

describe("resolvePreviewLink", () => {
  it("200s with the post for a valid, current, unexpired token", async () => {
    const expiresAt = NOW + 1000;
    const token = signPreviewToken(POST_ID, expiresAt);
    postFindUnique.mockResolvedValue({ id: POST_ID, preview_token_expires_at: new Date(expiresAt) });

    const result = await resolvePreviewLink(token, NOW);
    expect(result.status).toBe(200);
  });

  it("404s a tampered token without ever querying the database", async () => {
    const result = await resolvePreviewLink("garbage-token", NOW);
    expect(result.status).toBe(404);
    expect(postFindUnique).not.toHaveBeenCalled();
  });

  it("410s a token whose own embedded expiry has passed", async () => {
    const token = signPreviewToken(POST_ID, NOW - 1);
    const result = await resolvePreviewLink(token, NOW);
    expect(result.status).toBe(410);
    expect(postFindUnique).not.toHaveBeenCalled();
  });

  it("404s when the post no longer exists", async () => {
    const token = signPreviewToken(POST_ID, NOW + 1000);
    postFindUnique.mockResolvedValue(null);
    const result = await resolvePreviewLink(token, NOW);
    expect(result.status).toBe(404);
  });

  it("404s a revoked link (preview_token_expires_at cleared) even though the token itself hasn't expired", async () => {
    const token = signPreviewToken(POST_ID, NOW + 1000);
    postFindUnique.mockResolvedValue({ id: POST_ID, preview_token_expires_at: null });
    const result = await resolvePreviewLink(token, NOW);
    expect(result.status).toBe(404);
  });

  it("404s a superseded link (post has since minted a newer one)", async () => {
    const token = signPreviewToken(POST_ID, NOW + 1000);
    postFindUnique.mockResolvedValue({ id: POST_ID, preview_token_expires_at: new Date(NOW + 5000) });
    const result = await resolvePreviewLink(token, NOW);
    expect(result.status).toBe(404);
  });
});
