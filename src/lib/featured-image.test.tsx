import { describe, expect, it } from "vitest";
import { imageSize } from "image-size";
import {
  PALETTES,
  clampTitle,
  featuredImageAlt,
  pickPalette,
  renderFeaturedImagePng,
  titleFontSize,
} from "./featured-image";

describe("featured image card", () => {
  it("picks a stable palette per seed", () => {
    expect(pickPalette("seo-aeo-geo-every-post")).toBe(pickPalette("seo-aeo-geo-every-post"));
    const seen = new Set(Array.from({ length: 40 }, (_, i) => pickPalette(`post-${i}`)));
    expect(seen.size).toBeGreaterThan(1);
    expect(PALETTES).toContain(pickPalette(""));
  });

  it("shrinks the font as the title grows", () => {
    expect(titleFontSize("Short")).toBeGreaterThan(titleFontSize("x".repeat(90)));
    expect(titleFontSize("x".repeat(200))).toBe(44);
  });

  it("clamps runaway titles and describes the card in the alt text", () => {
    expect(clampTitle("a ".repeat(200)).length).toBeLessThanOrEqual(140);
    expect(featuredImageAlt("Hello")).toBe('Title card reading "Hello"');
  });

  it("renders a 1200x630 PNG without any network call", async () => {
    const png = await renderFeaturedImagePng({
      title: "SEO, AEO & GEO: Optimizing Every Post for Search and AI",
      seed: "seo-aeo-geo-every-post",
      brand: "Interactor",
      category: "Technology",
      author: "Peter Jung",
    });
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(imageSize(png)).toMatchObject({ width: 1200, height: 630 });
  }, 20000);
});
