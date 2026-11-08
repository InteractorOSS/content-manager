// The networks a post's social copy is written for, client-safe (no AI SDK),
// so the writer editor can import it. Kept equal to SOCIAL_FORMATS in
// src/lib/ai/generate.ts (pinned by post-social.test.ts).

export const SOCIAL_NETWORKS = ["linkedin", "twitter", "facebook"] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export function isSocialNetwork(value: string): value is SocialNetwork {
  return (SOCIAL_NETWORKS as readonly string[]).includes(value);
}

export const SOCIAL_NETWORK_LABELS: Record<SocialNetwork, string> = {
  linkedin: "LinkedIn",
  twitter: "X",
  facebook: "Facebook",
};

/** Per-network limits, shown as counters (mirrors src/lib/social/capabilities.ts);
 *  for X the limit is per tweet. */
export const SOCIAL_LIMITS: Record<SocialNetwork, number> = { linkedin: 2800, twitter: 280, facebook: 1500 };
