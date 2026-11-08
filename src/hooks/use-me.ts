"use client";

import { useQuery } from "@tanstack/react-query";
import { getMe } from "@/lib/api";
import type { Me } from "@/types/cms";

/**
 * Current actor (local user + roles + permissions) for UI gating.
 * `can()` returns false while loading, so gated controls appear
 * once permissions arrive rather than flashing and disappearing.
 */
export function useMe() {
  const { data, isLoading } = useQuery<Me>({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60 * 1000,
  });

  const can = (permission: string): boolean =>
    data?.permissions.includes(permission) ?? false;

  // Tolerate a cached Me from before organizations existed (a client holding a
  // pre-T5 payload would otherwise crash the switcher on `.map`).
  const organizations = data?.organizations ?? [];
  const currentOrg =
    organizations.find((o) => o.id === data?.organization_id) ?? null;

  return { me: data, isLoading, can, organizations, currentOrg };
}
