import { describe, expect, it } from "vitest";
import { extractFaqSection, resolvePostSeo, type SeoOrganization, type SeoPostInput, type SeoSite } from "./post-seo";

const SITE: SeoSite = { url: "https://example.com", name: "Example Blog", publisher_name: null, logo_url: null };
const ORG: SeoOrganization = { name: "Example Inc", logo: null, same_as: [] };

function basePost(overrides: Partial<SeoPostInput> = {}): SeoPostInput {
  return {
    slug: "hello",
    title: "Hello World",
    seo_title: null,
    meta_description: null,
    excerpt: null,
    content_html: "<p>Body</p>",
    featured_image: null,
    featured_image_alt: null,
    og_image: null,
    og_image_alt: null,
    canonical_url: null,
    noindex: false,
    meta_keywords: null,
    author_name: null,
    author: null,
    category: null,
    published_at: new Date("2026-01-01T00:00:00.000Z"),
    content_updated_at: new Date("2026-02-01T00:00:00.000Z"),
    updated_at: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("resolvePostSeo", () => {
  it("falls back to title/excerpt and builds the canonical URL from the site", () => {
    const seo = resolvePostSeo(basePost({ excerpt: "An excerpt." }), SITE, ORG);
    expect(seo.title).toBe("Hello World");
    expect(seo.description).toBe("An excerpt.");
    expect(seo.canonical).toBe("https://example.com/hello");
    expect(seo.robots).toBe("index, follow");
  });

  it("prefers seo_title, meta_description and a syndicated canonical_url", () => {
    const seo = resolvePostSeo(
      basePost({
        seo_title: "Better SERP title",
        meta_description: "Better description.",
        canonical_url: "https://original.example.com/hello",
      }),
      SITE,
      ORG
    );
    expect(seo.title).toBe("Better SERP title");
    expect(seo.description).toBe("Better description.");
    expect(seo.canonical).toBe("https://original.example.com/hello");
  });

  it("sets robots to noindex, nofollow when the post is marked noindex", () => {
    expect(resolvePostSeo(basePost({ noindex: true }), SITE, ORG).robots).toBe("noindex, nofollow");
  });

  it("uses og_image over featured_image, and a summary_large_image twitter card only with an image", () => {
    const withImage = resolvePostSeo(
      basePost({ og_image: "/og.png", featured_image: "/featured.png" }),
      SITE,
      ORG
    );
    expect(withImage.og.image).toBe("/og.png");
    expect(withImage.twitter.card).toBe("summary_large_image");

    const noImage = resolvePostSeo(basePost(), SITE, ORG);
    expect(noImage.og.image).toBeUndefined();
    expect(noImage.twitter.card).toBe("summary");
  });

  it("carries an image's alt text onto og and twitter, using og_image_alt over featured_image_alt", () => {
    const seo = resolvePostSeo(
      basePost({ og_image: "/og.png", og_image_alt: "Chart", featured_image_alt: "Fallback alt" }),
      SITE,
      ORG
    );
    expect(seo.og.imageAlt).toBe("Chart");
    expect(seo.twitter.imageAlt).toBe("Chart");
  });

  it("never sets imageAlt when there is no image at all, even if an alt string is set", () => {
    const seo = resolvePostSeo(basePost({ featured_image_alt: "Orphan alt, no image" }), SITE, ORG);
    expect(seo.og.imageAlt).toBeUndefined();
    expect(seo.twitter.imageAlt).toBeUndefined();
  });

  it("types a named byline as a Person, not an Organization — the exact gap the plan calls out", () => {
    const seo = resolvePostSeo(
      basePost({ author: { name: "Jane Doe", slug: "jane", job_title: null, bio: null, avatar_url: null, same_as: ["https://x.com/jane"] } }),
      SITE,
      ORG
    );
    const blogPosting = seo.json_ld[0] as { author: { "@type": string; name: string; sameAs?: string[] } };
    expect(blogPosting.author).toEqual({ "@type": "Person", name: "Jane Doe", sameAs: ["https://x.com/jane"] });
  });

  it("does not attach a linked profile's sameAs when the visible byline overrides its name", () => {
    // resolveAuthorOverride (rbac.ts) supports crediting a post to a name
    // that diverges from the linked profile — a guest byline, "Interactor
    // Team", etc. The displayed name wins, and sameAs must not follow the
    // real profile's social links onto a name that isn't actually them.
    const seo = resolvePostSeo(
      basePost({
        author_name: "Guest Contributor",
        author: { name: "Jane Doe", slug: "jane", job_title: null, bio: null, avatar_url: null, same_as: ["https://x.com/jane"] },
      }),
      SITE,
      ORG
    );
    const blogPosting = seo.json_ld[0] as { author: { "@type": string; name: string; sameAs?: string[] } };
    expect(blogPosting.author).toEqual({ "@type": "Person", name: "Guest Contributor" });
  });

  it("still attaches sameAs when the byline is unset (defaults to the linked profile's own name)", () => {
    const seo = resolvePostSeo(
      basePost({
        author_name: "",
        author: { name: "Jane Doe", slug: "jane", job_title: null, bio: null, avatar_url: null, same_as: ["https://x.com/jane"] },
      }),
      SITE,
      ORG
    );
    const blogPosting = seo.json_ld[0] as { author: { name: string; sameAs?: string[] } };
    expect(blogPosting.author).toEqual({ "@type": "Person", name: "Jane Doe", sameAs: ["https://x.com/jane"] });
  });

  it("falls back to the Organization as author when the post has no byline", () => {
    const seo = resolvePostSeo(basePost({ author_name: "" }), SITE, ORG);
    const blogPosting = seo.json_ld[0] as { author: { "@type": string; name: string } };
    expect(blogPosting.author).toEqual({ "@type": "Organization", name: "Example Inc" });
  });

  it("dateModified uses content_updated_at, never the plain updated_at it stands in for", () => {
    const seo = resolvePostSeo(basePost(), SITE, ORG);
    const blogPosting = seo.json_ld[0] as { dateModified: string };
    expect(blogPosting.dateModified).toBe("2026-02-01T00:00:00.000Z");
  });

  it("falls back dateModified to updated_at only when content_updated_at is unset", () => {
    const seo = resolvePostSeo(basePost({ content_updated_at: null }), SITE, ORG);
    const blogPosting = seo.json_ld[0] as { dateModified: string };
    expect(blogPosting.dateModified).toBe("2026-03-01T00:00:00.000Z");
  });

  it("ships a two-level BreadcrumbList (site, post) with no guessed category rung", () => {
    const seo = resolvePostSeo(basePost({ category: { name: "Engineering" } }), SITE, ORG);
    const breadcrumbs = seo.json_ld[1] as { itemListElement: unknown[] };
    expect(breadcrumbs.itemListElement).toHaveLength(2);
  });

  it("includes articleSection from the category without adding a breadcrumb rung for it", () => {
    const seo = resolvePostSeo(basePost({ category: { name: "Engineering" } }), SITE, ORG);
    const blogPosting = seo.json_ld[0] as { articleSection?: string };
    expect(blogPosting.articleSection).toBe("Engineering");
  });

  it("ships no FAQPage node when the body has no visible FAQ section", () => {
    const seo = resolvePostSeo(basePost(), SITE, ORG);
    expect(seo.json_ld).toHaveLength(2);
    expect(seo.json_ld.some((n) => n["@type"] === "FAQPage")).toBe(false);
  });

  it("ships an FAQPage node built from a visible FAQ section", () => {
    const seo = resolvePostSeo(
      basePost({
        content_html:
          "<p>Body.</p><h2>FAQ</h2><h3>Is it free?</h3><p>Yes, for the free tier.</p><h3>Does it scale?</h3><p>Yes.</p>",
      }),
      SITE,
      ORG
    );
    expect(seo.json_ld).toHaveLength(3);
    const faq = seo.json_ld[2] as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    expect(faq.mainEntity).toEqual([
      { "@type": "Question", name: "Is it free?", acceptedAnswer: { "@type": "Answer", text: "Yes, for the free tier." } },
      { "@type": "Question", name: "Does it scale?", acceptedAnswer: { "@type": "Answer", text: "Yes." } },
    ]);
  });

  it("uses the site's publisher_name and the org's logo/same_as as fallbacks", () => {
    const site: SeoSite = { url: "https://example.com", name: "Example Blog", publisher_name: "Example Media", logo_url: null };
    const org: SeoOrganization = { name: "Example Inc", logo: "https://example.com/logo.png", same_as: ["https://x.com/example"] };
    const seo = resolvePostSeo(basePost(), site, org);
    const blogPosting = seo.json_ld[0] as {
      publisher: { name: string; sameAs?: string[]; logo?: { url: string } };
    };
    expect(blogPosting.publisher.name).toBe("Example Media");
    expect(blogPosting.publisher.sameAs).toEqual(["https://x.com/example"]);
    expect(blogPosting.publisher.logo?.url).toBe("https://example.com/logo.png");
  });
});

describe("extractFaqSection", () => {
  it("returns no entries when there is no FAQ heading", () => {
    expect(extractFaqSection("<p>Just a regular post.</p>")).toEqual([]);
  });

  it("returns no entries for null content", () => {
    expect(extractFaqSection(null)).toEqual([]);
  });

  it("stops at the next H2, not reading past the end of the FAQ section", () => {
    const html =
      "<h2>FAQ</h2><h3>Q1</h3><p>A1</p><h2>Pricing</h2><h3>Not a question</h3><p>Not an answer</p>";
    expect(extractFaqSection(html)).toEqual([{ question: "Q1", answer: "A1" }]);
  });

  it("matches Frequently Asked Questions case-insensitively as an H3 too", () => {
    const html = "<h3>frequently asked questions</h3><h4>Q?</h4><p>A.</p>";
    expect(extractFaqSection(html)).toEqual([{ question: "Q?", answer: "A." }]);
  });

  it("stops an H3-level FAQ section at the next H3, not only the next H2", () => {
    // An H2 boundary alone would sweep "Pricing"'s own H4 sub-heading in as a
    // spurious FAQ answer, since nothing but an H2 would have stopped it.
    const html =
      "<h3>FAQ</h3><h4>Is it free?</h4><p>Yes.</p><h3>Pricing</h3><h4>How much?</h4><p>$10/mo</p><h2>Conclusion</h2>";
    expect(extractFaqSection(html)).toEqual([{ question: "Is it free?", answer: "Yes." }]);
  });

  it("never matches a heading whose opening and closing tag levels disagree", () => {
    expect(extractFaqSection("<h2>FAQ</h3><h3>Q?</h3><p>A.</p>")).toEqual([]);
  });

  it("strips inner HTML from both question and answer", () => {
    const html = "<h2>FAQ</h2><h3>Is <em>it</em> free?</h3><p>Yes, <strong>totally</strong>.</p>";
    expect(extractFaqSection(html)).toEqual([{ question: "Is it free?", answer: "Yes, totally." }]);
  });

  it("skips a heading whose question or answer is blank", () => {
    const html = "<h2>FAQ</h2><h3></h3><p>Orphan answer</p><h3>Real question?</h3><p>Real answer.</p>";
    expect(extractFaqSection(html)).toEqual([{ question: "Real question?", answer: "Real answer." }]);
  });
});
