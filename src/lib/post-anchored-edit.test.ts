import { describe, expect, it } from "vitest";
import { applyAnchoredReplacements } from "@/lib/post-anchored-edit";

describe("applyAnchoredReplacements", () => {
  it("replaces a single unique anchor", () => {
    const result = applyAnchoredReplacements("The quick brown fox.", [
      { find: "brown", replace: "red" },
    ]);
    expect(result).toEqual({ ok: true, content: "The quick red fox." });
  });

  it("applies multiple replacements in order, leaving the rest of the document byte-identical", () => {
    const content = "Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.";
    const result = applyAnchoredReplacements(content, [
      { find: "Alpha", replace: "Uno" },
      { find: "Gamma", replace: "Tres" },
    ]);
    expect(result).toEqual({
      ok: true,
      content: "Uno paragraph.\n\nBeta paragraph.\n\nTres paragraph.",
    });
  });

  it("lets a later anchor target text an earlier replacement just introduced", () => {
    const result = applyAnchoredReplacements("start middle end", [
      { find: "middle", replace: "MARKER" },
      { find: "MARKER", replace: "center" },
    ]);
    expect(result).toEqual({ ok: true, content: "start center end" });
  });

  it("fails the whole call on a zero-match anchor, naming the index and found count", () => {
    const content = "Alpha paragraph.\n\nBeta paragraph.";
    const result = applyAnchoredReplacements(content, [{ find: "Nonexistent", replace: "X" }]);
    expect(result).toEqual({
      ok: false,
      failure: { index: 0, find: "Nonexistent", expected_occurrences: 1, found_occurrences: 0 },
    });
  });

  it("fails on an ambiguous anchor (more matches than expected) without applying anything", () => {
    const content = "cat cat cat";
    const result = applyAnchoredReplacements(content, [{ find: "cat", replace: "dog" }]);
    expect(result).toEqual({
      ok: false,
      failure: { index: 0, find: "cat", expected_occurrences: 1, found_occurrences: 3 },
    });
  });

  it("respects an explicit expected_occurrences to replace every match", () => {
    const result = applyAnchoredReplacements("cat cat cat", [
      { find: "cat", replace: "dog", expected_occurrences: 3 },
    ]);
    expect(result).toEqual({ ok: true, content: "dog dog dog" });
  });

  it("changes nothing when a later replacement in a multi-replacement call fails", () => {
    // The first replacement's anchor is real and would succeed on its own,
    // but the whole call must still report the original, untouched content
    // was never returned as a successful result — the caller sees only the
    // failure, never a partial content string.
    const content = "Alpha paragraph.\n\nBeta paragraph.";
    const result = applyAnchoredReplacements(content, [
      { find: "Alpha", replace: "Uno" },
      { find: "Nonexistent", replace: "X" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toEqual({
        index: 1,
        find: "Nonexistent",
        expected_occurrences: 1,
        found_occurrences: 0,
      });
    }
  });

  it("counts non-overlapping occurrences, not overlapping ones", () => {
    // "aaa" contains "aa" starting at index 0 and index 1 if overlaps were
    // allowed (2), but non-overlapping counting finds only 1.
    const result = applyAnchoredReplacements("aaa", [{ find: "aa", replace: "b" }]);
    expect(result).toEqual({ ok: true, content: "ba" });
  });

  it("treats an empty find as never matching (found_occurrences: 0), not every position", () => {
    const result = applyAnchoredReplacements("hello", [{ find: "", replace: "x" }]);
    expect(result).toEqual({
      ok: false,
      failure: { index: 0, find: "", expected_occurrences: 1, found_occurrences: 0 },
    });
  });

  it("allows an empty replace to delete the matched text", () => {
    const result = applyAnchoredReplacements("Hello, world!", [{ find: ", world", replace: "" }]);
    expect(result).toEqual({ ok: true, content: "Hello!" });
  });
});
