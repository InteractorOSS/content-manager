"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Edit,
  ExternalLink,
  Hand,
  Loader2,
  MinusCircle,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { FailureNotice } from "@/components/ui/failure-notice";
import {
  listSocialPosts,
  deleteSocialPost,
  publishSocialPostNow,
  retrySocialPostTarget,
  socialWorkflowAction,
} from "@/lib/social-api";
import {
  channelLabel,
  describeSocialActionFailure,
  describeStoredTargetError,
} from "@/lib/social/publish-errors";
import { useMe } from "@/hooks/use-me";
import { truncate } from "@/lib/utils";
import type {
  SocialPost,
  SocialPostStatus,
  SocialPostTarget,
  SocialTargetStatus,
} from "@/types/social";
import { PostComposer } from "@/components/social/post-composer";

const TABS = [
  // G#27: awaiting_manual included here too — a post whose only remaining
  // work is a human pasting it on the real platform is still "in the
  // queue," not tucked away somewhere invisible. The dedicated Social >
  // Manual queue page is for actually doing that; this tab is so it's never
  // the ONLY place a post rolled up to awaiting_manual is visible.
  { value: "queue", label: "Queue", statuses: "scheduled,approved,publishing,awaiting_manual" },
  { value: "drafts", label: "Drafts", statuses: "draft" },
  { value: "approvals", label: "Approvals", statuses: "pending_review,rejected" },
  { value: "published", label: "Published", statuses: "published,partially_published" },
  { value: "failed", label: "Failed", statuses: "failed" },
] as const;

const STATUS_BADGES: Record<
  SocialPostStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "muted" }
> = {
  draft: { label: "Draft", variant: "warning" },
  pending_review: { label: "In review", variant: "info" },
  approved: { label: "Approved", variant: "secondary" },
  rejected: { label: "Rejected", variant: "destructive" },
  scheduled: { label: "Scheduled", variant: "default" },
  publishing: { label: "Publishing", variant: "info" },
  awaiting_manual: { label: "Awaiting manual post", variant: "warning" },
  published: { label: "Published", variant: "success" },
  partially_published: { label: "Partially published", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  archived: { label: "Archived", variant: "muted" },
};

// Networks the AI fan-out writes for (labels match the fan-out dialog).
const NETWORK_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  twitter: "X (Twitter)",
  facebook: "Facebook",
};

const EDITABLE_STATUSES: SocialPostStatus[] = [
  "draft",
  "rejected",
  "scheduled",
  "approved",
  "pending_review",
  // G#27: not yet delivered — a human still has to paste it — so it's
  // editable the same as "scheduled", not locked like publishing/published.
  "awaiting_manual",
];

/**
 * How each channel's own result reads. A word AND an icon AND a colour — the
 * status used to live only in a hover tooltip, which a keyboard or touch
 * reader never reaches, and colour alone would carry no meaning for anyone who
 * can't see it.
 */
const TARGET_STATUS: Record<
  SocialTargetStatus,
  { label: string; icon: typeof Check; className: string }
> = {
  pending: { label: "Queued", icon: Clock, className: "text-muted-foreground" },
  publishing: { label: "Sending", icon: Loader2, className: "text-blue-700" },
  // G#27: nothing will be sent for this channel — a person posts the copy
  // themselves from the Manual queue. Same words as the post-level badge.
  awaiting_manual: { label: "Awaiting manual post", icon: Hand, className: "text-amber-700" },
  published: { label: "Published", icon: CheckCircle2, className: "text-green-700" },
  // red-700, not the destructive token: at this 12px size the token's red
  // measures 3.76:1 on the row background, under the 4.5:1 AA floor, and it
  // sits beside blue-700/green-700 above anyway.
  failed: { label: "Failed", icon: AlertCircle, className: "text-red-700" },
  skipped: { label: "Skipped", icon: MinusCircle, className: "text-muted-foreground" },
};

function targetName(target: SocialPostTarget): string {
  return target.channel
    ? channelLabel(target.channel)
    : "this channel";
}

/** "Next try at 14:32" — what the automatic retry is waiting for. */
function nextTryLabel(target: SocialPostTarget): string | null {
  if (target.status !== "pending" || !target.next_attempt_at) return null;
  const at = new Date(target.next_attempt_at);
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return null;
  return `Next try at ${format(at, "HH:mm")}`;
}

/**
 * One channel's result, and — when it failed — the way back.
 *
 * The retry button lives here, in the flow of the page, rather than inside the
 * tooltip this list used to be: an action nobody can tab to is not an action.
 */
function TargetRow({
  target,
  onRetry,
  retrying,
  canRetry,
}: {
  target: SocialPostTarget;
  onRetry: () => void;
  retrying: boolean;
  canRetry: boolean;
}) {
  const status = TARGET_STATUS[target.status] ?? TARGET_STATUS.pending;
  const StatusIcon = status.icon;
  const message = describeStoredTargetError(target.error);
  const waiting = nextTryLabel(target);
  const name = targetName(target);

  return (
    <li className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="outline" className="text-xs font-normal">
          {name}
        </Badge>
        <span
          className={`inline-flex items-center gap-1 text-xs font-medium ${status.className}`}
        >
          <StatusIcon
            className={`h-3.5 w-3.5 ${target.status === "publishing" ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {status.label}
        </span>
        {target.external_url && (
          <a
            href={target.external_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1 text-xs underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            View on {target.channel?.service_name ?? "the network"}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </div>

      {/* Still queued: say what is happening, don't offer a button for it. */}
      {target.status !== "failed" && (message || waiting) && (
        <p className="text-xs text-muted-foreground">
          {[message, waiting].filter(Boolean).join(" ")}
        </p>
      )}

      {target.status === "failed" && (
        <FailureNotice
          className="p-3"
          failure={{
            message:
              message ??
              `Nothing was posted to ${name}, and we don't have a reason on file. Retry this channel to see the current result.`,
            action: canRetry ? "retry" : "none",
          }}
          onRetry={onRetry}
          retryLabel={`Retry ${name}`}
          retryPending={retrying}
          retryPendingLabel="Retrying…"
        />
      )}
    </li>
  );
}

function TargetList({
  post,
  onRetry,
  retryingTargetId,
  canRetry,
}: {
  post: SocialPost;
  onRetry: (target: SocialPostTarget) => void;
  retryingTargetId: string | null;
  canRetry: boolean;
}) {
  if (post.targets.length === 0) {
    return (
      <span className="text-sm text-muted-foreground">No channels yet</span>
    );
  }
  return (
    <ul className="space-y-2">
      {post.targets.map((target) => (
        <TargetRow
          key={target.id}
          target={target}
          onRetry={() => onRetry(target)}
          retrying={retryingTargetId === target.id}
          canRetry={canRetry && target.status !== "published"}
        />
      ))}
    </ul>
  );
}

function PostSummary({ post }: { post: SocialPost }) {
  return (
    <>
      <span className="block truncate">
        {truncate(post.body, 80) || "(Empty)"}
      </span>
      {(post.parts?.length ?? 0) > 0 && (
        <span className="block text-xs text-muted-foreground">
          {partsSummary(post.parts)}
        </span>
      )}
      {(post.network || post.source_post) && (
        <span className="flex items-center gap-1.5 mt-1 min-w-0">
          {post.network && (
            <Badge variant="outline" className="text-xs shrink-0">
              {NETWORK_LABELS[post.network] ?? post.network}
            </Badge>
          )}
          {post.source_post && (
            <Link
              href={`/posts/${post.source_post.slug}/edit`}
              className="text-xs text-muted-foreground truncate hover:text-foreground hover:underline"
              title={post.source_post.title}
            >
              from: {post.source_post.title}
            </Link>
          )}
        </span>
      )}
      {post.status === "rejected" && post.rejection_reason && (
        <span className="block text-xs text-red-700 truncate mt-0.5">
          {post.rejection_reason}
        </span>
      )}
    </>
  );
}

export function QueueBoard() {
  const queryClient = useQueryClient();
  const { me, can } = useMe();
  const [tab, setTab] = useState<string>("queue");
  const [composerOpen, setComposerOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SocialPost | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<SocialPost | null>(null);
  const [rejectTarget, setRejectTarget] = useState<SocialPost | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [retryingTargetId, setRetryingTargetId] = useState<string | null>(null);

  const statuses =
    TABS.find((t) => t.value === tab)?.statuses ?? TABS[0].statuses;

  const { data: posts = [], isLoading } = useQuery<SocialPost[]>({
    queryKey: ["social-posts", statuses],
    queryFn: () => listSocialPosts({ status: statuses }),
    refetchInterval: 30000,
  });

  function invalidatePosts() {
    queryClient.invalidateQueries({ queryKey: ["social-posts"] });
  }

  const publishMutation = useMutation({
    mutationFn: (id: string) => publishSocialPostNow(id),
    onSuccess: () => {
      toast.success("Publishing post");
      invalidatePosts();
    },
    onError: (err) =>
      toast.error(
        describeSocialActionFailure(
          err,
          "The post couldn't be sent just now. Try again in a moment."
        )
      ),
  });

  const retryMutation = useMutation({
    mutationFn: ({ post, target }: { post: SocialPost; target: SocialPostTarget }) =>
      retrySocialPostTarget(post.id, target.id),
    onMutate: ({ target }) => setRetryingTargetId(target.id),
    onSettled: () => setRetryingTargetId(null),
    onSuccess: (updated, { target }) => {
      const fresh = updated.targets.find((t) => t.id === target.id);
      if (fresh?.status === "published") {
        toast.success(`Published to ${targetName(fresh)}`);
      } else {
        toast.error(
          describeStoredTargetError(fresh?.error) ??
            `${targetName(target)} still didn't accept the post.`
        );
      }
      invalidatePosts();
    },
    onError: (err, { target }) =>
      toast.error(
        describeSocialActionFailure(
          err,
          `We couldn't retry ${targetName(target)} just now. Try again in a moment.`
        )
      ),
  });

  const submitMutation = useMutation({
    mutationFn: (id: string) => socialWorkflowAction(id, "submit"),
    onSuccess: () => {
      toast.success("Post submitted for review");
      invalidatePosts();
    },
    onError: () => toast.error("Failed to submit post"),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => socialWorkflowAction(id, "approve"),
    onSuccess: () => {
      toast.success("Post approved");
      invalidatePosts();
    },
    onError: () => toast.error("Failed to approve post"),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      socialWorkflowAction(id, "reject", reason),
    onSuccess: () => {
      toast.success("Post rejected");
      setRejectTarget(null);
      setRejectReason("");
      invalidatePosts();
    },
    onError: () => toast.error("Failed to reject post"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSocialPost(id),
    onSuccess: () => {
      toast.success("Post deleted");
      setDeleteTarget(null);
      invalidatePosts();
    },
    onError: () => toast.error("Failed to delete post"),
  });

  function openEdit(post: SocialPost) {
    setEditTarget(post);
    setComposerOpen(true);
  }

  const canPublish = can("content:publish");

  function retryTarget(post: SocialPost, target: SocialPostTarget) {
    retryMutation.mutate({ post, target });
  }

  function targetsFor(post: SocialPost) {
    return (
      <TargetList
        post={post}
        onRetry={(target) => retryTarget(post, target)}
        retryingTargetId={retryingTargetId}
        canRetry={canPublish}
      />
    );
  }

  function actionsFor(post: SocialPost) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Actions"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {EDITABLE_STATUSES.includes(post.status) && (
            <DropdownMenuItem className="gap-2" onClick={() => openEdit(post)}>
              <Edit className="h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {/* "publishing" is offered on purpose: a post parked there by a
              failed channel is exactly the one someone needs to send again.
              The route refuses only while an attempt is actually running. */}
          {canPublish && post.status !== "published" && (
            <DropdownMenuItem
              className="gap-2"
              onClick={() => publishMutation.mutate(post.id)}
            >
              <Send className="h-4 w-4" />
              Publish now
            </DropdownMenuItem>
          )}
          {post.status === "draft" && post.created_by?.id === me?.user.id && (
            <DropdownMenuItem
              className="gap-2"
              onClick={() => submitMutation.mutate(post.id)}
            >
              <Send className="h-4 w-4" />
              Submit for review
            </DropdownMenuItem>
          )}
          {can("content:approve") && post.status === "pending_review" && (
            <DropdownMenuItem
              className="gap-2"
              onClick={() => approveMutation.mutate(post.id)}
            >
              <Check className="h-4 w-4" />
              Approve
            </DropdownMenuItem>
          )}
          {can("content:reject") && post.status === "pending_review" && (
            <DropdownMenuItem
              className="gap-2"
              onClick={() => {
                setRejectReason("");
                setRejectTarget(post);
              }}
            >
              <X className="h-4 w-4" />
              Reject
            </DropdownMenuItem>
          )}
          {can("content:delete") && (
            <DropdownMenuItem
              className="gap-2 text-destructive focus:text-destructive"
              onClick={() => setDeleteTarget(post)}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full overflow-x-auto sm:w-auto">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button
          className="min-h-11 w-full sm:w-auto"
          onClick={() => {
            setEditTarget(undefined);
            setComposerOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          New post
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <div className="rounded-lg border bg-background py-12 text-center">
          <p className="text-sm text-muted-foreground">Nothing here yet</p>
        </div>
      ) : (
        <>
          {/* Phone and small tablet: one card per post. A table this wide can
              only scroll sideways on a narrow screen, which hides the very
              thing a failed post needs you to see. */}
          <ul className="space-y-3 md:hidden">
            {posts.map((post) => (
              <li
                key={post.id}
                className="rounded-lg border bg-background p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 text-sm">
                    <PostSummary post={post} />
                  </div>
                  {actionsFor(post)}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATUS_BADGES[post.status].variant}>
                    {STATUS_BADGES[post.status].label}
                  </Badge>
                  {post.scheduled_at && (
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(post.scheduled_at), "MMM d, yyyy HH:mm")}
                    </span>
                  )}
                  {post.campaign && (
                    <span className="text-xs text-muted-foreground">
                      {post.campaign.name}
                    </span>
                  )}
                </div>
                {targetsFor(post)}
              </li>
            ))}
          </ul>

          <div className="hidden rounded-lg border bg-background md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Post</TableHead>
                  <TableHead className="min-w-[24rem]">Channels</TableHead>
                  <TableHead className="w-36">Campaign</TableHead>
                  <TableHead className="w-40">Scheduled</TableHead>
                  <TableHead className="w-32">Status</TableHead>
                  <TableHead className="w-16 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {posts.map((post) => (
                  <TableRow key={post.id}>
                    <TableCell className="text-sm max-w-xs align-top">
                      <PostSummary post={post} />
                    </TableCell>
                    <TableCell className="align-top">
                      {targetsFor(post)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground align-top">
                      {post.campaign?.name ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground align-top">
                      {post.scheduled_at
                        ? format(new Date(post.scheduled_at), "MMM d, yyyy HH:mm")
                        : "—"}
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant={STATUS_BADGES[post.status].variant}>
                        {STATUS_BADGES[post.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right align-top">
                      {actionsFor(post)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <PostComposer
        post={editTarget}
        open={composerOpen}
        onClose={() => {
          setComposerOpen(false);
          setEditTarget(undefined);
        }}
      />

      {/* Reject dialog */}
      <Dialog
        open={!!rejectTarget}
        onOpenChange={(o) => !o && setRejectTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Post</DialogTitle>
            <DialogDescription>
              Provide a reason so the author knows what to change.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Textarea
              rows={3}
              placeholder="What needs to change?"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setRejectTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={rejectMutation.isPending}
              onClick={() =>
                rejectTarget &&
                rejectMutation.mutate({
                  id: rejectTarget.id,
                  reason: rejectReason,
                })
              }
            >
              {rejectMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Post</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this post? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleteTarget && deleteMutation.mutate(deleteTarget.id)
              }
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** "Thread of 3 posts", "Thread of 2 posts, with a first comment", "With a first comment". */
function partsSummary(parts: SocialPost["parts"]): string {
  const replies = parts.filter((p) => p.kind === "thread").length;
  const comment = parts.some((p) => p.kind === "first_comment");
  if (replies === 0) return "With a first comment";
  return `Thread of ${replies + 1} posts${comment ? ", with a first comment" : ""}`;
}
