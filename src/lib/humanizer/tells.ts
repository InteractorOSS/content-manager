/**
 * Rule-based Humanizer check: the AI-writing patterns plain text matching can
 * find. It runs inside the readiness check (src/lib/seo-readiness.ts), so the
 * editor panel, `check_post_seo` and the REST route all report it, for free,
 * whichever client wrote the post.
 *
 * Findings are WARNINGS and never block a transition. The server can't tell
 * who wrote a passage, and a person may use any of these on purpose, so the
 * thresholds follow the skill: a strong pattern is reported on one sighting, a
 * "weak alone" one (dashes, stock words) only in numbers. Quotations and code
 * are left out, as the skill says.
 *
 * These rules are ours, not generated: when upstream renames or renumbers a
 * pattern, update the labels here. The patterns no regex can see (triads,
 * inflated significance, a closer that repeats its paragraph) are the model
 * review's job, src/lib/humanizer/review.ts, which reads the vendored skill
 * itself and so follows upstream without an edit.
 */

export interface HumanizerTell {
  key: string;
  message: string;
}

export interface HumanizerTellInput {
  title?: string | null;
  excerpt?: string | null;
  meta_description?: string | null;
  answer_summary?: string | null;
  content_html?: string | null;
}

const ENTITIES: Record<string, string> = {
  "&mdash;": "—",
  "&ndash;": "–",
  "&#8212;": "—",
  "&#8211;": "–",
  "&nbsp;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&rsquo;": "’",
  "&lsquo;": "‘",
};

/** Body prose only: code and quotations are exempt, and tags become breaks. */
export function proseOf(html: string): string {
  return html
    .replace(/<(pre|code|blockquote)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|li|h[1-6]|div|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)
    .replace(/[ \t]+/g, " ");
}

const quote = (s: string) => `"${s.trim().replace(/\s+/g, " ").slice(0, 90)}"`;

const NOT_X_BUT_Y = [
  /\bnot (?:just|only|merely|simply)\b[^.?!\n]{0,120}?\b(?:but|it'?s|it is|they'?re)\b[^.?!\n]{0,60}/i,
  /\b(?:it|this|that)(?:['’]s| is) not (?:about )?[^.?!\n,;]{1,80}[,;.] (?:it|this|that)(?:['’]s| is)\b[^.?!\n]{0,60}/i,
  /\b(?:this|that|it) (?:does not|doesn['’]t) mean\b[^.?!\n]{1,100}\. (?:it|this|that) means\b[^.?!\n]{0,60}/i,
  /\b(?:isn['’]t|aren['’]t|wasn['’]t) (?:just|only|merely|simply) [^.?!\n]{1,80}[,;.] ?(?:it['’]s|it is|they['’]re|but)\b[^.?!\n]{0,60}/i,
];

const CLOSERS =
  /\b(?:that(?:['’]s| is) the real (?:win|point|story|lesson|shift)|that distinction matters|read that again|let that sink in)\b[.!]?/gi;

// §12, minus the words with a common literal sense in technical writing
// (key, gate, robust, valuable, enhance, highlight, actually, quietly).
const AI_WORDS = [
  "additionally", "align with", "aligns with", "bolstered", "crucial", "deep dive", "delve", "delves", "delving",
  "enduring", "garner", "garnered", "interplay", "intricate", "intricacies", "landscape", "meticulous",
  "meticulously", "pivotal", "showcase", "showcases", "showcasing", "tapestry", "testament", "underscore",
  "underscores", "underscored", "vibrant",
];
const AI_WORD_RE = new RegExp(`\\b(?:${AI_WORDS.join("|")})\\b`, "gi");
const AI_WORDS_MIN = 3;

const CHATBOT_RESIDUE =
  /\b(?:I hope this helps|great question|you(?:['’]re| are) absolutely right|would you like me to|want me to [^.?!\n]{1,60}\?|should I continue|let me know if you)\b|(?:^|[.!?\n] ?)(?:Certainly|Of course)!/im;

const KNOWLEDGE_DISCLAIMER =
  /\b(?:as of my (?:last|latest|most recent)|up to my last training|my (?:training data|knowledge cutoff)|while specific details are (?:limited|scarce)|based on (?:the )?available information|not (?:widely|extensively) documented|in the (?:provided|available) sources|maintains a low profile)\b/i;

const DASHES_MIN = 3;
const BOLD_LABELS_MIN = 3;

function dashCount(text: string): number {
  // An en dash between digits is a range ("2020–2024"), not a connector.
  const em = text.match(/—| -- /g)?.length ?? 0;
  const en = [...text.matchAll(/–/g)].filter((m) => {
    const i = m.index ?? 0;
    return !(/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? ""));
  }).length;
  return em + en;
}

function boldLabelCount(html: string): number {
  const items = html.match(/<li[^>]*>\s*(?:<p[^>]*>\s*)?<(strong|b)>[^<]{1,60}<\/\1>\s*:?/gi) ?? [];
  return items.filter((i) => /:\s*<\/(?:strong|b)>|<\/(?:strong|b)>\s*:/i.test(i)).length;
}

function headings(html: string): string[] {
  return [...html.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi)].map((m) => proseOf(m[1]).trim());
}

/** Every main word capitalized: "Strategic Negotiations And Global Partnerships". */
function isTitleCase(heading: string): boolean {
  const rest = heading.split(/\s+/).slice(1).filter((w) => /^[A-Za-z]{4,}$/.test(w));
  return rest.length >= 2 && rest.every((w) => /^[A-Z][a-z]/.test(w));
}

export function findHumanizerTells(input: HumanizerTellInput): HumanizerTell[] {
  const html = input.content_html ?? "";
  const text = [input.title, input.excerpt, input.meta_description, input.answer_summary, proseOf(html)]
    .filter((s): s is string => Boolean(s?.trim()))
    .join("\n");
  const out: HumanizerTell[] = [];
  if (!text.trim()) return out;

  const contrast = NOT_X_BUT_Y.map((re) => re.exec(text)?.[0]).find((m): m is string => Boolean(m));
  if (contrast) {
    out.push({
      key: "humanizer_not_x_but_y",
      message: `Reads as AI-written: a "not X, but Y" contrast (${quote(contrast)}). State the point directly unless the negative half corrects something readers believe.`,
    });
  }

  const closer = text.match(CLOSERS)?.[0];
  if (closer) {
    out.push({
      key: "humanizer_closer",
      message: `Reads as AI-written: a one-line closer that asks for a pause instead of adding a fact (${quote(closer)}). Cut it.`,
    });
  }

  const residue = CHATBOT_RESIDUE.exec(text);
  if (residue) {
    out.push({
      key: "humanizer_chatbot_residue",
      message: `Chatbot wording left in the text (${quote(residue[0])}). Remove the greeting, offer or sign-off and keep the content.`,
    });
  }

  const disclaimer = KNOWLEDGE_DISCLAIMER.exec(text);
  if (disclaimer) {
    out.push({
      key: "humanizer_knowledge_disclaimer",
      message: `A knowledge-limit disclaimer or unsourced guess (${quote(disclaimer[0])}). Say what the source shows, or remove the sentence.`,
    });
  }

  const dashes = dashCount(text);
  if (dashes >= DASHES_MIN) {
    out.push({
      key: "humanizer_dashes",
      message: `${dashes} dashes used as connectors. Replace each with a period, comma, colon or parentheses, unless dashes are this writer's own style.`,
    });
  }

  const words = [...new Set((text.match(AI_WORD_RE) ?? []).map((w) => w.toLowerCase()))];
  if (words.length >= AI_WORDS_MIN) {
    out.push({
      key: "humanizer_ai_words",
      message: `${words.length} words models overuse: ${words.slice(0, 8).join(", ")}. Use the plain word.`,
    });
  }

  const labels = boldLabelCount(html);
  if (labels >= BOLD_LABELS_MIN) {
    out.push({
      key: "humanizer_bold_labels",
      message: `${labels} list items open with a bold label and a colon. Drop the bold, or turn the list into prose when the labels carry no information.`,
    });
  }

  const hs = headings(html);
  const emoji = hs.find((h) => /\p{Extended_Pictographic}|→/u.test(h));
  const titleCased = hs.filter(isTitleCase);
  if (emoji || (titleCased.length >= 2 && titleCased.length * 2 >= hs.length)) {
    out.push({
      key: "humanizer_decorative_headings",
      message: emoji
        ? `A heading carries an emoji or arrow as decoration (${quote(emoji)}). Remove it.`
        : `${titleCased.length} headings capitalize every main word (${quote(titleCased[0])}). Use sentence case.`,
    });
  }

  return out;
}
