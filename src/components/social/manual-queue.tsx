"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { listManualQueue, markManualPosted } from "@/lib/social-api";
import type { ManualQueueItem } from "@/types/social";

/**
 * G#27: the manual-delivery queue — every SocialPostTarget awaiting a human
 * to paste its copy onto the real platform themselves (a delivery_mode
 * "manual" channel, e.g. a personal Facebook profile with no API access at
 * all). Shows the ready-to-paste copy + media for each; "Mark posted"
 * records the permalink, if the platform gave the human one back.
 */
export function ManualQueue() {
  const queryClient = useQueryClient();
  const [markTarget, setMarkTarget] = useState<ManualQueueItem | null>(null);
  const [externalUrl, setExternalUrl] = useState("");

  const { data: items = [], isLoading } = useQuery<ManualQueueItem[]>({
    queryKey: ["social-manual-queue"],
    queryFn: listManualQueue,
    refetchInterval: 30000,
  });

  const markMutation = useMutation({
    mutationFn: (input: { targetId: string; externalUrl: string }) =>
      markManualPosted(input.targetId, { external_url: input.externalUrl.trim() || undefined }),
    onSuccess: () => {
      toast.success("Marked posted");
      setMarkTarget(null);
      setExternalUrl("");
      queryClient.invalidateQueries({ queryKey: ["social-manual-queue"] });
      queryClient.invalidateQueries({ queryKey: ["social-posts"] });
    },
    onError: () => toast.error("Failed to mark posted"),
  });

  async function copyBody(item: ManualQueueItem) {
    try {
      await navigator.clipboard.writeText(item.paste_text);
      toast.success("Copied");
    } catch {
      toast.error("Failed to copy");
    }
  }

  function openMark(item: ManualQueueItem) {
    setMarkTarget(item);
    setExternalUrl("");
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border bg-background py-12 text-center">
        <p className="text-sm text-muted-foreground">
          Nothing waiting on a manual post right now
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {items.map((item) => {
        const body = item.effective_body;
        return (
          <Card key={item.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {item.channel.service_name}
                  {item.channel.account_name ? ` · ${item.channel.account_name}` : ""}
                </Badge>
                {item.post.campaign && (
                  <Badge variant="secondary">{item.post.campaign.name}</Badge>
                )}
                {item.post.scheduled_at && (
                  <span className="text-xs text-muted-foreground">
                    Scheduled for {format(new Date(item.post.scheduled_at), "MMM d, yyyy HH:mm")}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={() => copyBody(item)}>
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                  Copy
                </Button>
                <Button size="sm" onClick={() => openMark(item)}>
                  <Check className="h-3.5 w-3.5 mr-1.5" />
                  Mark posted
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm whitespace-pre-wrap">{body || "(Empty)"}</p>
              {item.post.link && (
                <a
                  href={item.post.link}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  {item.post.link}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {item.post.media.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {item.post.media.map((m, i) => (
                    <img
                      key={i}
                      src={m.url}
                      alt={m.alt || ""}
                      className="h-20 w-20 rounded object-cover border"
                    />
                  ))}
                </div>
              )}
              {item.post.source_post && (
                <p className="text-xs text-muted-foreground">
                  From: {item.post.source_post.title}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={!!markTarget} onOpenChange={(o) => !o && setMarkTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark posted</DialogTitle>
            <DialogDescription>
              Once you've pasted this onto {markTarget?.channel.service_name}, record the
              link the platform gave you back, if it gave you one.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Permalink (optional)</Label>
            <Input
              placeholder="https://facebook.com/..."
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMarkTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={markMutation.isPending}
              onClick={() =>
                markTarget &&
                markMutation.mutate({ targetId: markTarget.id, externalUrl })
              }
            >
              {markMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Mark posted
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
