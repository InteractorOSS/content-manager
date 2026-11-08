"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useMe } from "@/hooks/use-me";
import { createOrganization, switchOrganization } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Organization switcher for the app shell (SMM-CONSOLIDATION-PUNCHLIST T5).
 *
 * Rendered for every signed-in user, including single-org ones — it doubles as
 * the "which tenant am I looking at" label and the entry point for creating a
 * second org, so hiding it below two memberships would hide the only way to get
 * a second membership.
 */
export function OrgSwitcher() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { organizations, currentOrg, isLoading } = useMe();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");

  /**
   * Every cached query holds the PREVIOUS org's rows, so the cache is wholly
   * invalid after a switch — clear it rather than invalidating key by key, and
   * refresh so server components re-render against the new org too.
   */
  async function afterOrgChange() {
    queryClient.clear();
    router.refresh();
  }

  const switchMutation = useMutation({
    mutationFn: switchOrganization,
    onSuccess: async (_data, orgId) => {
      const next = organizations.find((o) => o.id === orgId);
      await afterOrgChange();
      toast.success(next ? `Switched to ${next.name}` : "Organization switched");
    },
    onError: (e: Error) => {
      toast.error(e.message || "Could not switch organization. Try again.");
    },
  });

  const createMutation = useMutation({
    mutationFn: createOrganization,
    onSuccess: async (org) => {
      setCreateOpen(false);
      setName("");
      await afterOrgChange();
      toast.success(`Created ${org.name}`);
    },
    onError: (e: Error) => {
      toast.error(e.message || "Could not create the organization. Try again.");
    },
  });

  const busy = switchMutation.isPending || createMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex min-h-11 items-center gap-2 px-3 py-2 text-sm text-sidebar-foreground/60">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading organizations…
      </div>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-label={
              currentOrg
                ? `Current organization: ${currentOrg.name}. Switch organization`
                : "Choose an organization"
            }
            className={cn(
              // min-h-11 keeps the tap target at 44px on touch devices.
              "flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
              "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <Building2 className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">
              {currentOrg?.name ?? "No organization"}
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {organizations.length === 0 && (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              You don&apos;t belong to an organization yet. Create one to get started.
            </p>
          )}
          {organizations.map((org) => {
            const isCurrent = org.id === currentOrg?.id;
            return (
              <DropdownMenuItem
                key={org.id}
                disabled={busy}
                onSelect={() => {
                  if (isCurrent) return;
                  switchMutation.mutate(org.id);
                }}
                className="min-h-11 gap-2"
              >
                {/* An icon, not just color, marks the active org. */}
                <Check
                  className={cn("h-4 w-4 shrink-0", isCurrent ? "opacity-100" : "opacity-0")}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{org.name}</span>
                <span className="shrink-0 text-xs capitalize text-muted-foreground">
                  {org.role}
                </span>
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => setCreateOpen(true)}
            className="min-h-11 gap-2"
          >
            <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
            New organization
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              createMutation.mutate(trimmed);
            }}
          >
            <DialogHeader>
              <DialogTitle>New organization</DialogTitle>
              <DialogDescription>
                You&apos;ll be its owner, and it becomes your active organization.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2 py-4">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Personal"
                maxLength={120}
                autoFocus
                disabled={createMutation.isPending}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={createMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || createMutation.isPending}>
                {createMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
