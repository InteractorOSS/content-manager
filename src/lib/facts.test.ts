import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { substituteFacts, UnknownFactsKeyError, getFacts, loadFacts, factsKeysIn, clearFactsCache } from "./facts";

describe("substituteFacts", () => {
  it("replaces every {{facts.<key>}} token with its resolved value", () => {
    const result = substituteFacts("Limit is {{facts.agentMemLimitGiB}} GiB.", { agentMemLimitGiB: 4 });
    expect(result).toBe("Limit is 4 GiB.");
  });

  it("resolves multiple distinct tokens in one string", () => {
    const result = substituteFacts("{{facts.a}} and {{facts.b}}", { a: 1, b: "two" });
    expect(result).toBe("1 and two");
  });

  it("throws UnknownFactsKeyError naming every missing key, not just the first", () => {
    expect(() => substituteFacts("{{facts.missing1}} {{facts.known}} {{facts.missing2}}", { known: "x" })).toThrow(
      UnknownFactsKeyError
    );
    try {
      substituteFacts("{{facts.missing1}} {{facts.known}} {{facts.missing2}}", { known: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownFactsKeyError);
      expect((e as UnknownFactsKeyError).keys.sort()).toEqual(["missing1", "missing2"]);
    }
  });

  it("leaves plain text with no tokens untouched", () => {
    expect(substituteFacts("No tokens here.", {})).toBe("No tokens here.");
  });
});

describe("getFacts", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearFactsCache();
    vi.mocked(readFile).mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("falls back to the _facts.json fixture when the endpoint is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ agentMemLimitGiB: 4 }));

    const facts = await getFacts();
    expect(facts).toEqual({ agentMemLimitGiB: 4 });
  });

  it("prefers the live endpoint when it responds ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ agentMemLimitGiB: 8 }),
    });

    const facts = await getFacts();
    expect(facts).toEqual({ agentMemLimitGiB: 8 });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("caches the result for 5 minutes without re-fetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ k: 1 }) });
    global.fetch = fetchMock;

    const start = 1_700_000_000_000;
    await getFacts(start);
    await getFacts(start + 60_000); // 1 minute later — still cached
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await getFacts(start + 6 * 60_000); // past the 5-minute TTL — refetches
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("loadFacts", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearFactsCache();
    vi.mocked(readFile).mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("reports source 'endpoint' when the live endpoint answers", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agentMemLimitGiB: 8 }) });

    await expect(loadFacts()).resolves.toEqual({ facts: { agentMemLimitGiB: 8 }, source: "endpoint" });
  });

  it("reports source 'fixture' when it falls back to the _facts.json placeholders", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ agentMemLimitGiB: 4 }));

    await expect(loadFacts()).resolves.toEqual({ facts: { agentMemLimitGiB: 4 }, source: "fixture" });
  });

  it("remembers the source across the cache window, so a cached load still reports it honestly", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ agentMemLimitGiB: 4 }));

    const start = 1_700_000_000_000;
    await loadFacts(start);
    await expect(loadFacts(start + 60_000)).resolves.toMatchObject({ source: "fixture" });
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});

describe("factsKeysIn", () => {
  it("lists every distinct key a piece of markdown depends on, in first-appearance order", () => {
    expect(factsKeysIn("{{facts.b}} then {{facts.a}} then {{facts.b}} again")).toEqual(["b", "a"]);
  });

  it("returns nothing for text with no tokens", () => {
    expect(factsKeysIn("plain prose, ~$98/mo")).toEqual([]);
  });
});
