import { describe, expect, it } from "vitest";
import {
  joinPartsText,
  MAX_SOCIAL_PARTS,
  parsePartsPayload,
  parsePartsText,
  socialPostParts,
  splitPartsText,
  storedParts,
} from "./parts";

const X = { threads: true, firstComment: true };

describe("splitPartsText / joinPartsText", () => {
  it("splits on --- lines and a --- first comment line, and joins back to the same text", () => {
    const text = "Hook\n---\nTwo\n---\nThree\n--- first comment\nThe link";
    const split = splitPartsText(text, X);
    expect(split).toEqual({
      body: "Hook",
      parts: [
        { kind: "thread", body: "Two" },
        { kind: "thread", body: "Three" },
        { kind: "first_comment", body: "The link" },
      ],
    });
    expect(joinPartsText(split.body, split.parts)).toBe(text);
  });

  it("reads Windows line endings and stray spacing on a separator", () => {
    expect(splitPartsText("One\r\n  ---  \r\nTwo", X).parts).toEqual([{ kind: "thread", body: "Two" }]);
  });

  it("keeps a separator the network can't use as text", () => {
    expect(splitPartsText("A\n---\nB", { threads: false, firstComment: false })).toEqual({
      body: "A\n---\nB",
      parts: [],
    });
  });

  it("drops empty tweets rather than posting a blank reply", () => {
    expect(splitPartsText("A\n---\n\n---\nB", X).parts).toEqual([{ kind: "thread", body: "B" }]);
  });

  it("treats --- inside the first comment as part of the comment", () => {
    expect(splitPartsText("A\n--- first comment\nx\n---\ny", X).parts).toEqual([
      { kind: "first_comment", body: "x\n---\ny" },
    ]);
  });
});

describe("parsePartsPayload", () => {
  it("leaves parts alone when none are sent, and clears on null", () => {
    expect(parsePartsPayload(undefined)).toEqual({ ok: true, parts: undefined });
    expect(parsePartsPayload(null)).toEqual({ ok: true, parts: [] });
  });

  it("accepts the first comment only as the last part", () => {
    expect(
      parsePartsPayload([
        { kind: "thread", body: "t" },
        { kind: "first_comment", body: "c" },
      ])
    ).toEqual({ ok: true, parts: [{ kind: "thread", body: "t" }, { kind: "first_comment", body: "c" }] });
    expect(
      parsePartsPayload([
        { kind: "first_comment", body: "c" },
        { kind: "thread", body: "t" },
      ])
    ).toEqual({ ok: false, message: "The first comment must be the last part." });
  });

  it("refuses two first comments, a bad kind, and too many parts", () => {
    expect(parsePartsPayload([{ kind: "first_comment", body: "a" }, { kind: "first_comment", body: "b" }])).toEqual({
      ok: false,
      message: "A post can have only one first comment.",
    });
    expect(parsePartsPayload("x")).toMatchObject({ ok: false });
    expect(parsePartsPayload([{ kind: "thread" }])).toEqual({ ok: false, message: "Part 1 needs a body." });
    const many = Array.from({ length: MAX_SOCIAL_PARTS + 1 }, () => ({ kind: "thread", body: "t" }));
    expect(parsePartsPayload(many)).toMatchObject({ ok: false });
  });
});

describe("parsePartsText", () => {
  const tweets = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`).join("\n---\n");

  it("splits like splitPartsText while within the cap", () => {
    const ok = parsePartsText(tweets(MAX_SOCIAL_PARTS + 1), X);
    expect(ok).toMatchObject({ ok: true, body: "t0" });
    expect(ok.ok && ok.parts).toHaveLength(MAX_SOCIAL_PARTS);
  });

  it("refuses more parts than the cap rather than storing them", () => {
    const refused = parsePartsText(tweets(40), X);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toMatch(/40 parts/);
  });

  it("refuses a second first comment rather than dropping it", () => {
    expect(parsePartsText("a\n--- first comment\nb\n--- first comment\nc", X)).toMatchObject({ ok: false });
    // A network with no first comment keeps those lines as text.
    expect(parsePartsText("a\n--- first comment\nb\n--- first comment\nc", { threads: false, firstComment: false }))
      .toMatchObject({ ok: true, parts: [] });
  });
});

describe("socialPostParts", () => {
  it("reads the parts column once it is written, even empty", () => {
    expect(socialPostParts({ body: "A\n---\nB", parts: [], network: "twitter" })).toEqual({
      body: "A\n---\nB",
      parts: [],
    });
  });

  it("splits X copy from before the column existed, and only X copy", () => {
    expect(socialPostParts({ body: "A\n---\nB", parts: null, network: "twitter" }).parts).toEqual([
      { kind: "thread", body: "B" },
    ]);
    expect(socialPostParts({ body: "A\n---\nB", parts: null, network: "linkedin" }).parts).toEqual([]);
    expect(socialPostParts({ body: "A\n---\nB", parts: null, network: null }).parts).toEqual([]);
  });

  it("skips malformed stored parts", () => {
    expect(storedParts([{ kind: "thread", body: "ok" }, { kind: "nope", body: "x" }, null, "s"])).toEqual([
      { kind: "thread", body: "ok" },
    ]);
  });
});
