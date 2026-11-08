import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getAnthropic, AI_MODEL } from "@/lib/ai/client";

// Style-guide distillation (CONTENT-AI-PLAN.md §4). The guide is a
// human-editable markdown artifact — the single prompt input for all
// generation, so it must be explicit, concrete, and free of fluff.

const ANALYST_SYSTEM = `You are a writing-style analyst for a content team.
You produce STYLE GUIDES: precise, actionable documents that let another writer
(or model) reproduce an author's voice.

A style guide has these sections, in markdown:
# Style Guide
## Voice & persona
## Tone
## Rhythm & sentence structure
## Vocabulary & phrasing (words/phrases they favor; words they never use)
## Structure & formatting habits (openings, headings, lists, closings, CTAs)
## Do
## Don't
## Example phrases (short verbatim quotes from the samples that capture the voice)

Rules:
- Be concrete. "Short punchy openers, often a one-sentence claim" beats "engaging openings".
- Every claim must be grounded in the samples; do not invent preferences.
- If the author explicitly said what they like (interview notes), treat those points
  as the highest-priority signal and reflect them prominently.
- Keep the whole guide under 900 words. It is a prompt, not an essay.`;

export interface SampleInput {
  title: string | null;
  text: string;
  likedNotes: string | null;
}

function samplesBlock(samples: SampleInput[]): string {
  return samples
    .map((s, i) => {
      const notes = s.likedNotes
        ? `\n<what_the_author_likes_about_it>\n${s.likedNotes}\n</what_the_author_likes_about_it>`
        : "";
      return `<sample index="${i + 1}" title="${s.title ?? "untitled"}">\n${s.text.slice(0, 20_000)}\n</sample>${notes}`;
    })
    .join("\n\n");
}

export interface StyleAnalysisResult {
  guide: string;
  inputTokens: number;
  outputTokens: number;
}

/** Distill a style guide from samples (+ interview notes), optionally revising a previous guide. */
export async function analyzeStyle(
  samples: SampleInput[],
  previousGuide?: string | null
): Promise<StyleAnalysisResult> {
  const client = getAnthropic();

  const revision = previousGuide
    ? `\n\nA previous version of the guide exists. Revise it rather than starting over —
keep what is still supported by the samples, integrate new samples and interview
notes, and drop anything contradicted:\n<previous_guide>\n${previousGuide}\n</previous_guide>`
    : "";

  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: ANALYST_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Analyze these writing samples and produce the style guide.\n\n${samplesBlock(samples)}${revision}\n\nReturn ONLY the markdown style guide, starting with "# Style Guide".`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to analyze this content");
  }

  const guide = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (!guide.startsWith("#")) {
    throw new Error("Analysis returned an unexpected format");
  }

  return {
    guide,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// Continuous learning (Phase D, CONTENT-AI-PLAN.md §4 point 5): when an
// author edits an AI-generated draft before approving it, look for a durable
// style preference in the edit (not a one-off fix) and propose an amended
// guide. Never silently mutate the guide — this only returns a suggestion.

const AmendmentSchema = z.object({
  has_suggestion: z.boolean(),
  rationale: z.string(),
  diff_summary: z.string(),
  amended_guide: z.string(),
});
export type AmendmentProposal = z.infer<typeof AmendmentSchema>;

export interface ProposeAmendmentResult {
  proposal: AmendmentProposal;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Compare the AI-generated baseline against the author's final edited
 * version and propose a guide amendment if the edits reveal a repeatable
 * preference. `has_suggestion: false` means the edits were one-off
 * (a fact fix, a typo, a one-time reword) with nothing durable to learn.
 */
export async function proposeGuideAmendment(
  currentGuide: string,
  generated: string,
  final: string
): Promise<ProposeAmendmentResult> {
  const client = getAnthropic();

  const response = await client.messages.parse({
    model: AI_MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    system: `You maintain a writing-style guide used as a prompt for an AI content generator. You are given the current guide, a piece the AI generated from it, and the author's final edited version of that same piece. Your job is to decide whether the edits reveal a REPEATABLE style preference the guide is missing or getting wrong — not a one-off correction (a fact fix, a typo, cutting one paragraph because of its specific content, a single awkward sentence). Only propose a change when you see a pattern: a phrasing habit, a structural preference, a tone shift, something the author would want reproduced next time. If the edits don't reveal a durable pattern, set has_suggestion to false and leave amended_guide equal to the current guide unchanged. When you do have a suggestion, amended_guide must be the COMPLETE revised guide (not a diff or a snippet) — keep everything from the current guide that's still true, and integrate the new observation directly into the relevant section.`,
    messages: [
      {
        role: "user",
        content: `<current_guide>\n${currentGuide}\n</current_guide>\n\n<ai_generated>\n${generated.slice(0, 40_000)}\n</ai_generated>\n\n<author_final>\n${final.slice(0, 40_000)}\n</author_final>`,
      },
    ],
    output_config: { format: zodOutputFormat(AmendmentSchema) },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to compare these versions");
  }
  const proposal = response.parsed_output;
  if (!proposal) {
    throw new Error("Amendment proposal returned an unparseable result");
  }

  return {
    proposal,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
