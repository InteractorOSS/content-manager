"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Link2,
  FileText,
  Upload,
  MessageCircleQuestion,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  listStyleProfiles,
  createStyleProfile,
  getStyleProfile,
  updateStyleProfile,
  deleteStyleProfile,
  addStyleSample,
  updateStyleSample,
  deleteStyleSample,
  analyzeStyleProfile,
  listPosts,
  listGuideSuggestions,
  resolveGuideSuggestion,
  ApiError,
} from "@/lib/api";
import { useMe } from "@/hooks/use-me";
import type {
  StyleProfileSummary,
  StyleProfileDetail,
  GuideAmendmentSuggestionView,
} from "@/types/ai";
import type { Post } from "@/types/cms";

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

export function StyleProfilesManager() {
  const queryClient = useQueryClient();
  const { can } = useMe();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState("user");

  const { data: profiles = [], isLoading } = useQuery<StyleProfileSummary[]>({
    queryKey: ["style-profiles"],
    queryFn: listStyleProfiles,
  });

  const createMutation = useMutation({
    mutationFn: () => createStyleProfile({ name: newName, scope: newScope }),
    onSuccess: (created) => {
      toast.success("Profile created");
      setCreateOpen(false);
      setNewName("");
      setNewScope("user");
      queryClient.invalidateQueries({ queryKey: ["style-profiles"] });
      setSelectedId(created.id);
    },
    onError: (e) => toast.error(errMsg(e, "Failed to create profile")),
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New profile
        </Button>
      </div>

      {profiles.length === 0 ? (
        <div className="rounded-lg border bg-background p-10 text-center">
          <Sparkles className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">No style profiles yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Create one and add a few pieces of writing whose style you like
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className="rounded-lg border bg-background p-4 text-left hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{p.name}</p>
                <div className="flex gap-1">
                  {p.pending_suggestion_count > 0 && (
                    <Badge variant="warning" className="text-xs">
                      {p.pending_suggestion_count} suggestion
                      {p.pending_suggestion_count === 1 ? "" : "s"}
                    </Badge>
                  )}
                  {p.scope === "org" && (
                    <Badge variant="info" className="text-xs">Brand</Badge>
                  )}
                  <Badge
                    variant={p.status === "active" ? "success" : p.status === "archived" ? "muted" : "warning"}
                    className="text-xs capitalize"
                  >
                    {p.status}
                  </Badge>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                {p.sample_count} {p.sample_count === 1 ? "sample" : "samples"} ·{" "}
                {p.guide_count > 0 ? `guide v${p.guide_count}` : "no guide yet"}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New style profile</DialogTitle>
            <DialogDescription>
              A profile holds writing samples and the distilled style guide.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                placeholder="My voice"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            {can("admin:settings") && (
              <div className="space-y-2">
                <Label>Scope</Label>
                <Select value={newScope} onValueChange={setNewScope}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Personal</SelectItem>
                    <SelectItem value="org">Organization (brand voice)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !newName.trim()}
            >
              {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      {selectedId && (
        <ProfileDetail id={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function ProfileDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [guideDraft, setGuideDraft] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);

  const { data: profile, isLoading } = useQuery<StyleProfileDetail>({
    queryKey: ["style-profile", id],
    queryFn: () => getStyleProfile(id),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["style-profile", id] });
    queryClient.invalidateQueries({ queryKey: ["style-profiles"] });
  };

  const analyzeMutation = useMutation({
    mutationFn: () => analyzeStyleProfile(id),
    onSuccess: (result) => {
      toast.success(`Style guide v${result.version} generated`);
      setViewVersion(null);
      setGuideDraft(null);
      invalidate();
    },
    onError: (e) => toast.error(errMsg(e, "Analysis failed")),
  });

  const saveGuideMutation = useMutation({
    mutationFn: (guide: string) => updateStyleProfile(id, { guide }),
    onSuccess: () => {
      toast.success("Guide saved as a new version");
      setGuideDraft(null);
      setViewVersion(null);
      invalidate();
    },
    onError: (e) => toast.error(errMsg(e, "Failed to save guide")),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteStyleProfile(id),
    onSuccess: () => {
      toast.success("Profile deleted");
      onClose();
      queryClient.invalidateQueries({ queryKey: ["style-profiles"] });
    },
    onError: (e) => toast.error(errMsg(e, "Failed to delete profile")),
  });

  const noteMutation = useMutation({
    mutationFn: ({ sampleId, notes }: { sampleId: string; notes: string }) =>
      updateStyleSample(id, sampleId, { liked_notes: notes }),
    onSuccess: () => {
      toast.success("Noted — re-run analysis to fold it into the guide");
      invalidate();
    },
    onError: (e) => toast.error(errMsg(e, "Failed to save notes")),
  });

  const removeSampleMutation = useMutation({
    mutationFn: (sampleId: string) => deleteStyleSample(id, sampleId),
    onSuccess: invalidate,
    onError: (e) => toast.error(errMsg(e, "Failed to remove sample")),
  });

  const { data: suggestions = [] } = useQuery<GuideAmendmentSuggestionView[]>({
    queryKey: ["guide-suggestions", id],
    queryFn: () => listGuideSuggestions(id),
  });

  const resolveMutation = useMutation({
    mutationFn: ({
      suggestionId,
      action,
    }: {
      suggestionId: string;
      action: "accept" | "reject";
    }) => resolveGuideSuggestion(id, suggestionId, action),
    onSuccess: (_, { action }) => {
      toast.success(
        action === "accept" ? "Guide updated with the suggestion" : "Suggestion dismissed"
      );
      queryClient.invalidateQueries({ queryKey: ["guide-suggestions", id] });
      invalidate();
    },
    onError: (e) => toast.error(errMsg(e, "Failed to resolve suggestion")),
  });

  const latest = profile?.guides[0] ?? null;
  const shown =
    viewVersion !== null
      ? profile?.guides.find((g) => g.version === viewVersion) ?? latest
      : latest;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        {isLoading || !profile ? (
          <div className="space-y-3 py-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {profile.name}
                {profile.scope === "org" && (
                  <Badge variant="info" className="text-xs">Brand voice</Badge>
                )}
              </DialogTitle>
              <DialogDescription>
                Add samples, note what you like about each, then generate the guide.
              </DialogDescription>
            </DialogHeader>

            {/* Samples */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Writing samples</h3>
                {profile.can_manage && (
                  <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add sample
                  </Button>
                )}
              </div>
              {profile.samples.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  No samples yet — add a link, paste text, or pick a published post.
                </p>
              ) : (
                <div className="space-y-2">
                  {profile.samples.map((s) => (
                    <SampleRow
                      key={s.id}
                      sample={s}
                      canManage={profile.can_manage}
                      onSaveNotes={(notes) =>
                        noteMutation.mutate({ sampleId: s.id, notes })
                      }
                      onRemove={() => removeSampleMutation.mutate(s.id)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Suggested improvements (Phase D: continuous learning) */}
            {suggestions.length > 0 && (
              <div className="space-y-2 mt-2">
                <h3 className="text-sm font-semibold">Suggested improvements</h3>
                <div className="space-y-2">
                  {suggestions.map((s) => (
                    <div key={s.id} className="rounded-lg border bg-background p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm">{s.diff_summary}</p>
                          <p className="text-xs text-muted-foreground mt-1">{s.rationale}</p>
                          {s.post && (
                            <p className="text-xs text-muted-foreground mt-1">
                              From: <span className="font-medium">{s.post.title}</span>
                            </p>
                          )}
                        </div>
                      </div>
                      {profile.can_manage && (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resolveMutation.isPending}
                            onClick={() =>
                              resolveMutation.mutate({ suggestionId: s.id, action: "reject" })
                            }
                          >
                            Dismiss
                          </Button>
                          <Button
                            size="sm"
                            disabled={resolveMutation.isPending}
                            onClick={() =>
                              resolveMutation.mutate({ suggestionId: s.id, action: "accept" })
                            }
                          >
                            {resolveMutation.isPending ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            Accept into guide
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Guide */}
            <div className="space-y-2 mt-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Style guide</h3>
                <div className="flex items-center gap-2">
                  {profile.guides.length > 1 && (
                    <Select
                      value={String(shown?.version ?? "")}
                      onValueChange={(v) => {
                        setViewVersion(Number(v));
                        setGuideDraft(null);
                      }}
                    >
                      <SelectTrigger className="h-8 w-28 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {profile.guides.map((g) => (
                          <SelectItem key={g.id} value={String(g.version)}>
                            v{g.version} · {g.created_by}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {profile.can_manage && (
                    <Button
                      size="sm"
                      onClick={() => analyzeMutation.mutate()}
                      disabled={analyzeMutation.isPending || profile.samples.length === 0}
                    >
                      {analyzeMutation.isPending ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {latest ? "Re-analyze" : "Generate guide"}
                    </Button>
                  )}
                </div>
              </div>
              {analyzeMutation.isPending && (
                <p className="text-xs text-muted-foreground">
                  Reading your samples and distilling the guide — this can take a minute…
                </p>
              )}
              {shown ? (
                guideDraft !== null ? (
                  <div className="space-y-2">
                    <Textarea
                      value={guideDraft}
                      onChange={(e) => setGuideDraft(e.target.value)}
                      rows={16}
                      className="font-mono text-xs"
                    />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setGuideDraft(null)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => saveGuideMutation.mutate(guideDraft)}
                        disabled={saveGuideMutation.isPending}
                      >
                        {saveGuideMutation.isPending && (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        )}
                        Save as new version
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <pre className="rounded-lg border bg-muted/30 p-4 text-xs whitespace-pre-wrap max-h-80 overflow-y-auto">
                      {shown.guide}
                    </pre>
                    {profile.can_manage && (
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setGuideDraft(shown.guide)}>
                          Edit guide
                        </Button>
                      </div>
                    )}
                  </div>
                )
              ) : (
                <p className="text-xs text-muted-foreground py-2">
                  No guide yet — add samples and generate one.
                </p>
              )}
            </div>

            {profile.can_manage && (
              <DialogFooter className="mt-2">
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive mr-auto"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Delete profile
                </Button>
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
              </DialogFooter>
            )}
          </>
        )}
        {addOpen && (
          <AddSampleDialog
            profileId={id}
            onClose={() => setAddOpen(false)}
            onAdded={() => {
              setAddOpen(false);
              invalidate();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SampleRow({
  sample,
  canManage,
  onSaveNotes,
  onRemove,
}: {
  sample: StyleProfileDetail["samples"][number];
  canManage: boolean;
  onSaveNotes: (notes: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(sample.liked_notes ?? "");

  const Icon =
    sample.source_type === "url" ? Link2 : sample.source_type === "post" ? FileText : Upload;

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <p className="text-sm font-medium truncate">
              {sample.title ?? sample.source_ref ?? "Untitled sample"}
            </p>
            <span className="text-xs text-muted-foreground shrink-0">
              {Math.round(sample.text_length / 1000)}k chars
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {sample.text_preview}
          </p>
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="What do you like about this?"
              onClick={() => setEditing((v) => !v)}
            >
              <MessageCircleQuestion className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              title="Remove sample"
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      {(editing || sample.liked_notes) && (
        <div className="mt-2 space-y-2">
          {editing ? (
            <>
              <Textarea
                placeholder="What do you like about this piece? (e.g. the short punchy openers, the dry humor, no buzzwords)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="text-xs"
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    onSaveNotes(notes);
                    setEditing(false);
                  }}
                >
                  Save
                </Button>
              </div>
            </>
          ) : (
            <p className="text-xs rounded bg-muted/40 px-2 py-1.5">
              <span className="font-medium">You like:</span> {sample.liked_notes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AddSampleDialog({
  profileId,
  onClose,
  onAdded,
}: {
  profileId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [tab, setTab] = useState("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [postId, setPostId] = useState("");
  const [likedNotes, setLikedNotes] = useState("");

  const { data: posts = [] } = useQuery<Post[]>({
    queryKey: ["posts"],
    queryFn: () => listPosts(),
    enabled: tab === "post",
  });

  const addMutation = useMutation({
    mutationFn: () =>
      addStyleSample(profileId, {
        source_type: tab,
        url: tab === "url" ? url : undefined,
        text: tab === "text" ? text : undefined,
        post_id: tab === "post" ? postId : undefined,
        title: title || undefined,
        liked_notes: likedNotes || undefined,
      }),
    onSuccess: () => {
      toast.success("Sample added");
      onAdded();
    },
    onError: (e) => toast.error(errMsg(e, "Failed to add sample")),
  });

  const ready =
    (tab === "url" && url.trim()) ||
    (tab === "text" && text.trim().length >= 200) ||
    (tab === "post" && postId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a writing sample</DialogTitle>
          <DialogDescription>
            Provide writing whose style you like — yours or anyone&apos;s.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="url">Link</TabsTrigger>
            <TabsTrigger value="text">Paste text</TabsTrigger>
            <TabsTrigger value="post">From a post</TabsTrigger>
          </TabsList>
          <TabsContent value="url" className="space-y-2 mt-3">
            <Label htmlFor="sample-url">URL</Label>
            <Input
              id="sample-url"
              placeholder="https://example.com/an-article-you-love"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </TabsContent>
          <TabsContent value="text" className="space-y-2 mt-3">
            <Label htmlFor="sample-text">Text (min ~200 characters)</Label>
            <Textarea
              id="sample-text"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </TabsContent>
          <TabsContent value="post" className="space-y-2 mt-3">
            <Label>Post</Label>
            <Select value={postId} onValueChange={setPostId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a post" />
              </SelectTrigger>
              <SelectContent>
                {posts.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title || "(untitled)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TabsContent>
        </Tabs>
        <div className="space-y-2">
          <Label htmlFor="sample-title">Title (optional)</Label>
          <Input
            id="sample-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sample-notes">What do you like about it? (optional, but powerful)</Label>
          <Textarea
            id="sample-notes"
            rows={2}
            placeholder="e.g. confident but never salesy; short paragraphs; concrete examples over adjectives"
            value={likedNotes}
            onChange={(e) => setLikedNotes(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => addMutation.mutate()} disabled={!ready || addMutation.isPending}>
            {addMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add sample
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
