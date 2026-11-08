import type { Actor } from "@/lib/rbac";

// Decision #2 in CONTENT-AI-PLAN.md: users own their personal profiles;
// org-scope profiles require admin:settings.
export function canManageProfile(
  actor: Actor,
  profile: { scope: string; owner_id: string | null }
): boolean {
  if (profile.scope === "org") return actor.permissions.has("admin:settings");
  return (
    profile.owner_id === actor.user.id ||
    actor.permissions.has("admin:settings")
  );
}
