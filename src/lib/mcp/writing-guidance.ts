import { HUMANIZER_MCP_GUIDANCE } from "@/lib/humanizer";

/**
 * How every post should be written so search engines, answer boxes and AI
 * assistants can find and cite it (SEO / AEO / GEO — SEO-AEO-GEO-PLAN.md).
 *
 * This rides in the MCP server instructions because that is the one channel
 * that reaches EVERY client — the claude.ai connector and other MCP clients
 * have no skills, only these instructions and the tool descriptions. The
 * Interactor CMS plugin's `optimize-post` skill (InteractorOSS/
 * cms-claude-plugins) is the long form of the same rules; keep the two in
 * step. Deliberately short: it is loaded into every client's context. The
 * Humanizer short form (src/lib/humanizer) rides along for the same reason.
 */
export const POST_WRITING_GUIDANCE =
  "Write every post to be found by search engines, answer boxes and AI assistants: " +
  "(1) open with a direct 40-60 word answer to the question the title asks, and define " +
  "the main term in a plain \"X is a ...\" sentence near the top; (2) phrase most " +
  "headings as the questions readers ask, each followed by a short direct answer; " +
  "(3) back claims with specific numbers, short quotations and links to primary " +
  "sources; (4) use real lists and tables for steps and comparisons; (5) name " +
  "products, companies and people explicitly rather than \"our tool\"; (6) set a " +
  "specific title under ~60 characters, a unique meta_description of 70-160 " +
  "characters and a 1-2 sentence excerpt; (7) add an FAQ — as question headings with " +
  "short answers in the body, or entries via create_faq/update_faq — only for genuine " +
  "reader questions the body doesn't already answer as its own section, never a " +
  "speculative one just to have one. NEVER invent a statistic, quote, source or " +
  "first-hand experience: ask the writer, or leave a visible [source needed] marker " +
  "and say so. Don't keyword-stuff or change the slug of a published post. Before " +
  "post_workflow submit or publish, call " +
  "check_post_seo: fix every error it reports (the workflow gate refuses on them), " +
  "address its warnings where they apply, and tell the writer what still needs a " +
  "source. " +
  HUMANIZER_MCP_GUIDANCE;

/** For tools that save prose other than a post body (social copy, FAQ answers). */
export const HUMANIZER_TOOL_NOTE =
  "Before saving prose you wrote, remove AI-writing patterns per the Humanizer rules in " +
  "this server's instructions (get_humanizer_guide has the full text).";

/** One line pointing a write tool's description at the guidance above. */
export const WRITE_TOOL_GUIDANCE_NOTE =
  " Write the content to the post-writing guidance in this server's instructions " +
  "(answer first, question headings, real evidence, title/meta_description/excerpt, " +
  "FAQ only for genuine reader questions); never invent statistics, quotes or sources. " +
  HUMANIZER_TOOL_NOTE;

