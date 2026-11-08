"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, CheckCircle2, XCircle, ClipboardCheck, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listPosts, workflowAction, ApiError } from "@/lib/api";
import { useMe } from "@/hooks/use-me";
import type { Post } from "@/types/cms";
import { formatDateTime } from "@/lib/utils";

type Verdict = { post: Post; action: "approve" | "reject" };

export function ReviewQueue() {
  const queryClient = useQueryClient();
  const { can } = useMe();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [comments, setComments] = useState("");

  const { data: posts = [], isLoading } = useQuery<Post[]>({
    queryKey: ["posts", { workflow_status: "pending_review" }],
    queryFn: () => listPosts({ workflow_status: "pending_review", per_page: 100 }),
  });

  const mutation = useMutation({
    mutationFn: ({ post, action }: Verdict) =>
      workflowAction(post.id, action, action === "reject" ? { reason: comments } : { comments }),
    onSuccess: (_post, { action }) => {
      toast.success(action === "approve" ? "Post approved" : "Post rejected");
      setVerdict(null);
      setComments("");
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Failed to update the post"),
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="rounded-lg border bg-background p-10 text-center">
        <ClipboardCheck className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
        <p className="text-sm text-muted-foreground">Nothing waiting for review</p>
        <p className="text-xs text-muted-foreground mt-1">
          Posts appear here when authors submit them for review
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {posts.map((post) => (
        <div
          key={post.id}
          className="flex items-center justify-between gap-4 rounded-lg border bg-background p-4"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium truncate">{post.title || "(untitled)"}</p>
              <Badge variant="secondary" className="text-xs shrink-0">
                {post.type}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {post.author_name ?? "Unknown author"} · updated {formatDateTime(post.updated_at)}
              {post.category && <> · {post.category.name}</>}
            </p>
            {post.excerpt && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{post.excerpt}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/posts/${post.slug}/edit`}>
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Open
              </Link>
            </Button>
            {can("content:approve") && (
              <Button
                size="sm"
                onClick={() => setVerdict({ post, action: "approve" })}
              >
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                Approve
              </Button>
            )}
            {can("content:reject") && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setVerdict({ post, action: "reject" })}
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                Reject
              </Button>
            )}
          </div>
        </div>
      ))}

      <Dialog
        open={!!verdict}
        onOpenChange={(open) => {
          if (!open) {
            setVerdict(null);
            setComments("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {verdict?.action === "approve" ? "Approve post" : "Reject post"}
            </DialogTitle>
            <DialogDescription>
              {verdict?.post.title || "(untitled)"}
              {verdict?.action === "reject" &&
                " — the author will see your reason on the post."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder={
              verdict?.action === "approve"
                ? "Optional comments for the approval log"
                : "Why is this being rejected?"
            }
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setVerdict(null);
                setComments("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant={verdict?.action === "reject" ? "destructive" : "default"}
              onClick={() => verdict && mutation.mutate(verdict)}
              disabled={mutation.isPending || (verdict?.action === "reject" && !comments.trim())}
            >
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {verdict?.action === "approve" ? "Approve" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
