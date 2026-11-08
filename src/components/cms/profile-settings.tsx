"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getMyProfile, updateMyProfile } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

/**
 * The signed-in person's byline name and bio. The display name is the only
 * name the CMS never overwrites — `name` is refreshed from the sign-in profile
 * each time, and is often just a username.
 */
export function ProfileSettings() {
  const queryClient = useQueryClient();
  const { data: profile, isLoading } = useQuery({
    queryKey: ["my-profile"],
    queryFn: getMyProfile,
  });

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [authorSlug, setAuthorSlug] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [sameAs, setSameAs] = useState(""); // one URL per line in the textarea, joined/split on save

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.display_name ?? "");
      setBio(profile.bio ?? "");
      setAuthorSlug(profile.author_slug ?? "");
      setJobTitle(profile.job_title ?? "");
      setSameAs(profile.same_as.join("\n"));
    }
  }, [profile]);

  const save = useMutation({
    mutationFn: () =>
      updateMyProfile({
        display_name: displayName,
        bio,
        author_slug: authorSlug,
        job_title: jobTitle,
        same_as: sameAs
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["my-profile"] });
      queryClient.invalidateQueries({ queryKey: ["me"] });
      toast.success(
        result.posts_updated > 0
          ? `Profile saved — ${result.posts_updated} post byline${result.posts_updated === 1 ? "" : "s"} updated to "${result.byline}"`
          : "Profile saved"
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading || !profile) return <Skeleton className="h-64 w-full max-w-2xl" />;

  const fallback = profile.name?.trim() || profile.email;

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Author profile</CardTitle>
        <CardDescription>
          Shown as the byline on posts you write. Your posts currently read{" "}
          <span className="font-medium text-foreground">{profile.byline}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="display_name">Display name</Label>
            <Input
              id="display_name"
              value={displayName}
              maxLength={80}
              placeholder={fallback}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to use your sign-in name ({fallback}). Changing it also updates the byline
              on your existing posts, except posts whose byline was set by hand.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bio">Bio</Label>
            <Textarea
              id="bio"
              value={bio}
              rows={4}
              maxLength={1000}
              placeholder="A sentence or two about your role and expertise."
              onChange={(e) => setBio(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="author_slug">Author page slug</Label>
            <Input
              id="author_slug"
              value={authorSlug}
              maxLength={64}
              placeholder="e.g. jane-doe"
              onChange={(e) => setAuthorSlug(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase words separated by hyphens. Gives you a public author page (e.g.
              /author/jane-doe on a consuming site) and lets posts credit you as a real byline
              rather than just a name. Leave blank to stay unlisted.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="job_title">Job title</Label>
            <Input
              id="job_title"
              value={jobTitle}
              maxLength={100}
              placeholder="e.g. Founder"
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="same_as">Profile links</Label>
            <Textarea
              id="same_as"
              value={sameAs}
              rows={3}
              placeholder={"One https:// URL per line — your site, LinkedIn, X…"}
              onChange={(e) => setSameAs(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Ties your byline to your real profiles elsewhere (up to 10). Each must start with
              https://.
            </p>
          </div>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save profile
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
