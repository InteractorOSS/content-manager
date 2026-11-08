"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { createSite, deleteSite, listSites, updateSite } from "@/lib/api";
import { useMe } from "@/hooks/use-me";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Site } from "@/types/cms";

/**
 * The org's distribution targets (G#18) — what the post editor offers under
 * "Publish To".
 *
 * Entries whose id starts with `in-use:` have no row behind them (see
 * mergeSites): a post already targets that slug but nobody has registered
 * it, so it's shown (there's nothing to rename or delete) until someone
 * registers a real row with the same slug.
 */
export function SitesManager() {
  const queryClient = useQueryClient();
  const { can } = useMe();
  const canManage = can("categories:manage");

  const { data: sites = [], isLoading } = useQuery<Site[]>({
    queryKey: ["sites"],
    queryFn: listSites,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState<Site | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["sites"] });
  }

  const add = useMutation({
    mutationFn: () =>
      createSite({ slug: slug.trim(), name: name.trim() || undefined, url: url.trim() }),
    onSuccess: (site) => {
      setAddOpen(false);
      setSlug("");
      setName("");
      setUrl("");
      refresh();
      toast.success(`Added ${site.name}`);
    },
    onError: (e: Error) => toast.error(e.message || "Could not add that site."),
  });

  const rename = useMutation({
    mutationFn: (site: Site) =>
      updateSite(site.id, { name: editName.trim(), url: editUrl.trim() }),
    onSuccess: () => {
      setEditing(null);
      refresh();
      toast.success("Site updated");
    },
    onError: (e: Error) => toast.error(e.message || "Could not update that site."),
  });

  const remove = useMutation({
    mutationFn: (site: Site) => deleteSite(site.id),
    onSuccess: () => {
      refresh();
      toast.success("Site removed");
    },
    // The route refuses while posts still target it and says how many —
    // surface that sentence rather than a generic failure.
    onError: (e: Error) => toast.error(e.message || "Could not remove that site."),
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Sites</CardTitle>
            <CardDescription>
              Where a post can be published. These are the options under “Publish To”
              in the editor.
            </CardDescription>
          </div>
          {canManage && (
            <Button className="min-h-11 sm:min-h-0" onClick={() => setAddOpen(true)}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              Add site
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {sites.map((site) => {
              const registered = !site.id.startsWith("in-use:");
              return (
                <li
                  key={site.slug}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{site.name}</span>
                      {!registered && <Badge variant="secondary">In use</Badge>}
                    </div>
                    <code className="text-xs text-muted-foreground">{site.slug}</code>
                    {site.url && (
                      <p className="truncate text-xs text-muted-foreground">{site.url}</p>
                    )}
                  </div>

                  {canManage && registered && (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="outline"
                        className="min-h-11 sm:min-h-0"
                        onClick={() => {
                          setEditing(site);
                          setEditName(site.name);
                          setEditUrl(site.url ?? "");
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        className="min-h-11 sm:min-h-0"
                        aria-label={`Remove ${site.name}`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(site)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!slug.trim() || !url.trim()) return;
              add.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Add a site</DialogTitle>
              <DialogDescription>
                The slug is what posts store and what the public API accepts as
                <code className="mx-1">?platform=</code>.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="site-slug">Slug</Label>
                <Input
                  id="site-slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="docs-site"
                  autoFocus
                  disabled={add.isPending}
                  aria-describedby="site-slug-help"
                />
                <p id="site-slug-help" className="text-xs text-muted-foreground">
                  Lowercase words joined by hyphens.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="site-name">Name (optional)</Label>
                <Input
                  id="site-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Docs Site"
                  disabled={add.isPending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="site-url">URL</Label>
                <Input
                  id="site-url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://docs.example.com"
                  disabled={add.isPending}
                  aria-describedby="site-url-help"
                />
                <p id="site-url-help" className="text-xs text-muted-foreground">
                  This site&apos;s base URL — used to build its RSS feed and sitemap links.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddOpen(false)}
                disabled={add.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!slug.trim() || !url.trim() || add.isPending}>
                {add.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                Add
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!editing || !editName.trim() || !editUrl.trim()) return;
              rename.mutate(editing);
            }}
          >
            <DialogHeader>
              <DialogTitle>Edit site</DialogTitle>
              <DialogDescription>
                The slug stays <code>{editing?.slug}</code>, so posts already
                targeting it are unaffected.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="site-rename">Name</Label>
                <Input
                  id="site-rename"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                  disabled={rename.isPending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="site-edit-url">URL</Label>
                <Input
                  id="site-edit-url"
                  type="url"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  disabled={rename.isPending}
                  aria-describedby="site-edit-url-help"
                />
                <p id="site-edit-url-help" className="text-xs text-muted-foreground">
                  This site&apos;s base URL — used to build its RSS feed and sitemap links.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(null)}
                disabled={rename.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!editName.trim() || !editUrl.trim() || rename.isPending}>
                {rename.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
