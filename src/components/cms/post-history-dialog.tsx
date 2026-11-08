"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { History, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listPostRevisions, getPostRevision, restorePostRevision } from "@/lib/api";
import { postSaveConflictMessage } from "@/lib/post-save-conflict";
import { diffLines } from "@/lib/diff";
import type { Post, PostRevisionSource } from "@/types/cms";

const SOURCE_LABEL: Record<PostRevisionSource, string> = {
  cms_ui: "Editor",
  api: "API",
  mcp: "AI (MCP)",
  import: "File sync",
  restore: "Restore",
  writing: "Writing session",
  checkpoint: "Checkpoint",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function PostHistoryDialog({
  postId,
  contentHash,
  currentContent,
  onRestore,
  onClose,
}: {
  postId: string;
  /** The editor's currently-tracked content_hash — sent as expected_content_hash
   *  so a restore can't silently clobber an edit that landed since this loaded. */
  contentHash: string | null;
  /** The editor's current (unsaved-or-saved) content, diffed against the selected revision. */
  currentContent: string;
  onRestore: (post: Post) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: list, isLoading: listLoading } = useQuery({
    queryKey: ["post-revisions", postId],
    queryFn: () => listPostRevisions(postId),
  });
  const revisions = list?.data ?? [];

  const { data: selected, isLoading: selectedLoading } = useQuery({
    queryKey: ["post-revision", postId, selectedId],
    queryFn: () => getPostRevision(postId, selectedId!),
    enabled: !!selectedId,
  });

  const restoreMutation = useMutation({
    mutationFn: (revisionId: string) => restorePostRevision(postId, revisionId, contentHash),
    onSuccess: (post) => {
      toast.success("Post restored to the selected revision");
      queryClient.invalidateQueries({ queryKey: ["post-revisions", postId] });
      onRestore(post);
      onClose();
    },
    onError: (error) => {
      const conflict = postSaveConflictMessage(error);
      if (conflict) {
        toast.error(conflict, { action: { label: "Reload", onClick: () => window.location.reload() } });
        return;
      }
      toast.error("Failed to restore this revision");
    },
  });

  const diff = selected ? diffLines(selected.content ?? "", currentContent) : [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            Revision history
          </DialogTitle>
          <DialogDescription>
            Every content-changing save is recoverable. Select a revision to see what changed
            and, if needed, restore it — restoring is itself undoable.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col sm:flex-row flex-1 min-h-0 border-t">
          {/* Revision list */}
          <div className="sm:w-64 sm:border-r flex-shrink-0 border-b sm:border-b-0">
            <ScrollArea className="h-48 sm:h-full">
              <div className="p-2 space-y-1">
                {listLoading && (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                )}
                {!listLoading && revisions.length === 0 && (
                  <p className="text-sm text-muted-foreground px-2 py-4">
                    No past revisions yet — they appear here after the next content edit.
                  </p>
                )}
                {revisions.map((rev) => (
                  <button
                    key={rev.id}
                    type="button"
                    onClick={() => setSelectedId(rev.id)}
                    className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted min-h-[44px] ${
                      selectedId === rev.id ? "bg-muted" : ""
                    }`}
                  >
                    <div className="font-medium truncate">{rev.title || "Untitled"}</div>
                    {rev.label && <div className="text-xs text-foreground truncate">{rev.label}</div>}
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      <span>{formatWhen(rev.inserted_at)}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant="outline" className="text-xs">
                        {SOURCE_LABEL[rev.source]}
                      </Badge>
                      {rev.edited_by && (
                        <span className="text-xs text-muted-foreground truncate">
                          {rev.edited_by.name || rev.edited_by.email}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Diff + restore */}
          <div className="flex-1 min-h-0 flex flex-col">
            {!selectedId && (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-6 text-center">
                Select a revision on the left to see what it changed.
              </div>
            )}
            {selectedId && selectedLoading && (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {selectedId && selected && (
              <>
                <ScrollArea className="flex-1 min-h-0">
                  <pre className="text-xs font-mono p-4 whitespace-pre-wrap break-words">
                    {diff.map((line, idx) => (
                      <div
                        key={idx}
                        className={
                          line.type === "add"
                            ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300"
                            : line.type === "remove"
                              ? "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300"
                              : ""
                        }
                      >
                        {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
                        {line.text}
                      </div>
                    ))}
                  </pre>
                </ScrollArea>
                <div className="flex items-center justify-between border-t px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    Comparing this revision (left) against the editor's current content (right).
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={restoreMutation.isPending}
                    onClick={() => restoreMutation.mutate(selected.id)}
                  >
                    {restoreMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4 mr-2" />
                    )}
                    Restore this version
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
