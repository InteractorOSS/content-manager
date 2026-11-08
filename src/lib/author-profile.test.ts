import { describe, expect, it, vi } from "vitest";
import { authorDisplayName } from "./rbac";
import { updateAuthorProfile, validateProfilePatch } from "./author-profile";

describe("authorDisplayName", () => {
  it("prefers the chosen display name over the SSO name and email", () => {
    expect(
      authorDisplayName({ display_name: "Peter Jung", name: "jsmith", email: "p@x.com" })
    ).toBe("Peter Jung");
  });

  it("falls back to name, then email, ignoring blanks", () => {
    expect(authorDisplayName({ display_name: "  ", name: "jsmith", email: "p@x.com" })).toBe(
      "jsmith"
    );
    expect(authorDisplayName({ display_name: null, name: "", email: "p@x.com" })).toBe("p@x.com");
  });
});

describe("validateProfilePatch", () => {
  it("trims, and turns blank into null (clear back to the fallback)", () => {
    expect(validateProfilePatch({ display_name: "  Peter Jung ", bio: "" })).toEqual({
      ok: true,
      display_name: "Peter Jung",
      bio: null,
    });
  });

  it("leaves untouched fields out", () => {
    expect(validateProfilePatch({})).toEqual({ ok: true });
  });

  it("rejects non-strings and overlong names", () => {
    expect(validateProfilePatch({ display_name: 42 }).ok).toBe(false);
    expect(validateProfilePatch({ display_name: "x".repeat(81) }).ok).toBe(false);
  });

  it("lowercases and trims a valid author_slug", () => {
    expect(validateProfilePatch({ author_slug: " Acme " })).toEqual({
      ok: true,
      author_slug: "acme",
    });
  });

  it("rejects an author_slug that isn't lowercase kebab-case", () => {
    expect(validateProfilePatch({ author_slug: "Peter Jung" }).ok).toBe(false);
    expect(validateProfilePatch({ author_slug: "peter_jung" }).ok).toBe(false);
    expect(validateProfilePatch({ author_slug: "x".repeat(65) }).ok).toBe(false);
  });

  it("clears author_slug on blank", () => {
    expect(validateProfilePatch({ author_slug: "" })).toEqual({ ok: true, author_slug: null });
  });

  it("trims job_title and enforces its max length", () => {
    expect(validateProfilePatch({ job_title: " Founder " })).toEqual({ ok: true, job_title: "Founder" });
    expect(validateProfilePatch({ job_title: "x".repeat(101) }).ok).toBe(false);
  });

  it("accepts up to 10 https URLs for same_as and drops blanks", () => {
    expect(validateProfilePatch({ same_as: ["https://x.com/a", "  ", "https://y.com/b"] })).toEqual({
      ok: true,
      same_as: ["https://x.com/a", "https://y.com/b"],
    });
  });

  it("rejects a non-https same_as URL, too many URLs, or non-string entries", () => {
    expect(validateProfilePatch({ same_as: ["http://x.com"] }).ok).toBe(false);
    expect(validateProfilePatch({ same_as: [42] }).ok).toBe(false);
    expect(validateProfilePatch({ same_as: Array.from({ length: 11 }, (_, i) => `https://x.com/${i}`) }).ok).toBe(
      false
    );
  });
});

function fakeClient() {
  const tx = {
    user: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        display_name: (data.display_name as string | null | undefined) ?? null,
        bio: (data.bio as string | null | undefined) ?? null,
        author_slug: (data.author_slug as string | null | undefined) ?? null,
        job_title: (data.job_title as string | null | undefined) ?? null,
        same_as: (data.same_as as string[] | undefined) ?? [],
      })),
    },
    post: { updateMany: vi.fn(async () => ({ count: 3 })) },
  };
  const client = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { client, tx };
}

const USER = { id: "u1", email: "p@x.com", name: "jsmith", display_name: null };

describe("updateAuthorProfile", () => {
  it("rewrites only the posts still carrying the OLD effective byline", async () => {
    const { client, tx } = fakeClient();
    const result = await updateAuthorProfile(client as never, USER, { display_name: "Peter Jung" });

    expect(tx.post.updateMany).toHaveBeenCalledWith({
      where: { author_id: "u1", author_name: "jsmith" },
      data: { author_name: "Peter Jung" },
    });
    expect(result).toMatchObject({ byline: "Peter Jung", posts_updated: 3 });
  });

  it("touches no posts when the effective byline doesn't change", async () => {
    const { client, tx } = fakeClient();
    const result = await updateAuthorProfile(client as never, USER, { bio: "Founder" });
    expect(tx.post.updateMany).not.toHaveBeenCalled();
    expect(result.posts_updated).toBe(0);
  });

  it("clearing the display name reverts bylines to the fallback name", async () => {
    const { client, tx } = fakeClient();
    await updateAuthorProfile(client as never, { ...USER, display_name: "Peter Jung" }, {
      display_name: null,
    });
    expect(tx.post.updateMany).toHaveBeenCalledWith({
      where: { author_id: "u1", author_name: "Peter Jung" },
      data: { author_name: "jsmith" },
    });
  });

  it("persists author_slug, job_title and same_as without touching post bylines", async () => {
    const { client, tx } = fakeClient();
    const result = await updateAuthorProfile(client as never, USER, {
      author_slug: "acme",
      job_title: "Founder",
      same_as: ["https://x.com/peterjung"],
    });
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          author_slug: "acme",
          job_title: "Founder",
          same_as: ["https://x.com/peterjung"],
        },
      })
    );
    expect(tx.post.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      author_slug: "acme",
      job_title: "Founder",
      same_as: ["https://x.com/peterjung"],
    });
  });
});
