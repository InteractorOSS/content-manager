import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parse = vi.fn();
vi.mock("@/lib/ai/client", () => ({
  getAnthropic: () => ({ messages: { parse: (...a: unknown[]) => parse(...a) } }),
  AI_MODEL: "test-model",
}));

const findMany = vi.fn();
const revisionCreate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    faq: { findMany: (...a: unknown[]) => findMany(...a) },
    faqRevision: { create: (...a: unknown[]) => revisionCreate(...a) },
  },
}));

const touchFaqLastVerified = vi.fn();
vi.mock("@/lib/faq-automation-client", () => ({
  touchFaqLastVerified: (...a: unknown[]) => touchFaqLastVerified(...a),
}));

const sendSlackNotification = vi.fn();
vi.mock("@/lib/slack", () => ({ sendSlackNotification: (...a: unknown[]) => sendSlackNotification(...a) }));

vi.mock("@/lib/env", () => ({ env: { NEXTAUTH_URL: "https://cms.test" } }));

import { checkFaqFreshness, runFreshnessPass } from "./faq-freshness";

const originalFetch = global.fetch;

beforeEach(() => {
  parse.mockReset();
  findMany.mockReset();
  revisionCreate.mockReset();
  touchFaqLastVerified.mockReset();
  sendSlackNotification.mockReset();
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("checkFaqFreshness", () => {
  it("returns unchanged when the model finds nothing material", async () => {
    parse.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: { changed: false, updated_answer: null, diff_summary: null },
    });
    const result = await checkFaqFreshness({
      question: "q",
      currentAnswer: "answer",
      sources: [{ url: "https://example.com", content: "same as before" }],
    });
    expect(result).toEqual({ changed: false, updatedAnswer: null, diffSummary: null });
  });

  it("returns the updated answer + diff summary when something changed", async () => {
    parse.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: { changed: true, updated_answer: "new price is $50/mo", diff_summary: "price $40 -> $50" },
    });
    const result = await checkFaqFreshness({
      question: "q",
      currentAnswer: "old price is $40/mo",
      sources: [{ url: "https://example.com", content: "now $50/mo" }],
    });
    expect(result).toEqual({ changed: true, updatedAnswer: "new price is $50/mo", diffSummary: "price $40 -> $50" });
  });

  it("returns unchanged on refusal", async () => {
    parse.mockResolvedValue({ stop_reason: "refusal", parsed_output: null });
    const result = await checkFaqFreshness({ question: "q", currentAnswer: "a", sources: [] });
    expect(result.changed).toBe(false);
  });
});

describe("runFreshnessPass", () => {
  function faqRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "faq-1",
      organization_id: "org-1",
      question: "How much does it cost?",
      answer: "It costs $40/mo",
      sources: ["https://example.com/pricing"],
      last_verified: new Date("2020-01-01"),
      verify_every_days: 90,
      ...overrides,
    };
  }

  it("skips entries that aren't due yet", async () => {
    findMany.mockResolvedValue([faqRow({ last_verified: new Date(), verify_every_days: 90 })]);

    const result = await runFreshnessPass();

    expect(result).toEqual({ needsReview: 0, unchangedCount: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });

  it("treats never-verified (null last_verified) as due", async () => {
    findMany.mockResolvedValue([faqRow({ last_verified: null })]);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => "content" });
    parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { changed: false, updated_answer: null, diff_summary: null } });

    const result = await runFreshnessPass();

    expect(result.unchangedCount).toBe(1);
  });

  it("on unchanged: touches last_verified, does not create a revision", async () => {
    findMany.mockResolvedValue([faqRow()]);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => "still $40/mo" });
    parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { changed: false, updated_answer: null, diff_summary: null } });

    const result = await runFreshnessPass();

    expect(result).toEqual({ needsReview: 0, unchangedCount: 1 });
    expect(revisionCreate).not.toHaveBeenCalled();
    expect(touchFaqLastVerified).toHaveBeenCalledWith("faq-1", expect.any(Date));
  });

  it("on changed: creates a FaqRevision (never edits Faq.answer), still touches last_verified", async () => {
    findMany.mockResolvedValue([faqRow()]);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => "now $50/mo" });
    parse.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: { changed: true, updated_answer: "It costs $50/mo", diff_summary: "$40 -> $50" },
    });

    const result = await runFreshnessPass();

    expect(result).toEqual({ needsReview: 1, unchangedCount: 0 });
    expect(revisionCreate).toHaveBeenCalledWith({ data: { faq_id: "faq-1", answer: "It costs $50/mo" } });
    expect(touchFaqLastVerified).toHaveBeenCalledWith("faq-1", expect.any(Date));
  });

  it("sends exactly one Slack summary, not one per entry", async () => {
    findMany.mockResolvedValue([faqRow({ id: "faq-1" }), faqRow({ id: "faq-2" })]);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => "content" });
    parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { changed: false, updated_answer: null, diff_summary: null } });

    await runFreshnessPass();

    expect(sendSlackNotification).toHaveBeenCalledTimes(1);
    expect(sendSlackNotification).toHaveBeenCalledWith("faq_freshness", { needsReview: 0, unchangedCount: 2, url: "https://cms.test/faqs" });
  });

  it("when every source fails to fetch: skips the entry entirely, leaves last_verified untouched so it stays due", async () => {
    findMany.mockResolvedValue([faqRow()]);
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));

    const result = await runFreshnessPass();

    expect(result).toEqual({ needsReview: 0, unchangedCount: 0 });
    expect(parse).not.toHaveBeenCalled();
    expect(touchFaqLastVerified).not.toHaveBeenCalled();
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });

  it("an entry with no sources configured at all: still counts as unchanged and touches last_verified (nothing to check against)", async () => {
    findMany.mockResolvedValue([faqRow({ sources: [] })]);

    const result = await runFreshnessPass();

    expect(result).toEqual({ needsReview: 0, unchangedCount: 1 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(touchFaqLastVerified).toHaveBeenCalledWith("faq-1", expect.any(Date));
  });
});
