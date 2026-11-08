"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useMe } from "@/hooks/use-me";
import { getOrganization, updateOrganization } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

const MANAGE_ROLES = ["owner", "admin"];

/**
 * Settings for the CURRENTLY ACTIVE organization (T5). There is no org picker
 * here on purpose — the sidebar switcher already decides which tenant you are
 * looking at, and a second, disagreeing picker on this page is how you end up
 * renaming the wrong org.
 */
export function OrganizationSettings() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { me, currentOrg, isLoading: meLoading } = useMe();
  const orgId = currentOrg?.id ?? me?.organization_id ?? null;

  const canManage = MANAGE_ROLES.includes(currentOrg?.role ?? "");

  const { data: org, isLoading } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId as string),
    enabled: !!orgId,
  });

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  // Seed the form once the org arrives, and re-seed when the active org
  // changes underneath us (switching orgs while this page is open).
  useEffect(() => {
    if (org) {
      setName(org.name);
      setSlug(org.slug);
    }
  }, [org]);

  const save = useMutation({
    mutationFn: () => updateOrganization(orgId as string, { name, slug }),
    onSuccess: (updated) => {
      setName(updated.name);
      setSlug(updated.slug);
      // The name and slug show up in the switcher, which reads /api/me.
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
      router.refresh();
      toast.success("Organization updated");
    },
    onError: (e: Error) => {
      toast.error(e.message || "Could not save changes. Try again.");
    },
  });

  if (meLoading || isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!orgId || !org) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          You don&apos;t have an active organization yet. Create one from the
          switcher in the sidebar.
        </CardContent>
      </Card>
    );
  }

  const dirty = name !== org.name || slug !== org.slug;

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>
          {canManage
            ? "Rename this organization or change its URL handle."
            : "Only an owner or admin can change these settings."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !dirty) return;
            save.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="org-settings-name">Name</Label>
            <Input
              id="org-settings-name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage || save.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="org-settings-slug">Slug</Label>
            <Input
              id="org-settings-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={!canManage || save.isPending}
              aria-describedby="org-settings-slug-help"
            />
            <p id="org-settings-slug-help" className="text-xs text-muted-foreground">
              Letters and numbers only; spaces become hyphens.
            </p>
          </div>

          {canManage && (
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-0"
                disabled={!dirty || save.isPending}
                onClick={() => {
                  setName(org.name);
                  setSlug(org.slug);
                }}
              >
                Reset
              </Button>
              <Button
                type="submit"
                className="min-h-11 sm:min-h-0"
                disabled={!dirty || !name.trim() || save.isPending}
              >
                {save.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                Save changes
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
