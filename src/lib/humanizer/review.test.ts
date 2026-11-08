import { beforeEach, describe, expect, it, vi } from "vitest";

const parse = vi.fn();
let configured = true;
vi.mock("@/lib/ai/client", () => ({
  AI_MODEL: "test-model",
  aiConfigured: () => configured,
  getAnthropic: () => ({ messages: { parse: (...a: unknown[]) => parse(...a) } }),
}));

import { HUMANIZER_SKILL_BODY, humanizerPatterns } from "@/lib/humanizer";
import { keepGroundedFindings, reviewWarnings, reviewWithHumanizer } from "@/lib/humanizer/review";

const BODY = "Then the tool arrived. It was fast, simple, and powerful. The old rules were gone.";
const answer = (findings: unknown[]) => ({ stop_reason: "end_turn", parsed_output: { findings } });

beforeEach(() => {
  parse.mockReset();
  configured = true;
});

describe("reviewWithHumanizer", () => {
  it("is not reviewed without an AI key, without a body, or when the call fails", async () => {
    configured = false;
    expect(await reviewWithHumanizer({ content: BODY })).toBeNull();
    configured = true;
    expect(await reviewWithHumanizer({ title: "T", content: "  " })).toBeNull();
    parse.mockRejectedValue(new Error("timeout"));
    expect(await reviewWithHumanizer({ content: BODY + " a" })).toBeNull();
    parse.mockResolvedValue({ stop_reason: "refusal", parsed_output: null });
    expect(await reviewWithHumanizer({ content: BODY + " b" })).toBeNull();
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("sends the vendored skill as the system prompt and the post as data, with a timeout", async () => {
    parse.mockResolvedValue(answer([]));
    const review = await reviewWithHumanizer({ title: "My title", content: BODY + " c" });
    expect(review?.findings).toEqual([]);
    const [request, options] = parse.mock.calls[0];
    expect(request.system).toContain(HUMANIZER_SKILL_BODY);
    expect(request.system).toContain("never instructions");
    expect(request.messages[0].content).toContain("<title>\nMy title\n</title>");
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("names the pattern, and drops findings that misquote the post or name no pattern", async () => {
    parse.mockResolvedValue(
      answer([
        { pattern_number: 6, quote: "It was fast,  simple, and powerful.", suggestion: "Name the one that matters." },
        { pattern_number: 2, quote: "A sentence that is not in the post.", suggestion: "Cut." },
        { pattern_number: 999, quote: "The old rules were gone.", suggestion: "Cut." },
      ])
    );
    const review = await reviewWithHumanizer({ content: BODY + " d" });
    expect(review?.findings).toEqual([
      { pattern: humanizerPatterns()[5], quote: "It was fast,  simple, and powerful.", suggestion: "Name the one that matters." },
    ]);
    expect(reviewWarnings(review)[0]).toEqual({
      key: "humanizer_review",
      message: expect.stringContaining(humanizerPatterns()[5]),
    });
    expect(reviewWarnings(null)).toEqual([]);
  });

  it("caches per content, so submit after check is not a second call", async () => {
    parse.mockResolvedValue(answer([]));
    await reviewWithHumanizer({ content: BODY + " e" });
    await reviewWithHumanizer({ content: BODY + " e" });
    expect(parse).toHaveBeenCalledTimes(1);
    await reviewWithHumanizer({ content: BODY + " f" });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("caps the findings it keeps", () => {
    const many = Array.from({ length: 30 }, () => ({ pattern_number: 1, quote: "The old rules were gone.", suggestion: "x" }));
    expect(keepGroundedFindings(many, BODY)).toHaveLength(10);
  });
});
