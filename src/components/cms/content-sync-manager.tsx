"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitBranch, Loader2, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  getContentSyncConnection,
  connectContentSync,
  disconnectContentSync,
  type ContentSyncConnection,
} from "@/lib/content-sync-api";

export function ContentSyncManager() {
  const queryClient = useQueryClient();
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");

  const { data: connection, isLoading } = useQuery<ContentSyncConnection | null>({
    queryKey: ["content-sync-connection"],
    queryFn: () => getContentSyncConnection(),
  });

  const connectMutation = useMutation({
    mutationFn: () => connectContentSync({ repo: repo.trim(), branch: branch.trim() || "main" }),
    onSuccess: (result) => {
      window.location.href = result.authorization_url;
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to start connection"),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectContentSync(),
    onSuccess: () => {
      toast.success("Disconnected");
      queryClient.invalidateQueries({ queryKey: ["content-sync-connection"] });
    },
    onError: () => toast.error("Failed to disconnect"),
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="rounded-lg border bg-background p-4 space-y-4">
      <div className="flex items-center gap-2">
        <GitBranch className="h-5 w-5" />
        <h3 className="font-semibold text-sm">Git content repo</h3>
        {connection && (
          <Badge variant={connection.status === "active" ? "success" : "secondary"}>
            {connection.status}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Two-way sync between posts and a GitHub repo, so an Obsidian vault (or any git
        client) can pull/edit/push Markdown files that flow straight into the CMS. See
        FILE-BASED-CONTENT-PLAN.md Phase 2.
      </p>

      {connection ? (
        <div className="space-y-3">
          <div className="text-sm">
            <span className="text-muted-foreground">Repo: </span>
            <span className="font-mono">{connection.repo}</span>
            <span className="text-muted-foreground"> @ </span>
            <span className="font-mono">{connection.branch}</span>
          </div>
          {connection.connected_by && (
            <p className="text-xs text-muted-foreground">
              Connected by {connection.connected_by.name || connection.connected_by.email}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
          >
            {disconnectMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Unplug className="h-4 w-4 mr-2" />
            )}
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="space-y-3 max-w-md">
          <div className="space-y-1">
            <Label className="text-xs">Repository</Label>
            <Input
              placeholder="owner/repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Branch</Label>
            <Input
              placeholder="main"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <Button
            size="sm"
            onClick={() => connectMutation.mutate()}
            disabled={!repo.trim() || connectMutation.isPending}
          >
            {connectMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <GitBranch className="h-4 w-4 mr-2" />
            )}
            Connect via GitHub
          </Button>
        </div>
      )}
    </div>
  );
}
