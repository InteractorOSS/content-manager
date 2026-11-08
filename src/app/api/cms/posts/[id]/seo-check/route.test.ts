import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const postFindUnique = vi.fn();
const postFindFirst = vi.fn();
const db = { post: { findUnique: (...a: unknown[]) => postFindUnique(...a), findFirst: (...a: unknown[]) => postFindFirst(...a) } };

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({ actor: {}, db })),
}));

const reviewWithHumanizer = vi.fn();
vi.mock("@/lib/humanizer/review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/humanizer/review")>()),
  reviewWithHumanizer: (...a: unknown[]) => reviewWithHumanizer(...a),
}));

import { GET } from "./route";

function get(query = "") {
  return GET(new NextRequest(`http://localhost/api/cms/posts/p1/seo-check${query}`), { params: Promise.resolve({ id: "p1" }) });
}

beforeEach(() => {
  postFindUnique.mockReset();
  postFindFirst.mockReset();
  reviewWithHumanizer.mockReset();
  reviewWithHumanizer.mockResolvedValue(null);
});

describe("GET /api/cms/posts/[id]/seo-check", () => {
  it("404s when the post doesn't resolve", async () => {
    postFindUnique.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
  });

  it("reports readiness errors and warnings, including a duplicate-title finding from the DB", async () => {
    postFindUnique.mockResolvedValue({
      id: "p1",
      title: "Short",
      slug: "short",
      meta_description: null,
      content_html: "<p>Body</p>",
      answer_summary: null,
      featured_image: null,
      featured_image_alt: null,
    });
    postFindFirst.mockResolvedValue({ id: "other" });

    const res = await get();
    const { data } = await res.json();

    expect(data.errors).toContainEqual(expect.objectContaining({ key: "title_length" }));
    expect(data.warnings).toContainEqual(expect.objectContaining({ key: "duplicate_title" }));
    expect(postFindFirst).toHaveBeenCalledWith({ where: { id: { not: "p1" }, title: "Short" }, select: { id: true } });
  });

  it("adds the Humanizer findings as warnings: rule-based always, the model review when it ran", async () => {
    postFindUnique.mockResolvedValue({
      id: "p1",
      title: "Short",
      slug: "short",
      meta_description: null,
      content: "It's not just a song, it's a statement. Fast, simple, and powerful.",
      content_html: "<p>It's not just a song, it's a statement. Fast, simple, and powerful.</p>",
      answer_summary: null,
      featured_image: null,
      featured_image_alt: null,
    });
    postFindFirst.mockResolvedValue(null);
    reviewWithHumanizer.mockResolvedValue({
      version: "3.1.0",
      findings: [{ pattern: "6. Forced triads", quote: "Fast, simple, and powerful.", suggestion: "Name one." }],
    });

    const { data } = await (await get()).json();
    expect(data.warnings).toContainEqual(expect.objectContaining({ key: "humanizer_not_x_but_y" }));
    expect(data.warnings).toContainEqual({
      key: "humanizer_review",
      message: 'Reads as AI-written (6. Forced triads): "Fast, simple, and powerful.". Name one.',
    });
    expect(data.errors.some((e: { key: string }) => e.key.startsWith("humanizer"))).toBe(false);
    expect(data.humanizer).toEqual({ version: expect.any(String), reviewed: true });
  });

  it("says when the model review did not run, and skips it on ?humanizer_review=false", async () => {
    postFindUnique.mockResolvedValue({
      id: "p1", title: "Short", slug: "short", meta_description: null, content: "Body", content_html: "<p>Body</p>",
      answer_summary: null, featured_image: null, featured_image_alt: null,
    });
    postFindFirst.mockResolvedValue(null);

    expect((await (await get()).json()).data.humanizer.reviewed).toBe(false);
    expect(reviewWithHumanizer).toHaveBeenCalledTimes(1);
    expect((await (await get("?humanizer_review=false")).json()).data.humanizer.reviewed).toBe(false);
    expect(reviewWithHumanizer).toHaveBeenCalledTimes(1);
  });
});
