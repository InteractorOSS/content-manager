import { ImageResponse } from "next/og";
import type { TenantDb } from "@/lib/tenant-db";
import type { Actor } from "@/lib/rbac";
import { storeMediaFile } from "@/lib/media-storage";

/**
 * Generated featured images — a typographic title card rendered on this
 * server with next/og (Satori + resvg, bundled with Next). No image model, no
 * third-party API, no per-image cost: the same inputs always produce the same
 * card, and rendering takes a few hundred milliseconds.
 *
 * 1200×630 is the Open Graph / Twitter `summary_large_image` size and is
 * comfortably above Google's 50K-pixel floor for Article images, so the card is
 * usable as the post's hero, social preview and structured-data image at once.
 */

export const FEATURED_IMAGE_WIDTH = 1200;
export const FEATURED_IMAGE_HEIGHT = 630;

export interface CardPalette {
  from: string;
  to: string;
  accent: string;
}

// Dark, high-contrast gradients: white text on every one of these clears
// WCAG AA large-text contrast at both ends of the gradient.
export const PALETTES: readonly CardPalette[] = [
  { from: "#0f172a", to: "#1e3a8a", accent: "#60a5fa" },
  { from: "#052e16", to: "#166534", accent: "#4ade80" },
  { from: "#2e1065", to: "#6d28d9", accent: "#c4b5fd" },
  { from: "#431407", to: "#9a3412", accent: "#fdba74" },
  { from: "#083344", to: "#0e7490", accent: "#67e8f9" },
  { from: "#3f0d25", to: "#9d174d", accent: "#f9a8d4" },
  { from: "#1c1917", to: "#44403c", accent: "#fcd34d" },
];

/** Stable palette per post: the same slug always gets the same colours. */
export function pickPalette(seed: string): CardPalette {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTES[h % PALETTES.length];
}

/** Shrink long titles so they stay within the card (≈ 4 lines max). */
export function titleFontSize(title: string): number {
  const n = title.trim().length;
  if (n <= 40) return 76;
  if (n <= 70) return 64;
  if (n <= 100) return 54;
  return 44;
}

/** Keep a runaway title from overflowing the card entirely. */
export function clampTitle(title: string, max = 140): string {
  const t = title.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function featuredImageAlt(title: string): string {
  return `Title card reading "${clampTitle(title)}"`;
}

export interface CardInput {
  title: string;
  /** Seeds the palette — the post slug, so a retitle keeps its colours. */
  seed: string;
  /** Small label top-left: the organization / publication name. */
  brand?: string | null;
  category?: string | null;
  author?: string | null;
}

function Card({ title, seed, brand, category, author }: CardInput) {
  const palette = pickPalette(seed);
  const text = clampTitle(title);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        backgroundImage: `linear-gradient(135deg, ${palette.from} 0%, ${palette.to} 100%)`,
        color: "#ffffff",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: palette.accent }} />
        <div style={{ fontSize: 30, fontWeight: 600, opacity: 0.92 }}>{brand || "Blog"}</div>
        {category ? (
          <div
            style={{
              display: "flex",
              marginLeft: 12,
              padding: "6px 18px",
              borderRadius: 999,
              border: `2px solid ${palette.accent}`,
              color: palette.accent,
              fontSize: 24,
              fontWeight: 600,
            }}
          >
            {category}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          fontSize: titleFontSize(text),
          fontWeight: 700,
          lineHeight: 1.12,
          letterSpacing: -1,
          maxWidth: 1040,
        }}
      >
        {text}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ width: 64, height: 6, borderRadius: 3, backgroundColor: palette.accent }} />
        <div style={{ fontSize: 28, opacity: 0.85 }}>{author || ""}</div>
      </div>
    </div>
  );
}

/** Render the title card to PNG bytes. */
export async function renderFeaturedImagePng(input: CardInput): Promise<Buffer> {
  const res = new ImageResponse(<Card {...input} />, {
    width: FEATURED_IMAGE_WIDTH,
    height: FEATURED_IMAGE_HEIGHT,
  });
  return Buffer.from(await res.arrayBuffer());
}

export interface GeneratedFeaturedImage {
  url: string;
  alt: string;
  media_id: string;
}

/**
 * Render, store (S3 in production) and register the card as a Media row in
 * the actor's org, so it shows up in the media library like any upload.
 */
export async function generateFeaturedImage(
  db: TenantDb,
  actor: Actor,
  post: { title: string; slug: string; category_id?: string | null; author_name?: string | null }
): Promise<GeneratedFeaturedImage> {
  const category = post.category_id
    ? await db.category.findUnique({ where: { id: post.category_id }, select: { name: true } })
    : null;
  const brand = actor.organizations.find((o) => o.id === actor.organizationId)?.name ?? null;

  const png = await renderFeaturedImagePng({
    title: post.title || post.slug,
    seed: post.slug || post.title,
    brand,
    category: category?.name ?? null,
    author: post.author_name ?? null,
  });

  const safeSlug = (post.slug || "post").replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 60);
  const filename = `${Date.now()}-${safeSlug}-featured.png`;
  const filePath = await storeMediaFile(png, filename, "image/png");
  const alt = featuredImageAlt(post.title || post.slug);

  const media = await db.media.create({
    data: {
      filename,
      original_filename: `${safeSlug}-featured.png`,
      file_path: filePath,
      file_size: png.length,
      mime_type: "image/png",
      alt_text: alt,
      caption: "Generated title card",
      width: FEATURED_IMAGE_WIDTH,
      height: FEATURED_IMAGE_HEIGHT,
      uploaded_by: actor.user.id,
    },
  });

  return { url: filePath, alt, media_id: media.id };
}

/**
 * The publish gates' fallback: a post that is about to become published with
 * no featured image gets a generated one instead of a refusal. Returns null
 * when generation fails (e.g. storage is down) so the caller can fall back to
 * its original "an image is required" refusal rather than publishing blank.
 */
export async function generateFeaturedImageOrNull(
  ...args: Parameters<typeof generateFeaturedImage>
): Promise<GeneratedFeaturedImage | null> {
  try {
    return await generateFeaturedImage(...args);
  } catch (err) {
    console.error("[featured-image] generation failed", err);
    return null;
  }
}
