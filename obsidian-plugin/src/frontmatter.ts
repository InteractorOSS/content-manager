import matter from "gray-matter";

// Mirrors src/lib/post-frontmatter.ts's parse/serialize shape (a separate
// npm package, so duplicated rather than shared — same gray-matter format,
// no logic drift beyond what the two frontmatter contracts intentionally share).

export interface PostFrontmatter {
  id?: string;
  content_hash?: string;
  title: string;
  slug?: string;
  status?: string;
  type?: string;
  excerpt?: string;
  category?: string;
  tags?: string[];
  platforms?: string[];
  featured_image?: string;
  featured_image_alt?: string;
  meta_description?: string;
  meta_keywords?: string;
  content_format?: string;
  published_at?: string;
}

export interface ParsedPostFile {
  frontmatter: PostFrontmatter;
  body: string;
}

export function parsePostFile(raw: string): ParsedPostFile {
  const { data, content } = matter(raw);
  return { frontmatter: data as PostFrontmatter, body: content.trim() };
}

/** Server post shape (from /api/cms/posts/import's response `data`). */
export interface ServerPost {
  id: string;
  content_hash: string | null;
  title: string;
  slug: string;
  status: string;
  type: string;
  content_format: string;
  excerpt: string | null;
  category: { slug: string } | null;
  tags: string[];
  platforms: string[];
  featured_image: string | null;
  featured_image_alt: string | null;
  meta_description: string | null;
  meta_keywords: string | null;
  published_at: string | null;
  content: string | null;
}

/** Write the server's response back into `.md` file text — same shape the
 * CLI and the CMS's own export endpoint produce, so the file is
 * self-describing after its first sync (D3). */
export function serializePostFile(post: ServerPost): string {
  const frontmatter: Record<string, unknown> = {
    id: post.id,
    ...(post.content_hash && { content_hash: post.content_hash }),
    title: post.title,
    slug: post.slug,
    status: post.status,
    type: post.type,
    content_format: post.content_format,
  };
  if (post.excerpt) frontmatter.excerpt = post.excerpt;
  if (post.category) frontmatter.category = post.category.slug;
  if (post.tags.length > 0) frontmatter.tags = post.tags;
  if (post.platforms.length > 0) frontmatter.platforms = post.platforms;
  if (post.featured_image) frontmatter.featured_image = post.featured_image;
  if (post.featured_image_alt) frontmatter.featured_image_alt = post.featured_image_alt;
  if (post.meta_description) frontmatter.meta_description = post.meta_description;
  if (post.meta_keywords) frontmatter.meta_keywords = post.meta_keywords;
  if (post.published_at) frontmatter.published_at = post.published_at;

  return matter.stringify(post.content ?? "", frontmatter);
}
