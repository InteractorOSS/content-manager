import { stripHtml } from "@/lib/utils";
import { findHumanizerTells } from "@/lib/humanizer/tells";

/**
 * Search & AI readiness (G#32, SEO-AEO-GEO-PLAN.md Layer B): one pure check
 * every surface calls — the editor panel, the MCP `check_post_seo` tool, the
 * standalone `POST /api/cms/posts/[id]/seo-check` route, and the publish/
 * approve workflow gate (src/app/api/cms/posts/[id]/workflow/route.ts).
 * Errors block publish; warnings are advisory only (the `humanizer_*` ones
 * included: a person may write any of those patterns on purpose). Existing published posts
 * are never retro-blocked — this function is always available to CALL, but
 * only the publish/approve gate treats its errors as a refusal, and only for
 * a transition happening now.
 */
export interface ReadinessFinding {
  key: string;
  message: string;
}

export interface ReadinessResult {
  errors: ReadinessFinding[];
  warnings: ReadinessFinding[];
}

export interface ReadinessInput {
  title: string;
  seo_title: string | null;
  slug: string;
  meta_description: string | null;
  content_html: string | null;
  answer_summary: string | null;
  featured_image: string | null;
  featured_image_alt: string | null;
  excerpt?: string | null;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 75;
const META_DESCRIPTION_MIN = 70;
const META_DESCRIPTION_MAX = 160;
const TITLE_MIN = 20;
const TITLE_MAX = 60;
const ANSWER_SUMMARY_MIN_WORDS = 25;
const ANSWER_SUMMARY_MAX_WORDS = 80;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[^>]*>/gi)].map((m) => Number(m[1]));
}

/** Every `<img>` tag's `alt` attribute, in document order — `null` when the attribute is absent or empty. */
function imageAlts(html: string): (string | null)[] {
  return [...html.matchAll(/<img\b[^>]*>/gi)].map((tag) => {
    const alt = /\balt\s*=\s*"([^"]*)"|alt\s*=\s*'([^']*)'/i.exec(tag[0]);
    const value = alt?.[1] ?? alt?.[2] ?? null;
    return value?.trim() ? value : null;
  });
}

function errors(input: ReadinessInput): ReadinessFinding[] {
  const out: ReadinessFinding[] = [];
  const html = input.content_html ?? "";
  const effectiveTitle = input.seo_title?.trim() || input.title;
  const description = input.meta_description?.trim() ?? "";

  if (description.length < META_DESCRIPTION_MIN || description.length > META_DESCRIPTION_MAX) {
    out.push({
      key: "meta_description_length",
      message: `Meta description should be ${META_DESCRIPTION_MIN}-${META_DESCRIPTION_MAX} characters (currently ${description.length}).`,
    });
  }
  if (effectiveTitle.length < TITLE_MIN || effectiveTitle.length > TITLE_MAX) {
    out.push({
      key: "title_length",
      message: `Title should be ${TITLE_MIN}-${TITLE_MAX} characters (currently ${effectiveTitle.length}); set seo_title to override without renaming the page.`,
    });
  }
  const slug = input.slug.trim();
  if (!SLUG_RE.test(slug) || slug.length > SLUG_MAX_LENGTH) {
    out.push({
      key: "slug_format",
      message: `Slug must be lowercase words separated by '-', at most ${SLUG_MAX_LENGTH} characters.`,
    });
  }
  if (/<h1\b/i.test(html)) {
    out.push({ key: "h1_in_body", message: "Body must not contain its own <h1> — the page's own heading is the H1." });
  }
  const missingAlt = imageAlts(html).filter((alt) => alt === null).length;
  if (missingAlt > 0) {
    out.push({ key: "image_alt_missing", message: `${missingAlt} image(s) in the body have no alt text.` });
  }
  if (input.featured_image && !input.featured_image_alt?.trim()) {
    out.push({ key: "featured_image_alt_missing", message: "Featured image has no alt text." });
  }
  const summaryWords = input.answer_summary ? wordCount(input.answer_summary) : 0;
  if (!input.answer_summary?.trim() || summaryWords < ANSWER_SUMMARY_MIN_WORDS || summaryWords > ANSWER_SUMMARY_MAX_WORDS) {
    out.push({
      key: "answer_summary_length",
      message: `Answer summary should be ${ANSWER_SUMMARY_MIN_WORDS}-${ANSWER_SUMMARY_MAX_WORDS} words (currently ${summaryWords}).`,
    });
  }
  const levels = headingLevels(html);
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      out.push({ key: "heading_level_skip", message: `Heading levels skip from H${levels[i - 1]} to H${levels[i]}.` });
      break;
    }
  }
  return out;
}

const QUESTION_HEADING = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
const INTERNAL_LINK = /<a\b[^>]*href\s*=\s*["']\/(?!\/)[^"']*["']/gi;
const EXTERNAL_LINK = /<a\b[^>]*href\s*=\s*["']https?:\/\/[^"']*["']/gi;
/**
 * A number with unit-like or percent context — the loose "statistic" signal,
 * not a citation checker. Split into two alternatives rather than one
 * `(?:%|word)\b`: a trailing `\b` right after `%` can never match (`%` and a
 * following space are both non-word characters, so there is no word
 * boundary between them) — the word-suffix alternatives keep their `\b` to
 * avoid a short token like `x` or `k` matching inside an unrelated word.
 */
const STATISTIC = /\b\d+(?:[.,]\d+)?%|\b\d+(?:[.,]\d+)?\s?(?:percent|x|times|k|million|billion|users|customers|ms|seconds?|minutes?|hours?|days?)\b/i;
const DEFINITIONAL_SENTENCE = /^[A-Z][\w\s-]{0,40}\bis\s(?:a|an|the)\b/;

function warnings(input: ReadinessInput): ReadinessFinding[] {
  const out: ReadinessFinding[] = [];
  const html = input.content_html ?? "";
  const text = stripHtml(html);
  const effectiveTitle = input.seo_title?.trim() || input.title;
  const description = input.meta_description?.trim() ?? "";

  const questionHeadings = [...html.matchAll(QUESTION_HEADING)].filter((m) => stripHtml(m[1]).trim().endsWith("?"));
  if (questionHeadings.length === 0) {
    out.push({ key: "no_question_heading", message: "No H2 is phrased as a question — AI answer engines favor question-shaped headings." });
  }
  const internalLinks = [...html.matchAll(INTERNAL_LINK)].length;
  if (internalLinks < 2) {
    out.push({ key: "few_internal_links", message: `Only ${internalLinks} internal link(s) — aim for at least 2.` });
  }
  const externalLinks = [...html.matchAll(EXTERNAL_LINK)].length;
  if (externalLinks === 0) {
    out.push({ key: "no_outbound_source", message: "No outbound link to a primary source." });
  }
  if (!STATISTIC.test(text)) {
    out.push({ key: "no_statistic", message: "No statistic or number with context found — cited data raises AI-answer visibility." });
  }
  const firstSentence = text.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  if (!DEFINITIONAL_SENTENCE.test(firstSentence)) {
    out.push({ key: "no_definitional_sentence", message: "Opening doesn't read as a definitional sentence (\"X is a/an/the …\")." });
  }
  if (description && effectiveTitle && description.toLowerCase().startsWith(effectiveTitle.toLowerCase())) {
    out.push({ key: "title_meta_duplicate", message: "Meta description starts with the title verbatim — write it as a distinct sentence." });
  }
  // Humanizer: the AI-writing patterns text matching can find (the rest is
  // the model review the async callers add, src/lib/humanizer/review.ts).
  out.push(...findHumanizerTells(input));
  return out;
}

/**
 * Content-only checks — no database access, so no duplicate-title-in-org
 * check here (that needs a query; see `checkDuplicateTitleInOrg` below,
 * composed in by the async callers that have a `db`).
 */
export function checkPostReadiness(input: ReadinessInput): ReadinessResult {
  return { errors: errors(input), warnings: warnings(input) };
}

interface DuplicateTitleDb {
  post: {
    findFirst(args: {
      where: { id: { not: string }; title: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

/** The one check that needs the database — a title byte-identical to another post's in the same org. */
export async function checkDuplicateTitleInOrg(
  db: DuplicateTitleDb,
  postId: string,
  title: string
): Promise<ReadinessFinding | null> {
  const dupe = await db.post.findFirst({ where: { id: { not: postId }, title }, select: { id: true } });
  return dupe ? { key: "duplicate_title", message: "Another post in this organization has the exact same title." } : null;
}
