import "server-only";
import { env } from "@/lib/env";

/**
 * Phase E scaffold (CONTENT-AI-PLAN.md §6, §7): optionally push the org-wide
 * brand-voice guide to the Interactor User Knowledge-Base as a
 * `domain_knowledge` entry, so other Interactor agents (Slack/Email/
 * Notetaker) inherit the same brand voice for free.
 *
 * UNVERIFIED — built without platform-team coordination or a live UKB
 * credential (see plan §1 research notes). Specifically unconfirmed:
 *   - Whether `UKB_ORG_JWT` should be a long-lived static token or a
 *     client-credentials grant like Core's app token (src/lib/interactor.ts);
 *     a static bearer token is the simplest scaffold and is what's wired up
 *     below.
 *   - The exact `domain_knowledge` request shape beyond the two fields the
 *     plan's research confirmed are required (`type`, `definition`); `title`
 *     and `team_ids` here are reasonable guesses, not confirmed contract.
 *   - The response shape / error format of `/api/v1/knowledge`.
 * Do not treat a successful push as verified behavior until someone with
 * real UKB access runs this once and the shape is confirmed or corrected.
 */

export function ukbConfigured(): boolean {
  return Boolean(env.UKB_ORG_JWT);
}

export class UkbError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown
  ) {
    super(message);
    this.name = "UkbError";
  }
}

async function pushBrandVoiceGuide(profileName: string, guide: string): Promise<void> {
  const res = await fetch(`${env.UKB_URL}/api/v1/knowledge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.UKB_ORG_JWT}`,
    },
    body: JSON.stringify({
      type: "domain_knowledge",
      title: `Brand voice: ${profileName}`,
      definition: guide,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new UkbError(
      res.status,
      `UKB push failed (${res.status})`,
      await res.text().catch(() => undefined)
    );
  }
}

/**
 * Best-effort: call after any new StyleGuideVersion lands on an org-scope
 * profile. No-ops if UKB isn't configured or the profile is personal (§4:
 * only the org-wide brand voice is a fit for UKB's org-scoped model — see
 * plan §1 for why per-user style can't live there). Never throws — a push
 * failure must not block saving the guide itself.
 */
export async function maybePushBrandVoice(
  profile: { scope: string; name: string },
  guide: string
): Promise<void> {
  if (profile.scope !== "org" || !ukbConfigured()) return;
  try {
    await pushBrandVoiceGuide(profile.name, guide);
  } catch (e) {
    console.error("UKB brand-voice push failed", e);
  }
}
