"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { Skeleton } from "@/components/ui/skeleton";
import { listComments, updateCommentStatus, deleteComment } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { Comment } from "@/types/cms";

function StatusBadge({ status }: { status: string }) {
  if (status === "pending") return <Badge variant="warning">Pending</Badge>;
  if (status === "published") return <Badge variant="success">Published</Badge>;
  if (status === "spam") return <Badge variant="destructive">Spam</Badge>;
  if (status === "rejected") return <Badge variant="muted">Rejected</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export function CommentsTable() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<Comment | null>(null);

  const { data: comments = [], isLoading } = useQuery<Comment[]>({
    queryKey: ["comments"],
    queryFn: () => listComments(),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      updateCommentStatus(id, status),
    onSuccess: () => {
      toast.success("Status updated");
      queryClient.invalidateQueries({ queryKey: ["comments"] });
    },
    onError: () => toast.error("Failed to update status"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteComment(id),
    onSuccess: () => {
      toast.success("Comment removed");
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["comments"] });
    },
    onError: () => toast.error("Failed to remove comment"),
  });

  const counts = {
    total: comments.length,
    pending: comments.filter((c) => c.status === "pending").length,
    published: comments.filter((c) => c.status === "published").length,
    spam: comments.filter((c) => c.status === "spam").length,
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Total", value: counts.total, color: "text-gray-600", bg: "bg-gray-50" },
          { label: "Pending", value: counts.pending, color: "text-yellow-600", bg: "bg-yellow-50" },
          { label: "Published", value: counts.published, color: "text-green-600", bg: "bg-green-50" },
          { label: "Spam", value: counts.spam, color: "text-red-600", bg: "bg-red-50" },
        ].map((stat) => (
          <div key={stat.label} className={`rounded-lg border p-3 ${stat.bg}`}>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Comment</TableHead>
              <TableHead className="w-40">Author</TableHead>
              <TableHead className="w-48">Post</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-40">Submitted</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {comments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12">
                  <p className="text-sm text-muted-foreground">No comments yet</p>
                </TableCell>
              </TableRow>
            ) : (
              comments.map((comment) => (
                <TableRow key={comment.id}>
                  <TableCell className="text-sm max-w-md">
                    <p className="line-clamp-2">{comment.content}</p>
                  </TableCell>
                  <TableCell className="text-sm">
                    <p className="font-medium">{comment.authorName}</p>
                    <p className="text-xs text-muted-foreground">{comment.authorEmail}</p>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground truncate">
                    {comment.postTitle}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={comment.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {formatDateTime(comment.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {comment.status !== "published" && (
                          <DropdownMenuItem
                            className="gap-2"
                            onClick={() =>
                              updateMutation.mutate({ id: comment.id, status: "published" })
                            }
                          >
                            Approve
                          </DropdownMenuItem>
                        )}
                        {comment.status !== "rejected" && (
                          <DropdownMenuItem
                            className="gap-2"
                            onClick={() =>
                              updateMutation.mutate({ id: comment.id, status: "rejected" })
                            }
                          >
                            Reject
                          </DropdownMenuItem>
                        )}
                        {comment.status !== "spam" && (
                          <DropdownMenuItem
                            className="gap-2 text-yellow-600 focus:text-yellow-600"
                            onClick={() =>
                              updateMutation.mutate({ id: comment.id, status: "spam" })
                            }
                          >
                            Mark Spam
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="gap-2 text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(comment)}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">{comments.length} total comments</p>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Comment</DialogTitle>
            <DialogDescription>
              Delete this comment from {deleteTarget?.authorName}? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
