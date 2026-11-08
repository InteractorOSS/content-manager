import { describe, expect, it, vi } from "vitest";
import { resolveSocialMediaPayload } from "./media-server";
import { SOCIAL_MEDIA_ALT_MAX, SOCIAL_MEDIA_MAX_ITEMS } from "./media";

// Stands in for the tenant-scoped client: rows from another org are simply
// not in this list, exactly as the scoped findMany would answer.
const ROWS = [
  { id: "m1", file_path: "https://cdn.example.com/a.png", mime_type: "image/png", alt_text: "A chart" },
  { id: "m2", file_path: "https://cdn.example.com/b.mp4", mime_type: "video/mp4", alt_text: null },
  { id: "m3", file_path: "https://cdn.example.com/c.pdf", mime_type: "application/pdf", alt_text: null },
];
function fakeDb() {
  return {
    media: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        ROWS.filter((r) => where.id.in.includes(r.id))
      ),
    },
  };
}

describe("resolveSocialMediaPayload — the post's media", () => {
  it("rebuilds each item from the library row, ignoring the caller's url and type", async () => {
    const result = await resolveSocialMediaPayload(fakeDb(), {
      media: [
        { media_id: "m1", url: "https://evil.example/x.png", type: "video" },
        { media_id: "m2", alt: "Launch demo" },
      ],
    });
    expect(result).toEqual({
      ok: true,
      media: [
        { media_id: "m1", url: "https://cdn.example.com/a.png", type: "image", alt: "A chart" },
        { media_id: "m2", url: "https://cdn.example.com/b.mp4", type: "video", alt: "Launch demo" },
      ],
      overrides: {},
    });
  });

  it("refuses a bare URL without querying", async () => {
    const db = fakeDb();
    const result = await resolveSocialMediaPayload(db, { media: [{ url: "https://example.com/x.png" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/media library/);
    expect(db.media.findMany).not.toHaveBeenCalled();
  });

  it("refuses an id that isn't in this org's library", async () => {
    const result = await resolveSocialMediaPayload(fakeDb(), { media: [{ media_id: "other_org_media" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/isn't in this organization's media library/);
  });

  it("refuses a file that isn't an image or video", async () => {
    const result = await resolveSocialMediaPayload(fakeDb(), { media: [{ media_id: "m3" }] });
    expect(result.ok).toBe(false);
  });

  it("refuses more items than any network takes, without querying", async () => {
    const db = fakeDb();
    const media = Array.from({ length: SOCIAL_MEDIA_MAX_ITEMS + 1 }, () => ({ media_id: "m1" }));
    const result = await resolveSocialMediaPayload(db, { media });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/at most 20/);
    expect(db.media.findMany).not.toHaveBeenCalled();
  });

  it("refuses alt text over the limit rather than cutting it", async () => {
    const result = await resolveSocialMediaPayload(fakeDb(), {
      media: [{ media_id: "m1", alt: "x".repeat(SOCIAL_MEDIA_ALT_MAX + 1) }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Alt text can be at most 1000 characters/);

    const fits = await resolveSocialMediaPayload(fakeDb(), {
      media: [{ media_id: "m1", alt: "x".repeat(SOCIAL_MEDIA_ALT_MAX) }],
    });
    expect(fits.ok).toBe(true);
  });

  it("leaves absent media undefined (keep what is stored) and null as none", async () => {
    expect(await resolveSocialMediaPayload(fakeDb(), {})).toEqual({ ok: true, media: undefined, overrides: {} });
    expect(await resolveSocialMediaPayload(fakeDb(), { media: null })).toEqual({ ok: true, media: [], overrides: {} });
  });
});

describe("resolveSocialMediaPayload — per-channel overrides", () => {
  it("keeps null (clear) and empty (no media) apart", async () => {
    const result = await resolveSocialMediaPayload(fakeDb(), {
      media_overrides: { c1: null, c2: [], c3: [{ media_id: "m1" }] },
    });
    expect(result).toEqual({
      ok: true,
      media: undefined,
      overrides: {
        c1: null,
        c2: [],
        c3: [{ media_id: "m1", url: "https://cdn.example.com/a.png", type: "image", alt: "A chart" }],
      },
    });
  });

  it("refuses an override carrying a URL", async () => {
    const result = await resolveSocialMediaPayload(fakeDb(), {
      media_overrides: { c1: [{ url: "https://x/y.png" }] },
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an override over the item bound", async () => {
    const result = await resolveSocialMediaPayload(fakeDb(), {
      media_overrides: { c1: Array.from({ length: SOCIAL_MEDIA_MAX_ITEMS + 1 }, () => ({ media_id: "m1" })) },
    });
    expect(result.ok).toBe(false);
  });

  it("resolves the post's media and every override with ONE lookup", async () => {
    const db = fakeDb();
    const result = await resolveSocialMediaPayload(db, {
      media: [{ media_id: "m1" }],
      media_overrides: { c1: [{ media_id: "m2" }], c2: [{ media_id: "m1" }], c3: null },
    });
    expect(result.ok).toBe(true);
    expect(db.media.findMany).toHaveBeenCalledTimes(1);
    expect(db.media.findMany.mock.calls[0][0].where.id.in.sort()).toEqual(["m1", "m2"]);
  });

  it("refuses the whole payload when one override names another org's file", async () => {
    const result = await resolveSocialMediaPayload(fakeDb(), {
      media: [{ media_id: "m1" }],
      media_overrides: { c1: [{ media_id: "other_org_media" }] },
    });
    expect(result.ok).toBe(false);
  });
});
