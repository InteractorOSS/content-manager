"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Sparkles, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { generateContent, listStyleProfiles, ApiError } from "@/lib/api";
import type { StyleProfileSummary, BlogRevision, GeneratePolishResult } from "@/types/ai";

// "Finalize with AI": polish the saved draft in the author's voice and show
// a before/after view. Nothing is written until the author applies it.
export function AiFinalizeDialog({
  postId,
  currentTitle,
  currentHtml,
  onApply,
  onClose,
}: {
  postId: string;
  currentTitle: string;
  currentHtml: string;
  onApply: (revision: BlogRevision, styleProfileId: string | null) => void;
  onClose: () => void;
}) {
  const [profileId, setProfileId] = useState<string>("");
  const [instructions, setInstructions] = useState("");
  const [revision, setRevision] = useState<BlogRevision | null>(null);

  const { data: profiles = [] } = useQuery<StyleProfileSummary[]>({
    queryKey: ["style-profiles"],
    queryFn: listStyleProfiles,
  });
  const usable = profiles.filter((p) => p.guide_count > 0 && p.status !== "archived");

  const mutation = useMutation({
    mutationFn: () =>
      generateContent({
        source: { type: "post", post_id: postId },
        style_profile_id: profileId || undefined,
        mode: "polish",
        instructions: instructions || undefined,
      }),
    onSuccess: (result) => {
      setRevision((result as GeneratePolishResult).revision);
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Polish failed"),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={revision ? "max-w-5xl max-h-[85vh] overflow-y-auto" : undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Finalize with AI
          </DialogTitle>
          <DialogDescription>
            {revision
              ? "Review the revision — your saved draft stays untouched until you apply."
              : "Polishes your saved draft in your voice: substance and facts preserved, prose improved."}
          </DialogDescription>
        </DialogHeader>

        {!revision ? (
          <>
            <div className="space-y-2">
              <Label>Writing style</Label>
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger>
                  <SelectValue placeholder={usable.length ? "Pick a style profile" : "No style profiles with a guide yet"} />
                </SelectTrigger>
                <SelectContent>
                  {usable.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      {p.scope === "org" ? " (brand)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="finalize-instructions">Instructions (optional)</Label>
              <Input
                id="finalize-instructions"
                placeholder="e.g. tighten the intro; keep it under 600 words"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
                {mutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Polishing…
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Polish draft
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {revision.title !== currentTitle && (
              <p className="text-sm">
                <span className="text-muted-foreground">Title:</span>{" "}
                <span className="line-through text-muted-foreground">{currentTitle}</span>{" "}
                → <span className="font-medium">{revision.title}</span>
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1.5">Current</p>
                <div
                  className="rounded-lg border bg-muted/20 p-3 text-sm max-h-[50vh] overflow-y-auto prose-sm"
                  dangerouslySetInnerHTML={{ __html: currentHtml }}
                />
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1.5">Revision</p>
                <div
                  className="rounded-lg border bg-background p-3 text-sm max-h-[50vh] overflow-y-auto prose-sm"
                  dangerouslySetInnerHTML={{ __html: revision.content_html }}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRevision(null)}>
                Back
              </Button>
              <Button variant="outline" onClick={onClose}>
                Discard
              </Button>
              <Button
                onClick={() => {
                  onApply(revision, profileId || null);
                  onClose();
                  toast.success("Revision applied — review and save when ready");
                }}
              >
                <Check className="mr-2 h-4 w-4" />
                Apply revision
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
