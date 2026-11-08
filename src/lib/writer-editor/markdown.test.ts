import { describe, expect, it } from "vitest";
import { applyEditsToOriginal, mergeEdits } from "./markdown";

// The editor re-serializes Markdown in its own style; these pin that only the
// writer's actual edits ever reach the saved text.
const original = "Intro line.\n\n* first item\n* second item\n\n***\n\n| a | b |\n|--|--|\n| 1 | 2 |\n\nClosing paragraph.";
const baseline = "Intro line.\n\n- first item\n- second item\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nClosing paragraph.\n";

describe("applyEditsToOriginal", () => {
  it("leaves the original byte-for-byte when nothing was edited", () => {
    expect(applyEditsToOriginal(original, baseline, baseline)).toEqual({ text: original, clean: true });
  });

  it("carries one edit into the original without the editor's reformatting", () => {
    const current = baseline.replace("Closing paragraph.", "Closing paragraph, reworded.");
    const res = applyEditsToOriginal(original, baseline, current);
    expect(res).toEqual({ text: original.replace("Closing paragraph.", "Closing paragraph, reworded."), clean: true });
  });

  it("keeps a Windows-line-ending post's own line endings around an edit", () => {
    const crlf = original.replace(/\n/g, "\r\n");
    const current = baseline.replace("Closing paragraph.", "Closing paragraph, reworded.");
    expect(applyEditsToOriginal(crlf, baseline, current)).toEqual({
      text: crlf.replace("Closing paragraph.", "Closing paragraph, reworded."),
      clean: true,
    });
  });

  it("finds an edit far below a table the editor re-padded", () => {
    const table = "| a | b |\n|--|--|\n" + "| 1 | 2 |\n".repeat(60);
    const padded = "| a   | b   |\n| --- | --- |\n" + "| 1   | 2   |\n".repeat(60);
    const orig = `${table}\nThe final sentence here.`;
    const base = `${padded}\nThe final sentence here.\n`;
    const res = applyEditsToOriginal(orig, base, base.replace("final", "last"));
    expect(res).toEqual({ text: orig.replace("final", "last"), clean: true });
  });

  it("keeps an edit even when it can't be placed, falling back to the editor's text", () => {
    const res = applyEditsToOriginal("completely different text", baseline, baseline + "\nAdded.");
    expect(res.clean).toBe(false);
    expect(res.text).toContain("Added.");
  });
});

describe("applyEditsToOriginal: a post stored without a final newline", () => {
  const original = "# Intro\n\nSome text.\n\nSecond paragraph.";
  const baseline = "# Intro\n\nSome text.\n\nSecond paragraph.\n";

  it("keeps a blank line before something added at the very end", () => {
    const current = `${baseline}\n![blue box](/u/b.png)\n`;
    expect(applyEditsToOriginal(original, baseline, current).text).toBe(
      "# Intro\n\nSome text.\n\nSecond paragraph.\n\n![blue box](/u/b.png)\n"
    );
  });

  it("doesn't add a final newline for words typed onto the last line", () => {
    const current = baseline.replace("Second paragraph.", "Second paragraph, extended.");
    expect(applyEditsToOriginal(original, baseline, current).text).toBe(original.replace("paragraph.", "paragraph, extended."));
  });

  it("doesn't add a final newline when only the middle was edited", () => {
    const current = baseline.replace("Some text.", "Some new text.");
    expect(applyEditsToOriginal(original, baseline, current).text).toBe(original.replace("Some text.", "Some new text."));
  });
});

describe("mergeEdits", () => {
  const base = "One.\n\nTwo.\n\nThree.";
  it("combines edits to different paragraphs", () => {
    const mine = base.replace("One.", "One, mine.");
    const theirs = base.replace("Three.", "Three, theirs.");
    expect(mergeEdits(base, mine, theirs)).toEqual({ text: "One, mine.\n\nTwo.\n\nThree, theirs.", clean: true });
  });
  it("takes theirs when I changed nothing, and mine when they changed nothing", () => {
    expect(mergeEdits(base, base, "X")).toEqual({ text: "X", clean: true });
    expect(mergeEdits(base, "Y", base)).toEqual({ text: "Y", clean: true });
  });
  it("reports a conflict when both rewrote the same sentence", () => {
    const res = mergeEdits(base, base.replace("Two.", "Two — my rewrite of it."), base.replace("Two.", "Deux, their rewrite."));
    expect(res.clean).toBe(false);
  });
});
