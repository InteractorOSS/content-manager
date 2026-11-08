"use client";

import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronUp, ChevronDown, Bell, BellOff, Loader2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listMyBuildFeedback,
  voteBuildFeedback,
  setBuildFeedbackFollow,
  type BuildFeedbackItem,
  type BuildFeedbackItemType,
} from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

const TYPE_LABELS: Record<BuildFeedbackItemType, string> = {
  feedback: "Feedback",
  idea: "Idea",
  ticket: "Ticket",
};

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (s === "open") return <Badge variant="outline">Open</Badge>;
  if (s === "closed" || s === "resolved" || s === "dismissed")
    return <Badge variant="muted">{status}</Badge>;
  if (s === "promoted" || s === "converted" || s === "acknowledged")
    return <Badge variant="success">{status}</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export function MyFeedbackList() {
  const queryClient = useQueryClient();
  const [type, setType] = useState<BuildFeedbackItemType | "all">("all");
  const [sort, setSort] = useState<"date" | "status" | "votes">("date");
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  const queryKey = ["build-feedback", type, sort, order];

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey,
      queryFn: ({ pageParam }: { pageParam?: string }) =>
        listMyBuildFeedback({
          type: type === "all" ? undefined : type,
          sort,
          order,
          cursor: pageParam,
        }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.pagination.nextCursor ?? undefined,
    });

  const items = data?.pages.flatMap((p) => p.items) ?? [];

  const voteMutation = useMutation({
    mutationFn: ({ item, value }: { item: BuildFeedbackItem; value: -1 | 0 | 1 }) =>
      voteBuildFeedback(item.type, item.id, value),
    onError: () => toast.error("Failed to update vote"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["build-feedback"] }),
  });

  const followMutation = useMutation({
    mutationFn: ({ item, follow }: { item: BuildFeedbackItem; follow: boolean }) =>
      setBuildFeedbackFollow(item.type, item.id, follow),
    onError: () => toast.error("Failed to update follow"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["build-feedback"] }),
  });

  function toggleVote(item: BuildFeedbackItem, direction: 1 | -1) {
    const next = item.viewerVote === direction ? 0 : direction;
    voteMutation.mutate({ item, value: next });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={type} onValueChange={(v) => setType(v as BuildFeedbackItemType | "all")}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="feedback">Feedback</TabsTrigger>
            <TabsTrigger value="idea">Ideas</TabsTrigger>
            <TabsTrigger value="ticket">Tickets</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date">Date</SelectItem>
              <SelectItem value="status">Status</SelectItem>
              <SelectItem value="votes">Votes</SelectItem>
            </SelectContent>
          </Select>
          <Select value={order} onValueChange={(v) => setOrder(v as typeof order)}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">Newest</SelectItem>
              <SelectItem value="asc">Oldest</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t load your submissions right now — please try again later.
        </p>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          You haven&apos;t submitted any feedback, ideas, or tickets yet.
        </p>
      )}

      <div className="space-y-3">
        {items.map((item) => (
          <div key={`${item.type}-${item.id}`} className="rounded-lg border p-4 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {TYPE_LABELS[item.type]}
                  </Badge>
                  <StatusBadge status={item.status} />
                </div>
                <p className="font-medium text-sm">{item.title}</p>
                {item.body && (
                  <p className="text-sm text-muted-foreground line-clamp-2">{item.body}</p>
                )}
              </div>

              <div className="flex flex-col items-end gap-2 shrink-0">
                <div className="flex items-center gap-1">
                  {item.type !== "ticket" && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`h-7 w-7 ${item.viewerVote === 1 ? "text-primary" : ""}`}
                        onClick={() => toggleVote(item, 1)}
                        disabled={voteMutation.isPending}
                      >
                        <ChevronUp className="h-4 w-4" />
                      </Button>
                      <span className="text-xs tabular-nums w-5 text-center">{item.voteCount}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`h-7 w-7 ${item.viewerVote === -1 ? "text-destructive" : ""}`}
                        onClick={() => toggleVote(item, -1)}
                        disabled={voteMutation.isPending}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-7 w-7 ${item.followed ? "text-primary" : ""}`}
                    title={item.followed ? "Unfollow" : "Follow"}
                    onClick={() =>
                      followMutation.mutate({ item, follow: !item.followed })
                    }
                    disabled={followMutation.isPending}
                  >
                    {item.followed ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{formatDateTime(item.createdAt)}</span>
              {item.commentCount > 0 && (
                <span className="flex items-center gap-1">
                  <MessageCircle className="h-3 w-3" />
                  {item.commentCount}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" size="sm" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
