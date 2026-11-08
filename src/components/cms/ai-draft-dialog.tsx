"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Checkbox } from "@/components/ui/checkbox";
import { generateContent, listStyleProfiles, ApiError } from "@/lib/api";
import type {
  StyleProfileSummary,
  GenerateCreateResult,
  GenerateFormat,
} from "@/types/ai";

const FORMAT_OPTIONS: { value: GenerateFormat; label: string }[] = [
  { value: "blog", label: "Blog post" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "twitter", label: "X (Twitter)" },
  { value: "facebook", label: "Facebook" },
];

// "Draft with AI": rewrite a link or pasted material into a draft blog post
// in the selected voice. The result lands in the normal editor as a draft.
export function AiDraftDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [tab, setTab] = useState("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [profileId, setProfileId] = useState<string>("");
  const [instructions, setInstructions] = useState("");
  const [formats, setFormats] = useState<GenerateFormat[]>(["blog"]);

  function toggleFormat(format: GenerateFormat, checked: boolean) {
    setFormats((prev) =>
      checked ? [...prev, format] : prev.filter((f) => f !== format)
    );
  }

  const { data: profiles = [] } = useQuery<StyleProfileSummary[]>({
    queryKey: ["style-profiles"],
    queryFn: listStyleProfiles,
  });
  const usable = profiles.filter((p) => p.guide_count > 0 && p.status !== "archived");

  const mutation = useMutation({
    mutationFn: () =>
      generateContent({
        source:
          tab === "url"
            ? { type: "url", url }
            : { type: "text", text },
        style_profile_id: profileId || undefined,
        mode: "create",
        formats,
        instructions: instructions || undefined,
      }),
    onSuccess: (result) => {
      const created = result as GenerateCreateResult;
      const socialCount = created.social_posts.length;
      onClose();
      if (created.post) {
        toast.success(
          `Draft created: ${created.post.title}` +
            (socialCount ? ` (+${socialCount} social draft${socialCount > 1 ? "s" : ""})` : "")
        );
        router.push(`/posts/${created.post.slug}/edit`);
      } else {
        toast.success(`${socialCount} social draft${socialCount > 1 ? "s" : ""} created`);
        router.push("/social/queue");
      }
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Generation failed"),
  });

  const ready =
    formats.length > 0 &&
    ((tab === "url" && url.trim()) || (tab === "text" && text.trim().length >= 100));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Draft with AI
          </DialogTitle>
          <DialogDescription>
            Give it source material — a link or pasted notes/article — and it
            writes a draft blog post in your voice.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="url">From a link</TabsTrigger>
            <TabsTrigger value="text">From text/notes</TabsTrigger>
          </TabsList>
          <TabsContent value="url" className="space-y-2 mt-3">
            <Label htmlFor="ai-url">URL</Label>
            <Input
              id="ai-url"
              placeholder="https://example.com/article-to-rewrite"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </TabsContent>
          <TabsContent value="text" className="space-y-2 mt-3">
            <Label htmlFor="ai-text">Source material</Label>
            <Textarea
              id="ai-text"
              rows={6}
              placeholder="Paste an article, meeting notes, bullet points…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </TabsContent>
        </Tabs>

        <div className="space-y-2">
          <Label>Formats</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {FORMAT_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 text-sm cursor-pointer"
              >
                <Checkbox
                  checked={formats.includes(opt.value)}
                  onCheckedChange={(checked) => toggleFormat(opt.value, checked === true)}
                />
                {opt.label}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Social formats create drafts in the social queue, linked to the blog post.
          </p>
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
          <Label htmlFor="ai-instructions">Instructions (optional)</Label>
          <Input
            id="ai-instructions"
            placeholder="e.g. aim at CTOs; ~800 words; end with a CTA to book a demo"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!ready || mutation.isPending}>
            {mutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Writing…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Generate draft
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
