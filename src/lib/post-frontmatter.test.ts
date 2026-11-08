import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import {
  parsePostFile,
  serializePostFile,
  splitFrontmatter,
  assertMetadataWithinBounds,
  isMetadataObject,
  MetadataValidationError,
  FrontmatterValidationError,
  METADATA_MAX_KEYS,
  METADATA_MAX_KEY_LENGTH,
  METADATA_MAX_BYTES,
  type ExportablePost,
} from "./post-frontmatter";
import { computeContentHash } from "./markdown";

const baseExport: ExportablePost = {
  id: "p1",
  content_hash: null,
  title: "Hello",
  slug: "hello",
  status: "draft",
  type: "blog",
  excerpt: null,
  category: null,
  tags: [],
  platforms: [],
  featured_image: null,
  featured_image_alt: null,
  meta_description: null,
  meta_keywords: null,
  seo_title: null,
  canonical_url: null,
  og_image: null,
  og_image_alt: null,
  noindex: false,
  answer_summary: null,
  redirect_to: null,
  content_format: "markdown",
  published_at: null,
  content: "# Hello\n\nBody.",
};

describe("unknown frontmatter keys are preserved, not stripped", () => {
  // The regression this whole change exists for: zod's default z.object()
  // STRIPS unknown keys, so a file carrying per-content-type frontmatter
  // imported with those keys silently gone.
  it("routes unrecognized keys into metadata instead of dropping them", () => {
    const raw = [
      "---",
      "title: Self-hosting cost",
      "type: faq",
      "verify_every_days: 90",
      "audience: sales-only",
      "sources:",
      "  - https://example.com/pricing",
      "---",
      "",
      "The answer.",
    ].join("\n");

    const { frontmatter, metadata, body } = parsePostFile(raw);

    expect(frontmatter.title).toBe("Self-hosting cost");
    expect(frontmatter.type).toBe("faq");
    expect(metadata).toEqual({
      verify_every_days: 90,
      audience: "sales-only",
      sources: ["https://example.com/pricing"],
    });
    expect(body).toBe("The answer.");
  });

  it("keeps metadata empty when a file carries only known keys", () => {
    const raw = "---\ntitle: Plain\ntype: blog\n---\n\nBody.";
    expect(parsePostFile(raw).metadata).toEqual({});
  });

  it("splitFrontmatter never lets a known key leak into metadata", () => {
    const { frontmatter, metadata } = splitFrontmatter({
      title: "T",
      slug: "s",
      content_format: "markdown",
      custom_key: 1,
    });
    expect(Object.keys(metadata)).toEqual(["custom_key"]);
    expect(frontmatter.slug).toBe("s");
  });
});

describe("round trip is lossless", () => {
  it("re-emits metadata keys so export → import → export preserves them", () => {
    const metadata = {
      verify_every_days: 90,
      audience: "sales-only",
      sources: ["https://example.com/a", "https://example.com/b"],
      nested: { reviewed_by: "peter", score: 4.5 },
      flagged: true,
    };

    const file = serializePostFile({ ...baseExport, type: "faq", metadata });
    const reparsed = parsePostFile(file);

    // Values survive the trip intact, not merely "some keys present".
    expect(reparsed.metadata).toEqual(metadata);
    expect(reparsed.frontmatter.type).toBe("faq");

    // And a second export from the reparsed values is byte-identical to the
    // first — the property that makes git-sync diffs meaningful.
    const file2 = serializePostFile({
      ...baseExport,
      type: "faq",
      metadata: reparsed.metadata,
    });
    expect(file2).toBe(file);
  });

  it("emits metadata keys in a stable order regardless of insertion order", () => {
    const a = serializePostFile({ ...baseExport, metadata: { b: 2, a: 1, c: 3 } });
    const b = serializePostFile({ ...baseExport, metadata: { c: 3, a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it("ignores a non-object Json column value rather than crashing", () => {
    // Post.metadata is a Json? column, so a scalar is representable even
    // though nothing writes one.
    const file = serializePostFile({ ...baseExport, metadata: "oops" });
    expect(matter(file).data.metadata).toBeUndefined();
    expect(isMetadataObject("oops")).toBe(false);
    expect(isMetadataObject(["a"])).toBe(false);
    expect(isMetadataObject({ a: 1 })).toBe(true);
  });
});

describe("content type is open, but bounded", () => {
  it("accepts a type this CMS does not ship with", () => {
    const raw = "---\ntitle: T\ntype: release-note\n---\n\nBody.";
    expect(parsePostFile(raw).frontmatter.type).toBe("release-note");
  });

  it.each(["Blog", "has space", "trailing-", "a".repeat(65), "under_score"])(
    "rejects %j as a content type",
    (type) => {
      const raw = `---\ntitle: T\ntype: ${JSON.stringify(type)}\n---\n\nBody.`;
      expect(() => parsePostFile(raw)).toThrow(FrontmatterValidationError);
    }
  );
});

describe("metadata bounds (untrusted .md input)", () => {
  it("rejects too many keys", () => {
    const metadata = Object.fromEntries(
      Array.from({ length: METADATA_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i])
    );
    expect(() => assertMetadataWithinBounds(metadata)).toThrow(MetadataValidationError);
  });

  it("rejects an overlong key", () => {
    expect(() =>
      assertMetadataWithinBounds({ ["k".repeat(METADATA_MAX_KEY_LENGTH + 1)]: 1 })
    ).toThrow(MetadataValidationError);
  });

  it("rejects an oversized payload", () => {
    expect(() =>
      assertMetadataWithinBounds({ big: "x".repeat(METADATA_MAX_BYTES + 1) })
    ).toThrow(MetadataValidationError);
  });

  it("accepts a payload exactly at the key-count bound", () => {
    const metadata = Object.fromEntries(
      Array.from({ length: METADATA_MAX_KEYS }, (_, i) => [`k${i}`, i])
    );
    expect(() => assertMetadataWithinBounds(metadata)).not.toThrow();
  });

  it("surfaces the bound through parsePostFile", () => {
    const lines = ["---", "title: T"];
    for (let i = 0; i <= METADATA_MAX_KEYS; i++) lines.push(`k${i}: ${i}`);
    lines.push("---", "", "Body.");
    expect(() => parsePostFile(lines.join("\n"))).toThrow(MetadataValidationError);
  });
});

describe("content_hash covers metadata (G#19 option A)", () => {
  it("changes when metadata changes even though the body does not", () => {
    const body = "# Same body";
    expect(computeContentHash(body, { v: 1 })).not.toBe(computeContentHash(body, { v: 2 }));
  });

  it("is stable across metadata key order", () => {
    const body = "# Same body";
    expect(computeContentHash(body, { a: 1, b: [1, 2], c: { d: 3, e: 4 } })).toBe(
      computeContentHash(body, { c: { e: 4, d: 3 }, b: [1, 2], a: 1 })
    );
  });

  it("still distinguishes array order, which is meaning", () => {
    const body = "# Same body";
    expect(computeContentHash(body, { xs: [1, 2] })).not.toBe(
      computeContentHash(body, { xs: [2, 1] })
    );
  });

  it("matches the old body-only hash when metadata is empty or absent", () => {
    // Guards against silently invalidating every stored content_hash and
    // forcing a spurious full re-sync of every existing post.
    const body = "# Body";
    const legacy = computeContentHash(body);
    expect(computeContentHash(body, {})).toBe(legacy);
    expect(computeContentHash(body, null)).toBe(legacy);
    expect(computeContentHash(body, undefined)).toBe(legacy);
  });
});
