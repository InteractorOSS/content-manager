import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { postFindUnique } = vi.hoisted(() => ({ postFindUnique: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { post: { findUnique: postFindUnique } },
}));

import { signPreviewToken } from "@/lib/preview-link";
import { GET } from "./route";

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  postFindUnique.mockReset();
});

describe("GET /preview/[token]", () => {
  it("renders the post's content_html inside .prose-preview for a live link", async () => {
    const expiresAt = Date.now() + 100_000;
    const token = signPreviewToken("p1", expiresAt);
    postFindUnique.mockResolvedValue({
      id: "p1",
      title: "Hello <World>",
      content_html: "<p>Body <strong>text</strong></p>",
      preview_token_expires_at: new Date(expiresAt),
      workflow_status: "pending_review",
      rejection_reason: "not relevant",
      ai_generated_content: "secret ai draft",
      author_id: "internal-user-id",
      updated_at: new Date(1_700_000_000_000),
    });

    const res = await GET(new NextRequest("http://localhost/preview/x"), ctx(token));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="prose-preview"');
    expect(html).toContain("<p>Body <strong>text</strong></p>");
    // Title is HTML-escaped, not injected raw.
    expect(html).toContain("Hello &lt;World&gt;");
    expect(html).not.toContain("<World>");
    // Internal-only fields never appear in the rendered document.
    expect(html).not.toContain("pending_review");
    expect(html).not.toContain("not relevant");
    expect(html).not.toContain("secret ai draft");
    expect(html).not.toContain("internal-user-id");
    // Live reload: the page carries its version and the polling script.
    expect(html).toContain('data-version="1700000000000"');
    expect(html).toContain("/version");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The inline script lives in a TS template literal, where a stray escape
    // (e.g. `\/` collapsing to `/` and starting a `//` comment) silently breaks
    // it in the browser — so check the emitted source actually parses.
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(script).toContain("setInterval");
    expect(() => new Function(script)).not.toThrow();
  });

  it("returns a clean 404 for a tampered/malformed token, never the post", async () => {
    const res = await GET(new NextRequest("http://localhost/preview/x"), ctx("garbage"));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain("Body");
    expect(postFindUnique).not.toHaveBeenCalled();
  });

  it("returns 410 for an expired token", async () => {
    const token = signPreviewToken("p1", Date.now() - 1000);
    const res = await GET(new NextRequest("http://localhost/preview/x"), ctx(token));
    expect(res.status).toBe(410);
  });

  it("returns a clean 404 for a revoked link (token no longer matches the post's active one)", async () => {
    const token = signPreviewToken("p1", Date.now() + 100_000);
    postFindUnique.mockResolvedValue({ id: "p1", preview_token_expires_at: null });
    const res = await GET(new NextRequest("http://localhost/preview/x"), ctx(token));
    expect(res.status).toBe(404);
  });

  it("a token minted for one post can never resolve another post's content", async () => {
    // Someone edits the token's post-id segment by hand — the signature no
    // longer matches, so it never even reaches the db lookup for the other id.
    const expiresAt = Date.now() + 100_000;
    const token = signPreviewToken("post-a", expiresAt);
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [, expiresAtRaw, sig] = decoded.split(".");
    const forged = Buffer.from(`post-b.${expiresAtRaw}.${sig}`, "utf8").toString("base64url");

    const res = await GET(new NextRequest("http://localhost/preview/x"), ctx(forged));
    expect(res.status).toBe(404);
    expect(postFindUnique).not.toHaveBeenCalled();
  });
});
