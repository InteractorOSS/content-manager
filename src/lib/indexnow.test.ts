import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildIndexNowPingUrl,
  generateIndexNowKey,
  getOrCreateSiteIndexNowKey,
  notifyIndexNow,
  notifyIndexNowForPost,
  pingIndexNow,
  resolveIndexNowSites,
} from "./indexnow";

describe("generateIndexNowKey", () => {
  it("generates a 32-character hex key", () => {
    const key = generateIndexNowKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates a different key each time", () => {
    expect(generateIndexNowKey()).not.toBe(generateIndexNowKey());
  });
});

describe("buildIndexNowPingUrl", () => {
  it("URL-encodes the target URL and key", () => {
    const url = buildIndexNowPingUrl("https://example.com/a post?x=1", "abc key");
    expect(url).toBe(
      "https://api.indexnow.org/indexnow?url=https%3A%2F%2Fexample.com%2Fa%20post%3Fx%3D1&key=abc%20key"
    );
  });
});

describe("pingIndexNow", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports ok on a successful response", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const result = await pingIndexNow("https://example.com/hello", "key123");
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("reports the status on a non-2xx response without throwing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422 });
    const result = await pingIndexNow("https://example.com/hello", "key123");
    expect(result).toEqual({ ok: false, status: 422 });
  });

  it("never throws — a network failure resolves to {ok:false, error}", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const result = await pingIndexNow("https://example.com/hello", "key123");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("network down");
  });
});

describe("notifyIndexNow", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pings once per URL when the site has a key", () => {
    notifyIndexNow({ url: "https://example.com", indexnow_key: "key123" }, [
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never pings when the site has no indexnow_key — no error, just a silent skip", () => {
    notifyIndexNow({ url: "https://example.com", indexnow_key: null }, ["https://example.com/a"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not await the ping — returns synchronously even before fetch resolves", () => {
    let resolved = false;
    fetchMock.mockReturnValue(new Promise((resolve) => setTimeout(() => { resolved = true; resolve({ ok: true, status: 200 }); }, 50)));
    notifyIndexNow({ url: "https://example.com", indexnow_key: "key123" }, ["https://example.com/a"]);
    expect(resolved).toBe(false);
  });
});

describe("resolveIndexNowSites", () => {
  it("returns [] without querying when there are no platforms", async () => {
    const findMany = vi.fn();
    const db = { site: { findMany } } as unknown as Parameters<typeof resolveIndexNowSites>[0];
    const result = await resolveIndexNowSites(db, []);
    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("strips a trailing slash from each site's url and scopes by slug", async () => {
    const findMany = vi.fn().mockResolvedValue([{ url: "https://example.com/", indexnow_key: "key123" }]);
    const db = { site: { findMany } } as unknown as Parameters<typeof resolveIndexNowSites>[0];

    const result = await resolveIndexNowSites(db, ["website"]);

    expect(result).toEqual([{ url: "https://example.com", indexnow_key: "key123" }]);
    expect(findMany).toHaveBeenCalledWith({
      where: { slug: { in: ["website"] } },
      select: { url: true, indexnow_key: true },
    });
  });
});

describe("getOrCreateSiteIndexNowKey", () => {
  it("returns the existing key without writing when the site already has one", async () => {
    const updateMany = vi.fn();
    const db = { site: { updateMany } } as unknown as Parameters<typeof getOrCreateSiteIndexNowKey>[0];

    const key = await getOrCreateSiteIndexNowKey(db, { id: "site1", indexnow_key: "existing-key" });

    expect(key).toBe("existing-key");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("mints and persists a new key, conditioned on indexnow_key still being null", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn();
    const db = { site: { updateMany, findUnique } } as unknown as Parameters<
      typeof getOrCreateSiteIndexNowKey
    >[0];

    const key = await getOrCreateSiteIndexNowKey(db, { id: "site1", indexnow_key: null });

    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "site1", indexnow_key: null },
      data: { indexnow_key: key },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("hands back the WINNING key from a concurrent request, not the one it minted, when it loses the race", async () => {
    // count: 0 means the `indexnow_key: null` condition no longer matched —
    // another concurrent first-read's write landed first.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn().mockResolvedValue({ indexnow_key: "the-other-requests-key" });
    const db = { site: { updateMany, findUnique } } as unknown as Parameters<
      typeof getOrCreateSiteIndexNowKey
    >[0];

    const key = await getOrCreateSiteIndexNowKey(db, { id: "site1", indexnow_key: null });

    expect(key).toBe("the-other-requests-key");
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "site1" }, select: { indexnow_key: true } });
  });
});

describe("notifyIndexNowForPost", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pings every targeted site with every given slug", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([{ url: "https://example.com", indexnow_key: "key123" }]);
    const db = { site: { findMany } } as unknown as Parameters<typeof notifyIndexNowForPost>[0];

    await notifyIndexNowForPost(db, { platforms: ["website"] }, ["old-slug", "new-slug"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain(encodeURIComponent("https://example.com/old-slug"));
    expect(fetchMock.mock.calls[1][0]).toContain(encodeURIComponent("https://example.com/new-slug"));
  });

  it("no-ops without querying when there are no slugs to ping", async () => {
    const findMany = vi.fn();
    const db = { site: { findMany } } as unknown as Parameters<typeof notifyIndexNowForPost>[0];

    await notifyIndexNowForPost(db, { platforms: ["website"] }, []);

    expect(findMany).not.toHaveBeenCalled();
  });

  it("never throws even when resolving sites fails", async () => {
    const findMany = vi.fn().mockRejectedValue(new Error("db down"));
    const db = { site: { findMany } } as unknown as Parameters<typeof notifyIndexNowForPost>[0];

    await expect(notifyIndexNowForPost(db, { platforms: ["website"] }, ["a"])).resolves.toBeUndefined();
  });
});
