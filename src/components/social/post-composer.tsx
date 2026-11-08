"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { Loader2, Send, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { DISABLED_BUTTON, SocialMediaField } from "@/components/social/media-picker";
import {
  editablePart,
  ThreadPartsEditor,
  type EditablePart,
} from "@/components/social/thread-parts-editor";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listChannels,
  listCampaigns,
  createSocialPost,
  updateSocialPost,
  publishSocialPostNow,
  type SocialPostInput,
} from "@/lib/social-api";
import { FailureNotice, type NoticeFailure } from "@/components/ui/failure-notice";
import { useMe } from "@/hooks/use-me";
import { cn } from "@/lib/utils";
import { describeSocialActionFailure, partsOverLimitFailure } from "@/lib/social/publish-errors";
// The limits live on the publish adapters, which the server enforces on save.
// The composer used to keep its own copy of the same five numbers; the counter
// below and the 400 the API answers with must not be able to disagree.
import {
  getAdapter,
  partSupport,
  serviceCharLimit,
  validateAgainstNetworkRules,
} from "@/lib/social/capabilities";
import { normalizeParts } from "@/lib/social/parts";
import { matchLibraryMedia } from "@/lib/social/media";
import { listMedia } from "@/lib/api";
import type {
  SocialChannel,
  SocialCampaign,
  SocialMediaAttachment,
  SocialPost,
} from "@/types/social";

interface PostComposerProps {
  post?: SocialPost;
  open: boolean;
  onClose: () => void;
  /** datetime-local value (yyyy-MM-dd'T'HH:mm) to prefill schedule for new posts */
  initialScheduledAt?: string;
}

export function PostComposer({
  post,
  open,
  onClose,
  initialScheduledAt,
}: PostComposerProps) {
  const queryClient = useQueryClient();
  const { can } = useMe();

  const [body, setBody] = useState("");
  /** What follows the message: thread replies, then a first comment. */
  const [parts, setParts] = useState<EditablePart[]>([]);
  const [link, setLink] = useState("");
  const [media, setMedia] = useState<SocialMediaAttachment[]>([]);
  /** Channels with their own media (punchlist S1). A key present = override
   * on, even with an empty list ("no media on this channel"). */
  const [mediaOverrides, setMediaOverrides] = useState<
    Record<string, SocialMediaAttachment[]>
  >({});
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());
  const [bodyOverrides, setBodyOverrides] = useState<Record<string, string>>(
    {}
  );
  const [expandedOverrides, setExpandedOverrides] = useState<Set<string>>(
    new Set()
  );
  const [campaignId, setCampaignId] = useState<string>("none");
  const [scheduledAt, setScheduledAt] = useState("");
  /**
   * The last refusal from the API, kept in the dialog rather than a toast: the
   * character-limit 400 names a channel and how much to cut, which is too much
   * to read before a toast disappears, and the field to fix it is right here.
   */
  const [failure, setFailure] = useState<NoticeFailure | null>(null);

  useEffect(() => {
    if (!open) return;
    setFailure(null);
    setBody(post?.body ?? "");
    setParts((post?.parts ?? []).map((p) => editablePart(p.kind, p.body)));
    setLink(post?.link ?? "");
    setMedia(post?.media ?? []);
    setChannelIds(new Set(post?.targets.map((t) => t.channel_id) ?? []));
    const overrides: Record<string, string> = {};
    for (const target of post?.targets ?? []) {
      if (target.body_override) overrides[target.channel_id] = target.body_override;
    }
    const ownMedia: Record<string, SocialMediaAttachment[]> = {};
    for (const target of post?.targets ?? []) {
      if (target.media_override) ownMedia[target.channel_id] = target.media_override;
    }
    setBodyOverrides(overrides);
    setMediaOverrides(ownMedia);
    setExpandedOverrides(new Set([...Object.keys(overrides), ...Object.keys(ownMedia)]));
    setCampaignId(post?.campaign?.id ?? "none");
    setScheduledAt(
      post?.scheduled_at
        ? format(new Date(post.scheduled_at), "yyyy-MM-dd'T'HH:mm")
        : (initialScheduledAt ?? "")
    );
  }, [open, post, initialScheduledAt]);

  const { data: channels = [] } = useQuery<SocialChannel[]>({
    queryKey: ["social-channels"],
    queryFn: listChannels,
    enabled: open,
  });

  const { data: campaigns = [] } = useQuery<SocialCampaign[]>({
    queryKey: ["social-campaigns"],
    queryFn: listCampaigns,
    enabled: open,
  });

  const activeChannels = channels.filter((c) => c.status === "active");
  const selectedChannels = activeChannels.filter((c) => channelIds.has(c.id));

  const charLimit = useMemo(() => {
    if (selectedChannels.length === 0) return null;
    return Math.min(...selectedChannels.map((c) => serviceCharLimit(c.service_id)));
  }, [selectedChannels]);

  const overLimit = charLimit !== null && body.length > charLimit;

  // Parts are measured per channel the way each would send them (a reply on
  // X, the whole thread as one post on LinkedIn), and a problem is shown in
  // the same sentence the save would be refused with (partsOverLimitFailure).
  const cleanParts = normalizeParts(parts);
  const threading = selectedChannels.filter((c) => partSupport(c.service_id).threads);
  const commenting = selectedChannels.filter((c) => partSupport(c.service_id).firstComment);
  const threadLimit = threading.length
    ? Math.min(...threading.map((c) => serviceCharLimit(c.service_id)))
    : null;
  const commentLimit = commenting.length
    ? Math.min(...commenting.map((c) => getAdapter(c.service_id)?.firstCommentCharLimit ?? Infinity))
    : null;
  const partNoun =
    threading.length > 0 && threading.every((c) => getAdapter(c.service_id)?.partNoun === "tweet")
      ? "tweet"
      : "post";
  const partProblems =
    cleanParts.length === 0
      ? []
      : selectedChannels.flatMap((c) => {
          const custom = Boolean(bodyOverrides[c.id]?.trim());
          const failure = partsOverLimitFailure({
            channel: c,
            body: custom ? bodyOverrides[c.id] : body,
            parts: cleanParts,
            custom,
            action: "save",
          });
          return failure ? [failure.message] : [];
        });
  const hasThread = cleanParts.some((p) => p.kind === "thread");
  const joinedThreadOn = hasThread
    ? selectedChannels.filter((c) => !partSupport(c.service_id).threads).map((c) => c.service_name)
    : [];
  const joinedCommentOn = cleanParts.some((p) => p.kind === "first_comment")
    ? selectedChannels.filter((c) => !partSupport(c.service_id).firstComment).map((c) => c.service_name)
    : [];

  // Media saved before the library picker carries a url but no library id.
  // Match it to the library row with that url (the same ["media"] cache the
  // picker and the Media page use); what still has no id is flagged in the
  // field and holds the save, since the server refuses anything else.
  const hasLegacyMedia =
    media.some((m) => !m.media_id) ||
    Object.values(mediaOverrides).some((list) => list.some((m) => !m.media_id));
  const { data: library } = useQuery({
    queryKey: ["media"],
    queryFn: listMedia,
    enabled: open && hasLegacyMedia,
  });
  useEffect(() => {
    if (!library) return;
    setMedia((current) => matchLibraryMedia(current, library));
    setMediaOverrides((current) => {
      const next: Record<string, SocialMediaAttachment[]> = {};
      for (const [id, list] of Object.entries(current)) next[id] = matchLibraryMedia(list, library);
      return next;
    });
  }, [library]);
  const selectedMedia = [
    ...media,
    ...selectedChannels.flatMap((c) => mediaOverrides[c.id] ?? []),
  ];
  const unresolvedMedia = selectedMedia.some((m) => !m.media_id);

  // The media rules the server enforces on schedule — the same
  // validateAgainstNetworkRules, run against the media each selected channel
  // would actually send — shown where that media is chosen: the post's own
  // set for every channel that uses it, an override on its own channel.
  const mediaProblems = (channel: SocialChannel, own: SocialMediaAttachment[], isOverride: boolean) => {
    const elsewhere = isOverride ? "" : ", or give that channel its own media";
    return validateAgainstNetworkRules(channel, { body, media: own }).flatMap((v) =>
      v.code === "media_limit"
        ? [`${v.message} Remove some${elsewhere}.`]
        : v.code === "missing_media"
          ? [`${v.message}. Add one${elsewhere}.`]
          : []
    );
  };
  const postMediaProblems = selectedChannels
    .filter((c) => !(c.id in mediaOverrides))
    .flatMap((c) => mediaProblems(c, media, false));
  const overrideProblem = (channel: SocialChannel) =>
    mediaProblems(channel, mediaOverrides[channel.id] ?? [], true);

  const saveMutation = useMutation({
    mutationFn: (input: SocialPostInput) =>
      post ? updateSocialPost(post.id, input) : createSocialPost(input),
    onMutate: () => setFailure(null),
    onSuccess: (_saved, input) => {
      toast.success(
        input.status === "scheduled"
          ? can("content:publish")
            ? "Post scheduled"
            : "Submitted for approval"
          : post
            ? "Post updated"
            : "Draft saved"
      );
      queryClient.invalidateQueries({ queryKey: ["social-posts"] });
      onClose();
    },
    onError: (err) =>
      setFailure({
        message: describeSocialActionFailure(
          err,
          "The post couldn't be saved just now. Try saving it again in a moment."
        ),
        action: "none",
      }),
  });

  const publishNowMutation = useMutation({
    mutationFn: (id: string) => publishSocialPostNow(id),
    onMutate: () => setFailure(null),
    onSuccess: () => {
      toast.success("Publishing post");
      queryClient.invalidateQueries({ queryKey: ["social-posts"] });
      onClose();
    },
    onError: (err) =>
      setFailure({
        message: describeSocialActionFailure(
          err,
          "The post couldn't be sent just now. Try again in a moment."
        ),
        action: "none",
      }),
  });

  function buildInput(status: "draft" | "scheduled"): SocialPostInput {
    const ids = Array.from(channelIds);
    const overrides: Record<string, string> = {};
    for (const id of ids) {
      const value = bodyOverrides[id];
      if (value && value.trim()) overrides[id] = value;
    }
    // Only the library id (and alt) goes up; the server fills url and type
    // from the file. Saving is held while an item has no id (flagged in the
    // field), so none is sent without one.
    const toRef = (m: SocialMediaAttachment) => ({
      media_id: m.media_id as string,
      ...(m.alt ? { alt: m.alt } : {}),
    });
    const ownMedia: Record<string, { media_id: string; alt?: string }[] | null> = {};
    for (const id of ids) {
      ownMedia[id] = id in mediaOverrides ? mediaOverrides[id].map(toRef) : null;
    }
    return {
      body,
      parts: normalizeParts(parts),
      link: link.trim() || null,
      media: media.map(toRef),
      media_overrides: ownMedia,
      scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      campaign_id: campaignId === "none" ? null : campaignId,
      channel_ids: ids,
      body_overrides: overrides,
      status,
    };
  }

  function toggleChannel(id: string) {
    const next = new Set(channelIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChannelIds(next);
  }

  function toggleOverride(id: string) {
    const next = new Set(expandedOverrides);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedOverrides(next);
  }

  const busy = saveMutation.isPending || publishNowMutation.isPending;
  // Saving would send a file with no library id, which the server refuses.
  const blocked = busy || unresolvedMedia;
  const canPublishNow =
    !!post &&
    ["draft", "approved"].includes(post.status) &&
    post.targets.length > 0 &&
    can("content:publish");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[calc(100vw-1rem)] max-h-[92vh] overflow-y-auto p-4 sm:max-w-lg sm:p-6">
        <DialogHeader>
          <DialogTitle>{post ? "Edit Post" : "New Post"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Body */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="social-message">
                {hasThread ? `Message (${partNoun} 1)` : "Message"}
              </Label>
              <span
                className={cn(
                  "text-xs",
                  overLimit ? "font-medium text-red-700 dark:text-red-400" : "text-muted-foreground"
                )}
              >
                {body.length}
                {charLimit !== null && ` / ${charLimit}`}
              </span>
            </div>
            <Textarea
              id="social-message"
              placeholder="What do you want to share?"
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          {/* What follows the message: a thread and a first comment */}
          <div className="space-y-2">
            <ThreadPartsEditor
              parts={parts}
              onChange={setParts}
              threadLimit={threadLimit}
              commentLimit={commentLimit}
              noun={partNoun}
              problems={partProblems}
            />
            {[...new Set([...joinedThreadOn, ...joinedCommentOn])].length > 0 && (
              <p className="text-xs text-muted-foreground">
                {joinedThreadOn.length > 0 &&
                  `${listNames(joinedThreadOn)} ${joinedThreadOn.length === 1 ? "doesn't" : "don't"} post threads, so ${
                    joinedThreadOn.length === 1 ? "it gets" : "they get"
                  } the whole thread as one post. `}
                {joinedCommentOn.length > 0 &&
                  `On ${listNames(joinedCommentOn)} the first comment is added to the end of the post.`}
              </p>
            )}
          </div>

          {/* Link */}
          <div className="space-y-2">
            <Label>Link (optional)</Label>
            <Input
              type="url"
              placeholder="https://..."
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </div>

          {/* Media — files from the org's library only (punchlist S1) */}
          <div className="space-y-2">
            <Label>Images and video</Label>
            <SocialMediaField
              idPrefix="post"
              label="post"
              value={media}
              onChange={setMedia}
              problems={postMediaProblems}
            />
          </div>

          {/* Channels */}
          <div className="space-y-2">
            <Label>Channels</Label>
            {activeChannels.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No active channels. Connect one under Social → Channels.
              </p>
            ) : (
              <div className="rounded-lg border divide-y">
                {activeChannels.map((channel) => {
                  const selected = channelIds.has(channel.id);
                  const expanded = expandedOverrides.has(channel.id);
                  return (
                    <div key={channel.id} className="px-2 py-1">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <Checkbox
                          id={`channel-${channel.id}`}
                          checked={selected}
                          onCheckedChange={() => toggleChannel(channel.id)}
                        />
                        <label
                          htmlFor={`channel-${channel.id}`}
                          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2"
                        >
                          <span className="shrink-0 whitespace-nowrap text-sm font-medium">
                            {channel.service_name}
                          </span>
                          <span className="truncate text-sm text-muted-foreground">
                            {channel.account_name || channel.account_id || ""}
                          </span>
                        </label>
                        {selected && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-11 px-2 text-xs sm:h-8"
                            aria-expanded={expanded}
                            aria-controls={`channel-custom-${channel.id}`}
                            onClick={() => toggleOverride(channel.id)}
                          >
                            {expanded ? (
                              <ChevronDown className="h-3 w-3 mr-1" aria-hidden />
                            ) : (
                              <ChevronRight className="h-3 w-3 mr-1" aria-hidden />
                            )}
                            Customize
                            {(bodyOverrides[channel.id]?.trim() || channel.id in mediaOverrides) && (
                              <span className="ml-1 rounded bg-secondary px-1 text-[11px] text-secondary-foreground">
                                edited
                              </span>
                            )}
                          </Button>
                        )}
                      </div>
                      {selected && expanded && (
                        <div
                          id={`channel-custom-${channel.id}`}
                          className="space-y-3 pb-2 pl-0 sm:pl-6"
                        >
                          <div className="space-y-1.5">
                            <Label htmlFor={`copy-${channel.id}`} className="text-xs text-muted-foreground">
                              Customize copy for {channel.service_name}
                            </Label>
                            <Textarea
                              id={`copy-${channel.id}`}
                              rows={3}
                              placeholder="Leave empty to use the message above"
                              value={bodyOverrides[channel.id] ?? ""}
                              onChange={(e) =>
                                setBodyOverrides({
                                  ...bodyOverrides,
                                  [channel.id]: e.target.value,
                                })
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <div className="flex min-h-11 items-center justify-between gap-3">
                              <Label
                                htmlFor={`own-media-${channel.id}`}
                                className="text-xs font-normal text-muted-foreground"
                              >
                                Customize media for {channel.service_name}
                              </Label>
                              <Switch
                                id={`own-media-${channel.id}`}
                                // 44×44 hit area around the 44×24 track.
                                className="relative before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-['']"
                                checked={channel.id in mediaOverrides}
                                onCheckedChange={(on) => {
                                  const next = { ...mediaOverrides };
                                  // Start from the post's media: the usual
                                  // edit is dropping or reordering a few.
                                  if (on) next[channel.id] = media;
                                  else delete next[channel.id];
                                  setMediaOverrides(next);
                                }}
                              />
                            </div>
                            {channel.id in mediaOverrides && (
                              <SocialMediaField
                                idPrefix={`channel-${channel.id}`}
                                label={`${channel.service_name} post`}
                                value={mediaOverrides[channel.id]}
                                onChange={(next) =>
                                  setMediaOverrides({ ...mediaOverrides, [channel.id]: next })
                                }
                                problems={overrideProblem(channel)}
                              />
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Campaign & schedule */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Campaign</Label>
              <Select value={campaignId} onValueChange={setCampaignId}>
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {campaigns.map((campaign) => (
                    <SelectItem key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Schedule</Label>
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </div>
          </div>
        </div>

        {failure && <FailureNotice failure={failure} className="mt-4" />}

        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {saveMutation.isPending
            ? "Saving…"
            : publishNowMutation.isPending
              ? "Sending…"
              : unresolvedMedia
                ? "Remove the flagged files and pick them again from the media library before saving."
                : ""}
        </p>

        <DialogFooter className="gap-2 sm:gap-0">
          {canPublishNow && (
            <Button
              type="button"
              variant="secondary"
              className={cn("h-11 sm:h-10", DISABLED_BUTTON)}
              disabled={busy}
              aria-busy={publishNowMutation.isPending}
              onClick={() => post && publishNowMutation.mutate(post.id)}
            >
              {publishNowMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Send className="mr-2 h-4 w-4" aria-hidden />
              )}
              Publish now
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className={cn("h-11 sm:h-10", DISABLED_BUTTON)}
            disabled={blocked}
            aria-busy={saveMutation.isPending}
            onClick={() => saveMutation.mutate(buildInput("draft"))}
          >
            {saveMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
            )}
            Save draft
          </Button>
          <Button
            type="button"
            className={cn("h-11 sm:h-10", DISABLED_BUTTON)}
            disabled={blocked || channelIds.size === 0 || !scheduledAt}
            aria-busy={saveMutation.isPending}
            onClick={() => saveMutation.mutate(buildInput("scheduled"))}
          >
            {saveMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
            )}
            {can("content:publish") ? "Schedule" : "Submit for approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "LinkedIn", "LinkedIn and Slack", "LinkedIn, Slack and Reddit". */
function listNames(names: string[]): string {
  const unique = [...new Set(names)];
  return unique.length <= 1
    ? (unique[0] ?? "")
    : `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}
