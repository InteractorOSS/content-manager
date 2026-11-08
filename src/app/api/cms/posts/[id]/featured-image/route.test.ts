import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const actor = {
  user: { id: "u1", email: "a@example.com", name: "Author One", display_name: null, status: "active" },
  organizationId: "org1",
  organizations: [],
  permissions: new Set<string>(["content:edit"]),
};
let apiToken: { site_scopes: string[] } | null = null;

const postFindUnique = vi.fn();
const postUpdate = vi.fn();
const db = {
  post: {
    findUnique: (...a: unknown[]) => postFindUnique(...a),
    update: (...a: unknown[]) => postUpdate(...a),
  },
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({ actor, db, apiToken, via: "session" })),
}));

const generateFeaturedImage = vi.fn();
vi.mock("@/lib/featured-image", () => ({
  generateFeaturedImage: (...a: unknown[]) => generateFeaturedImage(...a),
}));

import { POST } from "./route";

function call() {
  return POST(new NextRequest("http://localhost/api/cms/posts/p1/featured-image", { method: "POST" }), {
    params: Promise.resolve({ id: "p1" }),
  });
}

const POST_ROW = {
  id: "p1",
  title: "Hello",
  slug: "hello",
  author_id: "u1",
  author_name: "Author One",
  platforms: ["website"],
  featured_image: null,
  featured_image_alt: null,
};

beforeEach(() => {
  apiToken = null;
  actor.permissions = new Set(["content:edit"]);
  postFindUnique.mockReset().mockResolvedValue(POST_ROW);
  postUpdate.mockReset().mockImplementation(async ({ data }) => ({ id: "p1", ...data }));
  generateFeaturedImage.mockReset().mockResolvedValue({
    url: "https://cdn.example/card.png",
    alt: 'Title card reading "Hello"',
    media_id: "m1",
  });
});

describe("POST /api/cms/posts/[id]/featured-image", () => {
  it("generates and sets the image and alt", async () => {
    const res = await call();
    expect(res.status).toBe(201);
    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { featured_image: "https://cdn.example/card.png", featured_image_alt: 'Title card reading "Hello"' },
      })
    );
    expect((await res.json()).data.media_id).toBe("m1");
  });

  it("replaces the image but keeps a hand-written alt", async () => {
    postFindUnique.mockResolvedValue({ ...POST_ROW, featured_image: "old.png", featured_image_alt: "Mine" });
    await call();
    expect(postUpdate.mock.calls[0][0].data).toEqual({ featured_image: "https://cdn.example/card.png" });
  });

  it("refuses someone else's post without content:edit_any", async () => {
    postFindUnique.mockResolvedValue({ ...POST_ROW, author_id: "u2", author_name: "Jane" });
    const res = await call();
    expect(res.status).toBe(403);
    expect(generateFeaturedImage).not.toHaveBeenCalled();
  });

  it("refuses a post outside the token's sites", async () => {
    apiToken = { site_scopes: ["cms"] };
    const res = await call();
    expect(res.status).toBe(403);
    expect(generateFeaturedImage).not.toHaveBeenCalled();
  });

  it("404s an unknown post", async () => {
    postFindUnique.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it("502s when rendering/storage fails, without touching the post", async () => {
    generateFeaturedImage.mockRejectedValue(new Error("s3 down"));
    const res = await call();
    expect(res.status).toBe(502);
    expect(postUpdate).not.toHaveBeenCalled();
  });
});
