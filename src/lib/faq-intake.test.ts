import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const count = vi.fn();
const logCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    faq: { findMany: (...a: unknown[]) => findMany(...a) },
    faqIntakeLog: {
      count: (...a: unknown[]) => count(...a),
      create: (...a: unknown[]) => logCreate(...a),
    },
  },
}));

vi.mock("@/lib/tenant-db", () => ({ INTERACTOR_ORG_ID: "org-1" }));

const matchFaqQuestion = vi.fn();
const guessFaqCategory = vi.fn();
vi.mock("@/lib/faq/match", () => ({
  matchFaqQuestion: (...a: unknown[]) => matchFaqQuestion(...a),
  guessFaqCategory: (...a: unknown[]) => guessFaqCategory(...a),
}));

const createFaqDraft = vi.fn();
const incrementFaqAskedCount = vi.fn();
vi.mock("@/lib/faq-automation-client", () => ({
  createFaqDraft: (...a: unknown[]) => createFaqDraft(...a),
  incrementFaqAskedCount: (...a: unknown[]) => incrementFaqAskedCount(...a),
}));

const sendSlackNotification = vi.fn();
vi.mock("@/lib/slack", () => ({ sendSlackNotification: (...a: unknown[]) => sendSlackNotification(...a) }));

import { processFaqIntake } from "./faq-intake";

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([{ id: "faq-1", question: "Q1", answer: "A1" }]);
  count.mockReset().mockResolvedValue(0);
  logCreate.mockReset();
  matchFaqQuestion.mockReset();
  guessFaqCategory.mockReset().mockResolvedValue("billing");
  createFaqDraft.mockReset();
  incrementFaqAskedCount.mockReset();
  sendSlackNotification.mockReset();
  delete process.env.FAQ_INTAKE_MAX_DRAFTS_PER_DAY;
});

describe("processFaqIntake", () => {
  it("on a match: increments asked_count and logs outcome=matched, never drafts", async () => {
    matchFaqQuestion.mockResolvedValue({ matchedId: "faq-1", confidence: 0.9 });

    await processFaqIntake("what does self-hosting cost?");

    expect(incrementFaqAskedCount).toHaveBeenCalledWith("faq-1");
    expect(createFaqDraft).not.toHaveBeenCalled();
    expect(logCreate).toHaveBeenCalledWith({
      data: { organization_id: "org-1", question: "what does self-hosting cost?", outcome: "matched", matched_faq_id: "faq-1", confidence: 0.9 },
    });
  });

  it("on no match: drafts with a guessed category and notifies the reviewer", async () => {
    matchFaqQuestion.mockResolvedValue({ matchedId: null, confidence: 0.2 });
    guessFaqCategory.mockResolvedValue("self-hosting");
    createFaqDraft.mockResolvedValue({ id: "faq-new" });

    await processFaqIntake("how many GB of RAM per agent?");

    expect(createFaqDraft).toHaveBeenCalledWith({
      question: "how many GB of RAM per agent?",
      category: "self-hosting",
      audience: "sales-only",
    });
    expect(logCreate).toHaveBeenCalledWith({
      data: { organization_id: "org-1", question: "how many GB of RAM per agent?", outcome: "drafted", confidence: 0.2, created_faq_id: "faq-new" },
    });
    expect(sendSlackNotification).toHaveBeenCalledWith("faq_draft", expect.objectContaining({ question: "how many GB of RAM per agent?" }));
  });

  it("rate-limits: past the daily draft cap, logs rate_limited and never calls createFaqDraft", async () => {
    matchFaqQuestion.mockResolvedValue({ matchedId: null, confidence: 0 });
    process.env.FAQ_INTAKE_MAX_DRAFTS_PER_DAY = "3";
    count.mockResolvedValue(3);

    await processFaqIntake("another question");

    expect(createFaqDraft).not.toHaveBeenCalled();
    expect(sendSlackNotification).not.toHaveBeenCalled();
    expect(logCreate).toHaveBeenCalledWith({
      data: { organization_id: "org-1", question: "another question", outcome: "rate_limited", confidence: 0 },
    });
  });

  it("passes only published entries to the matcher", async () => {
    matchFaqQuestion.mockResolvedValue({ matchedId: null, confidence: 0 });
    createFaqDraft.mockResolvedValue(null);

    await processFaqIntake("question");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "published", audience: "public" }) })
    );
  });

  it("does not notify Slack when createFaqDraft returns null (automation token unconfigured)", async () => {
    matchFaqQuestion.mockResolvedValue({ matchedId: null, confidence: 0 });
    createFaqDraft.mockResolvedValue(null);

    await processFaqIntake("question");

    expect(sendSlackNotification).not.toHaveBeenCalled();
    expect(logCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ created_faq_id: null }) }));
  });
});
