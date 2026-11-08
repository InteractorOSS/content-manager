import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { NEXTAUTH_URL: "https://cms.test", FAQ_AUTOMATION_API_TOKEN: "cms_pat_test" },
}));

import { createFaqDraft, incrementFaqAskedCount, touchFaqLastVerified } from "./faq-automation-client";

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("faq-automation-client", () => {
  it("createFaqDraft POSTs to /api/automation/faq with a Bearer token and returns the new id", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "faq-1" } }),
    });

    const result = await createFaqDraft({ question: "q", category: "billing", audience: "sales-only" });

    expect(result).toEqual({ id: "faq-1" });
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://cms.test/api/automation/faq");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer cms_pat_test");
  });

  it("incrementFaqAskedCount PATCHes with increment_asked_count: true", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({}) });

    await incrementFaqAskedCount("faq-1");

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://cms.test/api/automation/faq/faq-1");
    expect(JSON.parse(init.body)).toEqual({ increment_asked_count: true });
  });

  it("touchFaqLastVerified never sends answer or status", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({}) });

    await touchFaqLastVerified("faq-1", new Date("2026-09-10T00:00:00.000Z"));

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ last_verified: "2026-09-10T00:00:00.000Z" });
    expect(body.answer).toBeUndefined();
    expect(body.status).toBeUndefined();
  });

  it("throws with the response status and body on a non-ok response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    });

    await expect(incrementFaqAskedCount("faq-1")).rejects.toThrow(/403/);
  });
});
