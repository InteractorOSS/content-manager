import Anthropic from "@anthropic-ai/sdk";

// Single org-level key (decision #3 in CONTENT-AI-PLAN.md). The zero-arg
// constructor also resolves ANTHROPIC_AUTH_TOKEN or an `ant auth login`
// profile in dev.
export const AI_MODEL = process.env.AI_MODEL || "claude-opus-4-8";

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export function aiConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
  );
}
