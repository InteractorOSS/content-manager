import { HUMANIZER_SKILL_MD } from "@/lib/humanizer/skill.generated";
import upstream from "@/lib/humanizer/upstream.json";

/**
 * Humanizer (https://github.com/blader/humanizer, MIT): the rules every
 * model-written piece of CMS content is held to, so it reads like a person
 * wrote it. One vendored copy feeds every surface:
 *
 *  - web generation (`buildStyleSystem` in src/lib/ai/generate.ts) gets the
 *    full skill as its final pass;
 *  - the MCP server, and so the Claude connector, carries a short form in its
 *    instructions (`HUMANIZER_MCP_GUIDANCE`) and the full text through the
 *    `get_humanizer_guide` tool — instructions load into every client's
 *    context, so the 5,000-word skill doesn't belong there;
 *  - the Interactor CMS plugin (InteractorOSS/cms-claude-plugins) vendors the
 *    same SKILL.md as its `humanizer` skill, synced by its own copy of the
 *    script.
 *
 * Never edit skill.generated.ts or upstream.json by hand: `npm run
 * humanizer:sync` rewrites them, and .github/workflows/humanizer-update.yml
 * opens a PR whenever upstream's SKILL.md changes. The pattern list below is
 * derived from the skill's headings so a renumbered upstream needs no edit
 * here.
 */

export const HUMANIZER_VERSION: string = upstream.version;
export const HUMANIZER_COMMIT: string = upstream.commit;
export const HUMANIZER_REPO_URL = `https://github.com/${upstream.repo}`;

/** The skill without its YAML frontmatter (only agent loaders read that). */
export const HUMANIZER_SKILL_BODY: string = HUMANIZER_SKILL_MD.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

/** "N. Name" for every numbered pattern, in upstream's order (strongest first). */
export function humanizerPatterns(body: string = HUMANIZER_SKILL_BODY): string[] {
  return [...body.matchAll(/^### (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2].trim()}`);
}

/**
 * Short form for the MCP server instructions. Names every pattern so a client
 * that never calls the tool still knows what to look for; the tool has the
 * examples and the exceptions.
 */
export const HUMANIZER_MCP_GUIDANCE: string =
  `Write like a person, not a chatbot (Humanizer v${HUMANIZER_VERSION}, ${HUMANIZER_REPO_URL}). ` +
  "Before saving any prose you wrote or rewrote (a post body, title, excerpt, meta_description, FAQ answer or " +
  "social copy), check it for these AI-writing patterns, strongest first, and rewrite the passages that have them: " +
  humanizerPatterns().join("; ") +
  ". Keep every fact and add none to fix a pattern. A writer's own sample or style guide decides the voice " +
  "and wins over these patterns. Call get_humanizer_guide once per session before writing for the full rules " +
  "with examples. The CMS checks for itself: check_post_seo and post_workflow submit/publish return humanizer " +
  "warnings naming the passages that still read as AI-written. Fix those before you call the post done.";

/**
 * Appended to every web-generation system prompt, after the brand and author
 * guides. Byte-identical across calls, so it stays a prompt-cache read.
 * "Embedded mode" is the skill's own name for returning only the final text.
 */
export function humanizerGenerationBlock(): string {
  return [
    `Apply the Humanizer rules below to everything you write, as your last pass before you return it. Use the skill's embedded mode: put only the final text in the requested fields, with no draft, pattern list or notes. The brand and author guides above decide the voice; where one of them asks for a pattern on purpose (dashes, for example), follow the guide. Never add a fact, number, quote or source to fix a pattern.`,
    `<humanizer version="${HUMANIZER_VERSION}">\n${HUMANIZER_SKILL_BODY}\n</humanizer>`,
  ].join("\n\n");
}
