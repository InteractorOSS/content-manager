"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Share2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type {
  StyleProfileSummary,
  GenerateCreateResult,
  SocialGenerateFormat,
} from "@/types/ai";

const NETWORK_OPTIONS: { value: SocialGenerateFormat; label: string }[] = [
  { value: "linkedin", label: "LinkedIn" },
  { value: "twitter", label: "X (Twitter)" },
  { value: "facebook", label: "Facebook" },
];

// "Social drafts with AI": fan the saved post out into per-network copy.
// Drafts land in the social queue (draft status) linked back to this post;
// the social approval → schedule → publish pipeline takes it from there.
export function AiSocialFanoutDialog({
  postId,
  onClose,
}: {
  postId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [networks, setNetworks] = useState<SocialGenerateFormat[]>([
    "linkedin",
    "twitter",
  ]);
  const [profileId, setProfileId] = useState<string>("");
  const [instructions, setInstructions] = useState("");

  const { data: profiles = [] } = useQuery<StyleProfileSummary[]>({
    queryKey: ["style-profiles"],
    queryFn: listStyleProfiles,
  });
  const usable = profiles.filter((p) => p.guide_count > 0 && p.status !== "archived");

  function toggleNetwork(network: SocialGenerateFormat, checked: boolean) {
    setNetworks((prev) =>
      checked ? [...prev, network] : prev.filter((n) => n !== network)
    );
  }

  const mutation = useMutation({
    mutationFn: () =>
      generateContent({
        source: { type: "post", post_id: postId },
        style_profile_id: profileId || undefined,
        mode: "create",
        formats: networks,
        instructions: instructions || undefined,
      }),
    onSuccess: (result) => {
      const created = result as GenerateCreateResult;
      const count = created.social_posts.length;
      toast.success(`${count} social draft${count > 1 ? "s" : ""} created`);
      onClose();
      router.push("/social/queue");
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Generation failed"),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            Social drafts with AI
          </DialogTitle>
          <DialogDescription>
            Writes per-network copy from this post in your voice. Drafts land
            in the social queue for review — nothing is scheduled or published.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label>Networks</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {NETWORK_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 text-sm cursor-pointer"
              >
                <Checkbox
                  checked={networks.includes(opt.value)}
                  onCheckedChange={(checked) => toggleNetwork(opt.value, checked === true)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

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
          <Label htmlFor="fanout-instructions">Instructions (optional)</Label>
          <Input
            id="fanout-instructions"
            placeholder="e.g. lead with the benchmark numbers; tag it #devtools"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={networks.length === 0 || mutation.isPending}
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Writing…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Generate drafts
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
