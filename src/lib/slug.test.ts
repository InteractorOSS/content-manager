import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
  it("kebabs free text", () => {
    expect(slugify("Facebook (personal profile)")).toBe("facebook-personal-profile");
  });

  it("strips punctuation and collapses separators", () => {
    expect(slugify("  Peter's   Org!!  ")).toBe("peter-s-org");
  });

  it("returns empty for input with nothing usable, so callers can reject it or fall back", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
  });

  it("never leaves a leading or trailing hyphen", () => {
    expect(slugify("---Acme---")).toBe("acme");
  });

  it("caps length only when maxLength is passed", () => {
    expect(slugify("x".repeat(200))).toHaveLength(200);
    expect(slugify("x".repeat(200), { maxLength: 48 })).toHaveLength(48);
  });
});
