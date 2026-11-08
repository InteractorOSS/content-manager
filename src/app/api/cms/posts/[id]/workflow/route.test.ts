import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const actor = {
  user: { id: "u1", email: "author@example.com", name: "Author One", status: "active" },
  organizationId: "org1",
  membershipRole: "editor",
  permissions: new Set<string>(["content:edit", "content:approve", "content:publish"]),
};

function goodPost(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    author_id: "u1",
    platforms: ["website"],
    status: "draft",
    workflow_status: "pending_review",
    title: "A Complete Guide To Post Readiness",
    slug: "a-complete-guide-to-post-readiness",
    content: "<p>Body</p>",
    content_html:
      "<p>Readiness is a discipline that keeps every post's SEO signals consistent before it ships.</p>" +
      '<h2>How does it work?</h2><p>92% pass on the first try. <a href="/docs">docs</a> <a href="/mcp">mcp</a> ' +
      '<a href="https://schema.org">schema.org</a>.</p>',
    meta_description: "Learn how the readiness check keeps every post's SEO signals consistent before it ships.",
    answer_summary:
      "Interactor's SEO readiness check runs before every publish so a post never ships missing a meta " +
      "description, alt text or a real answer summary — the same check every editor and MCP client uses.",
    featured_image: "/hero.png",
    featured_image_alt: "Hero image",
    approved_at: null,
    approved_by_id: null,
    rejection_reason: null,
    published_at: null,
    preview_token_expires_at: null,
    inserted_at: new Date(),
    updated_at: new Date(),
    ai_style_profile_id: null,
    ai_generated_content: null,
    ...overrides,
  };
}

const postFindUnique = vi.fn();
const postUpdate = vi.fn();
const postFindFirst = vi.fn();
const contentApprovalCreate = vi.fn();
const db = {
  post: { findUnique: (...a: unknown[]) => postFindUnique(...a), update: (...a: unknown[]) => postUpdate(...a), findFirst: (...a: unknown[]) => postFindFirst(...a) },
  contentApproval: { create: (...a: unknown[]) => contentApprovalCreate(...a) },
  $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
};

let via: "session" | "token" = "session";
vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({ actor, db, apiToken: null, via })),
}));
const reviewWithHumanizer = vi.fn();
vi.mock("@/lib/humanizer/review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/humanizer/review")>()),
  reviewWithHumanizer: (...a: unknown[]) => reviewWithHumanizer(...a),
}));
vi.mock("@/lib/featured-image", () => ({ generateFeaturedImageOrNull: vi.fn() }));
vi.mock("@/lib/ai/client", () => ({ aiConfigured: () => false }));
vi.mock("@/lib/ai/style", () => ({ proposeGuideAmendment: vi.fn() }));

import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/cms/posts/p1/workflow", { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "p1" }) }
  );
}

beforeEach(() => {
  postFindUnique.mockReset();
  postUpdate.mockReset();
  postFindFirst.mockReset();
  contentApprovalCreate.mockReset();
  postFindFirst.mockResolvedValue(null); // no duplicate title, not exercised here anyway
  via = "session";
  reviewWithHumanizer.mockReset();
  reviewWithHumanizer.mockResolvedValue(null);
  postUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...goodPost(), ...data }));
  contentApprovalCreate.mockResolvedValue({});
});

describe("POST workflow — Search & AI readiness gate (G#32)", () => {
  it("refuses to publish a post with readiness errors, listing them", async () => {
    postFindUnique.mockResolvedValue(goodPost({ meta_description: "Too short." }));
    const res = await post({ action: "publish" });
    expect(res.status).toBe(400);
    const { error, findings } = await res.json();
    expect(error).toBe("Search & AI readiness check failed");
    expect(findings).toContainEqual(expect.objectContaining({ key: "meta_description_length" }));
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("publishes a post with no readiness errors", async () => {
    postFindUnique.mockResolvedValue(goodPost());
    const res = await post({ action: "publish" });
    expect(res.status).toBe(200);
    expect(postUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "published" }) }));
  });

  it("refuses to approve a post with readiness errors, listing them", async () => {
    postFindUnique.mockResolvedValue(goodPost({ answer_summary: null }));
    const res = await post({ action: "approve" });
    expect(res.status).toBe(400);
    const { findings } = await res.json();
    expect(findings).toContainEqual(expect.objectContaining({ key: "answer_summary_length" }));
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("approves a post with no readiness errors", async () => {
    postFindUnique.mockResolvedValue(goodPost());
    const res = await post({ action: "approve" });
    expect(res.status).toBe(200);
    expect(postUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workflow_status: "approved" }) }));
  });

  it("does not gate submit or reject on readiness — only publish/approve", async () => {
    postFindUnique.mockResolvedValue(goodPost({ meta_description: "Too short.", workflow_status: "draft" }));
    const res = await post({ action: "submit" });
    expect(res.status).toBe(200);
  });
});

describe("POST workflow — Humanizer check for token callers", () => {
  const aiSounding = () =>
    goodPost({
      workflow_status: "draft",
      content_html:
        goodPost().content_html + "<p>It's not just a check, it's a discipline.</p>",
    });

  it("reports what it found on submit and publish, without refusing", async () => {
    via = "token";
    reviewWithHumanizer.mockResolvedValue({
      version: "3.1.0",
      findings: [{ pattern: "6. Forced triads", quote: "q", suggestion: "s" }],
    });
    for (const action of ["submit", "publish"]) {
      postFindUnique.mockResolvedValue(aiSounding());
      postUpdate.mockResolvedValue(aiSounding());
      const res = await post({ action });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.humanizer.reviewed).toBe(true);
      expect(json.humanizer.warnings.map((w: { key: string }) => w.key)).toEqual(
        expect.arrayContaining(["humanizer_not_x_but_y", "humanizer_review"])
      );
    }
  });

  it("still reports the rule-based findings when the model review didn't run", async () => {
    via = "token";
    postFindUnique.mockResolvedValue(aiSounding());
    postUpdate.mockResolvedValue(aiSounding());
    const json = await (await post({ action: "submit" })).json();
    expect(json.humanizer.reviewed).toBe(false);
    expect(json.humanizer.warnings).toContainEqual(expect.objectContaining({ key: "humanizer_not_x_but_y" }));
  });

  it("leaves browser sessions alone: no model call on the Publish button", async () => {
    postFindUnique.mockResolvedValue(aiSounding());
    postUpdate.mockResolvedValue(aiSounding());
    const json = await (await post({ action: "publish" })).json();
    expect(json.humanizer).toBeUndefined();
    expect(reviewWithHumanizer).not.toHaveBeenCalled();
  });
});
