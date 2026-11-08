import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Tags are the one taxonomy surface that both READS and WRITES posts: the
 * list is assembled from post rows, and deleting a tag rewrites every post
 * carrying it. So a site-scoped token (G#21) is held to the post rules here
 * too — otherwise a product-manager token with content:edit_any could strip a
 * tag off the website's posts, which is exactly the least-privilege hole site
 * scoping exists to close.
 */

const PM = "product-manager";

const actor = {
  user: { id: "u1", email: "author@example.com", name: "Author One", status: "active" },
  organizationId: "org1",
  permissions: new Set<string>(["content:view", "content:edit_any"]),
};

let apiToken: { site_scopes: string[] } | undefined;

const postFindMany = vi.fn();
const postUpdate = vi.fn();

const db = {
  post: {
    findMany: (...a: unknown[]) => postFindMany(...a),
    update: (...a: unknown[]) => postUpdate(...a),
  },
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({
    actor,
    db,
    via: apiToken ? "token" : "session",
    apiToken,
  })),
}));

import { GET, DELETE } from "./route";

const list = () => GET(new NextRequest("http://localhost/api/cms/tags"));
const removeTag = (tag: string) =>
  DELETE(
    new NextRequest(`http://localhost/api/cms/tags?tag=${tag}`, { method: "DELETE" })
  );

beforeEach(() => {
  apiToken = { site_scopes: [PM] };
  postFindMany.mockReset();
  postUpdate.mockReset();
  postUpdate.mockResolvedValue({});
});

describe("site-scoped token", () => {
  it("lists only the tags used by posts it can see", async () => {
    postFindMany.mockResolvedValue([{ tags: ["roadmap"] }]);

    const res = await list();

    expect(await res.json()).toEqual({ tags: ["roadmap"] });
    expect(postFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { platforms: { hasSome: [PM] } } })
    );
  });

  it("deletes a tag carried only by posts in its scope", async () => {
    postFindMany.mockResolvedValue([
      { id: "p1", slug: "pm-post", tags: ["roadmap", "keep"], platforms: [PM] },
    ]);

    expect((await removeTag("roadmap")).status).toBe(204);
    expect(postUpdate).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { tags: ["keep"] },
    });
  });

  it("refuses the whole delete when another site's post carries the tag, and names it", async () => {
    postFindMany.mockResolvedValue([
      { id: "p1", slug: "pm-post", tags: ["roadmap"], platforms: [PM] },
      { id: "p2", slug: "website-post", tags: ["roadmap"], platforms: ["website"] },
    ]);

    const res = await removeTag("roadmap");
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain(PM);
    expect(body.error).toContain("website-post");
    expect(body.error).toContain("left in place");
    expect(body.out_of_scope_slugs).toEqual(["website-post"]);
    // Refused whole: not even the in-scope post is rewritten.
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the tag sits on a post shared with another site", async () => {
    postFindMany.mockResolvedValue([
      { id: "p1", slug: "shared", tags: ["roadmap"], platforms: ["website", PM] },
    ]);

    expect((await removeTag("roadmap")).status).toBe(403);
    expect(postUpdate).not.toHaveBeenCalled();
  });
});

describe.each([
  ["a token minted with no site scope", { site_scopes: [] }],
  ["a browser session", undefined],
])("%s — every site in the org, as before", (_label, credential) => {
  beforeEach(() => {
    apiToken = credential;
  });

  it("lists tags without a site filter", async () => {
    postFindMany.mockResolvedValue([{ tags: ["roadmap"] }, { tags: ["news"] }]);

    expect(await (await list()).json()).toEqual({ tags: ["news", "roadmap"] });
    expect(postFindMany.mock.calls[0][0].where).toEqual({});
  });

  it("deletes a tag from every post carrying it", async () => {
    postFindMany.mockResolvedValue([
      { id: "p1", slug: "pm-post", tags: ["roadmap"], platforms: [PM] },
      { id: "p2", slug: "website-post", tags: ["roadmap"], platforms: ["website"] },
    ]);

    expect((await removeTag("roadmap")).status).toBe(204);
    expect(postUpdate).toHaveBeenCalledTimes(2);
  });
});
