"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listSocialPosts } from "@/lib/social-api";
import { cn, truncate } from "@/lib/utils";
import type { SocialPost, SocialPostStatus } from "@/types/social";
import { PostComposer } from "@/components/social/post-composer";

const STATUS_COLORS: Record<SocialPostStatus, string> = {
  draft: "#f59e0b",
  pending_review: "#0ea5e9",
  approved: "#8b5cf6",
  rejected: "#ef4444",
  scheduled: "#3b82f6",
  publishing: "#0ea5e9",
  awaiting_manual: "#f59e0b",
  published: "#22c55e",
  partially_published: "#f59e0b",
  failed: "#ef4444",
  archived: "#9ca3af",
};

export function SocialCalendar() {
  const [month, setMonth] = useState<Date>(() => new Date());
  const [composerOpen, setComposerOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SocialPost | undefined>();
  const [initialScheduledAt, setInitialScheduledAt] = useState<
    string | undefined
  >();

  const gridStart = startOfWeek(startOfMonth(month));
  const gridEnd = endOfWeek(endOfMonth(month));
  const from = gridStart.toISOString();
  const to = gridEnd.toISOString();

  const days = useMemo(
    () => eachDayOfInterval({ start: gridStart, end: gridEnd }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [from, to]
  );

  const { data: posts = [], isLoading } = useQuery<SocialPost[]>({
    queryKey: ["social-posts", "calendar", from, to],
    queryFn: () => listSocialPosts({ from, to }),
  });

  const scheduledPosts = posts.filter((p) => p.scheduled_at);

  function postsForDay(day: Date) {
    return scheduledPosts.filter((p) =>
      isSameDay(new Date(p.scheduled_at!), day)
    );
  }

  function openNew(day: Date) {
    setEditTarget(undefined);
    setInitialScheduledAt(format(day, "yyyy-MM-dd'T'10:00"));
    setComposerOpen(true);
  }

  function openEdit(post: SocialPost) {
    setInitialScheduledAt(undefined);
    setEditTarget(post);
    setComposerOpen(true);
  }

  const weekdays = days.slice(0, 7).map((d) => format(d, "EEE"));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{format(month, "MMMM yyyy")}</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label="Previous month"
            onClick={() => setMonth(subMonths(month, 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setMonth(new Date())}
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label="Next month"
            onClick={() => setMonth(addMonths(month, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-[480px] w-full" />
      ) : (
        <div className="rounded-lg border bg-background overflow-hidden">
          {/* Weekday header */}
          <div className="grid grid-cols-7 border-b bg-muted/50">
            {weekdays.map((day) => (
              <div
                key={day}
                className="px-2 py-1.5 text-xs font-medium text-muted-foreground text-center"
              >
                {day}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const dayPosts = postsForDay(day);
              return (
                <div
                  key={day.toISOString()}
                  className={cn(
                    "min-h-28 max-h-36 overflow-y-auto border-b border-r p-1.5 cursor-pointer hover:bg-accent/30 transition-colors",
                    !isSameMonth(day, month) && "bg-muted/30"
                  )}
                  onClick={() => openNew(day)}
                >
                  <span
                    className={cn(
                      "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs",
                      isToday(day)
                        ? "bg-primary text-primary-foreground font-semibold"
                        : isSameMonth(day, month)
                          ? "text-foreground"
                          : "text-muted-foreground"
                    )}
                  >
                    {format(day, "d")}
                  </span>
                  <div className="mt-1 space-y-1">
                    {dayPosts.map((post) => (
                      <button
                        key={post.id}
                        type="button"
                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit(post);
                        }}
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor:
                              post.campaign?.color ||
                              STATUS_COLORS[post.status],
                          }}
                        />
                        <span className="truncate">
                          {truncate(post.body, 40) || "(Empty)"}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <PostComposer
        post={editTarget}
        open={composerOpen}
        onClose={() => {
          setComposerOpen(false);
          setEditTarget(undefined);
          setInitialScheduledAt(undefined);
        }}
        initialScheduledAt={initialScheduledAt}
      />
    </div>
  );
}
