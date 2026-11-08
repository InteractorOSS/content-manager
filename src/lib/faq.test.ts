import { describe, expect, it } from "vitest";
import { isFaqCategory, isFaqAudience, isFaqStatus, PUBLIC_FAQ_WHERE } from "./faq";

describe("isFaqCategory", () => {
  it("accepts every documented category", () => {
    for (const c of ["pricing", "self-hosting", "security", "hosted-fleet", "ci", "billing"]) {
      expect(isFaqCategory(c)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isFaqCategory("support")).toBe(false);
    expect(isFaqCategory(undefined)).toBe(false);
    expect(isFaqCategory(123)).toBe(false);
  });
});

describe("isFaqAudience / isFaqStatus", () => {
  it("accepts only the documented values", () => {
    expect(isFaqAudience("public")).toBe(true);
    expect(isFaqAudience("sales-only")).toBe(true);
    expect(isFaqAudience("everyone")).toBe(false);

    expect(isFaqStatus("draft")).toBe(true);
    expect(isFaqStatus("review")).toBe(true);
    expect(isFaqStatus("published")).toBe(true);
    expect(isFaqStatus("archived")).toBe(false);
  });
});

describe("PUBLIC_FAQ_WHERE", () => {
  it("is exactly published + public — the one filter every public route must apply", () => {
    expect(PUBLIC_FAQ_WHERE).toEqual({ status: "published", audience: "public" });
  });
});
