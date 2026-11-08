import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getAnthropic, AI_MODEL } from "@/lib/ai/client";
import { humanizerGenerationBlock } from "@/lib/humanizer";
import { htmlToText } from "@/lib/ai/extract";
import type { SocialPart } from "@/lib/social/parts";

// Blog generation + draft polishing (CONTENT-AI-PLAN.md §5, Phase B).

export const BlogDraftSchema = z.object({
  title: z.string(),
  excerpt: z.string(),
  content_html: z.string(),
  meta_description: z.string(),
  meta_keywords: z.string(),
  tags: z.array(z.string()),
});
export type BlogDraft = z.infer<typeof BlogDraftSchema>;

/**
 * Decision #1 in the plan: brand guide layers under the personal guide;
 * the personal guide wins on conflict. Humanizer (src/lib/humanizer) comes
 * last, as the final pass over everything the model writes.
 */
export function buildStyleSystem(
  brandGuide: string | null,
  personalGuide: string | null
): string {
  const parts = [
    `You are the writing engine of a CMS. You produce publication-ready blog content as clean HTML (p, h2, h3, ul/ol/li, strong, em, a, blockquote — no scripts, no styles, no title/h1 inside the body).`,
  ];
  if (brandGuide) {
    parts.push(`Follow this organization brand voice guide:\n<brand_guide>\n${brandGuide}\n</brand_guide>`);
  }
  if (personalGuide) {
    parts.push(
      `Follow this author style guide. Where it conflicts with the brand guide, THE AUTHOR GUIDE WINS:\n<author_guide>\n${personalGuide}\n</author_guide>`
    );
  }
  if (!brandGuide && !personalGuide) {
    parts.push(`No style guide is configured; write in a clear, direct, professional voice.`);
  }
  parts.push(humanizerGenerationBlock());
  return parts.join("\n\n");
}

export interface GenerateUsage {
  inputTokens: number;
  outputTokens: number;
}

// Phase C: per-network social copy (CONTENT-AI-PLAN.md §5). One generation per
// format so the style-guide system prompt stays byte-identical across calls
// and each additional format is mostly a prompt-cache read.

export const SOCIAL_FORMATS = ["linkedin", "twitter", "facebook"] as const;
export type SocialFormat = (typeof SOCIAL_FORMATS)[number];

export function isSocialFormat(value: string): value is SocialFormat {
  return (SOCIAL_FORMATS as readonly string[]).includes(value);
}

const SocialBodySchema = z.object({ body: z.string() });
const TweetThreadSchema = z.object({ tweets: z.array(z.string()) });

/** Per-format brief: length limits mirror src/lib/social/capabilities.ts. */
const FORMAT_BRIEFS: Record<SocialFormat, string> = {
  linkedin:
    "Write a LinkedIn post (max 2800 characters). Professional but personal; a strong first line (it's the preview), short paragraphs or a tight list, a clear takeaway, and end with a light call to action. No hashtag walls — at most 3 relevant hashtags.",
  twitter:
    "Write an X (Twitter) thread of 1-4 tweets, each STRICTLY under 260 characters. The first tweet must hook on its own; each tweet must stand alone without numbering like '1/'. Prefer a single tweet when the idea fits.",
  facebook:
    "Write a Facebook Page post (max 1500 characters). Conversational and concrete, first sentence carries the hook, short paragraphs, end with a question or call to action.",
};

/**
 * Generate copy for one social network from source material. An X thread
 * comes back as its first tweet (`body`) and the rest as thread `parts`
 * (src/lib/social/parts.ts), which the publisher posts as a reply chain. It
 * used to be one body with "\n---\n" between the tweets, which went out as a
 * single tweet over X's limit.
 */
export async function generateSocialCopy(
  styleSystem: string,
  format: SocialFormat,
  sourceText: string,
  instructions?: string | null
): Promise<{ body: string; parts: SocialPart[]; usage: GenerateUsage }> {
  const client = getAnthropic();

  const prompt = `${FORMAT_BRIEFS[format]}

The post promotes the article below — pull out its single most compelling idea rather than summarizing everything. Write plain text (no markdown syntax). Do not invent facts, statistics, or quotes. Do not include any URL; the link is attached separately by the publishing tool.${instructions ? `\n\nAdditional instructions from the author: ${instructions}` : ""}

<article>
${sourceText.slice(0, 60_000)}
</article>`;

  const schema = format === "twitter" ? TweetThreadSchema : SocialBodySchema;
  const response = await client.messages.parse({
    model: AI_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: styleSystem,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: zodOutputFormat(schema) },
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`The model declined to write the ${format} post`);
  }
  const parsed = response.parsed_output as
    | z.infer<typeof SocialBodySchema>
    | z.infer<typeof TweetThreadSchema>
    | null;
  if (!parsed) {
    throw new Error(`${format} generation returned an unparseable result`);
  }

  const [body = "", ...rest] =
    "tweets" in parsed ? parsed.tweets.map((t) => t.trim()).filter(Boolean) : [parsed.body.trim()];
  if (!body) throw new Error(`${format} generation returned empty copy`);

  return {
    body,
    parts: rest.map((tweet) => ({ kind: "thread" as const, body: tweet })),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

/** Write a blog post from source material (article text, notes, or a rough draft). */
export async function generateBlogDraft(
  styleSystem: string,
  sourceText: string,
  instructions?: string | null
): Promise<{ draft: BlogDraft; usage: GenerateUsage }> {
  const client = getAnthropic();

  const response = await client.messages.parse({
    model: AI_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: styleSystem,
    messages: [
      {
        role: "user",
        content: `Write a blog post in the configured voice, based on this source material. Rework it fully — structure, framing, and prose are yours; facts and claims must come from the source. Do not fabricate statistics or quotes.${instructions ? `\n\nAdditional instructions from the author: ${instructions}` : ""}\n\n<source_material>\n${sourceText.slice(0, 80_000)}\n</source_material>`,
      },
    ],
    output_config: {
      format: zodOutputFormat(BlogDraftSchema),
    },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to generate from this content");
  }
  if (!response.parsed_output) {
    throw new Error("Generation returned an unparseable result");
  }

  return {
    draft: response.parsed_output,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

// LLM SEO assist (G#35, SEO-AEO-GEO-PLAN.md Layer E): drafts the readiness-
// check fields (src/lib/seo-readiness.ts) plus editorial suggestions that are
// NEVER auto-applied — the editor surfaces every field here for a human to
// accept, edit or reject (see the "Suggestions" panel in post-editor.tsx and
// the generate-seo route's heuristic fallback when AI isn't configured).
export const SeoAssistSchema = z.object({
  seo_title: z.string().describe('20-60 characters; the effective <title> override'),
  meta_description: z.string().describe("70-160 characters, a distinct sentence from the title"),
  excerpt: z.string().describe("1-2 sentence teaser, distinct from meta_description"),
  meta_keywords: z.string().describe("5-8 comma-separated keywords/phrases"),
  answer_summary: z
    .string()
    .describe("25-80 words, a single self-contained paragraph directly answering the question the title asks"),
  featured_image_alt: z.string().describe("Descriptive alt text for the featured image, based on the post's subject"),
  question_headings: z
    .array(z.string())
    .describe(
      "1-4 heading suggestions phrased as reader questions — a rewrite of an existing H2 that isn't yet a question, or a new section the post is missing. Heading text only, no HTML/markdown."
    ),
  citations_needed: z
    .array(z.string())
    .describe(
      "Up to 5 short excerpts (verbatim from the body, <=20 words) that state a fact, statistic or claim with no nearby source link. Empty when every claim is already sourced."
    ),
  faq: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .describe(
      "0-4 question/answer pairs for genuine reader questions the body doesn't already answer as its own section. Answers must come strictly from the given content. Empty when the post doesn't need one."
    ),
});
export type SeoAssist = z.infer<typeof SeoAssistSchema>;

const SEO_ASSIST_SYSTEM =
  "You are the SEO/AEO/GEO assistant of a CMS. You produce structured metadata and editorial " +
  "suggestions ONLY — you never rewrite or return the post body. Every field must be grounded " +
  "strictly in the given title and content: never invent a statistic, quote, fact, or source. " +
  "When the content doesn't support a field (e.g. no ungrounded claims, no real FAQ need), " +
  "return an empty array rather than fabricating one.";

/**
 * Draft SEO/AEO metadata and editorial suggestions for a post (G#35). Pure
 * suggestion generation: the caller decides what — if anything — to apply.
 */
export async function generateSeoAssist(
  title: string,
  contentHtml: string
): Promise<{ assist: SeoAssist; usage: GenerateUsage }> {
  const client = getAnthropic();
  const text = htmlToText(contentHtml);

  const prompt = `Draft SEO/AEO metadata and editorial suggestions for this post. Base every field strictly on the title and content below.

Field requirements (these mirror an automated readiness check the post must pass before it can be submitted or published):
- seo_title: 20-60 characters. Echo the title if it already fits; otherwise a tighter, more specific alternative.
- meta_description: 70-160 characters, written as its own sentence — never start with the title verbatim.
- excerpt: a 1-2 sentence teaser distinct from meta_description.
- meta_keywords: 5-8 comma-separated keywords or phrases this post is actually about.
- answer_summary: 25-80 words, one self-contained paragraph that directly answers the question the title asks — this becomes a visible TL;DR block.
- featured_image_alt: descriptive alt text for the featured image, based on the post's actual subject.
- question_headings: 1-4 question-phrased heading suggestions (rewrites of existing non-question H2s, or new sections that are missing).
- citations_needed: verbatim excerpts (<=20 words each, at most 5) that make a claim with no source nearby. Empty if none.
- faq: 0-4 genuine Q&A pairs the body doesn't already cover as its own section, answerable strictly from the content. Empty if the post doesn't need one.

Title: ${title}

<content>
${text.slice(0, 40_000)}
</content>`;

  const response = await client.messages.parse({
    model: AI_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: SEO_ASSIST_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: zodOutputFormat(SeoAssistSchema) },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to draft SEO suggestions for this content");
  }
  if (!response.parsed_output) {
    throw new Error("SEO assist returned an unparseable result");
  }

  return {
    assist: response.parsed_output,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

/** Polish an existing draft: keep its substance and structure, fix the prose. */
export async function polishDraft(
  styleSystem: string,
  post: { title: string; content_html: string; excerpt: string | null },
  instructions?: string | null
): Promise<{ draft: BlogDraft; usage: GenerateUsage }> {
  const client = getAnthropic();

  const response = await client.messages.parse({
    model: AI_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: styleSystem,
    messages: [
      {
        role: "user",
        content: `Finalize this draft in the configured voice. PRESERVE the author's substance, argument order, and any facts, numbers, links, images, and embeds exactly. Improve clarity, rhythm, word choice, transitions, and the opening/closing. Fill in excerpt and SEO fields. If the existing title is strong, keep it.${instructions ? `\n\nAdditional instructions from the author: ${instructions}` : ""}\n\n<draft_title>${post.title}</draft_title>\n<draft_excerpt>${post.excerpt ?? ""}</draft_excerpt>\n<draft_html>\n${post.content_html.slice(0, 80_000)}\n</draft_html>`,
      },
    ],
    output_config: {
      format: zodOutputFormat(BlogDraftSchema),
    },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to polish this content");
  }
  if (!response.parsed_output) {
    throw new Error("Polish returned an unparseable result");
  }

  return {
    draft: response.parsed_output,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
