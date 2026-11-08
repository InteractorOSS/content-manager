"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Edit,
  Trash2,
  Globe,
  EyeOff,
  ChevronDown,
  Plus,
  Upload,
  Search,
  Loader2,
  GitMergeConflict,
  Rss,
  ExternalLink,
  PenLine,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  listPosts,
  listSites,
  publishPost,
  unpublishPost,
  deletePost,
  bulkDeletePosts,
  workflowAction,
  resolveSyncConflict,
} from "@/lib/api";
import { postSaveConflictMessage } from "@/lib/post-save-conflict";
import { useMe } from "@/hooks/use-me";
import { formatDate, truncate } from "@/lib/utils";
import type { Post, Site } from "@/types/cms";

/** The discrete states StatusBadge renders — also what the status filter matches on. */
type StatusKey = "published" | "pending_review" | "rejected" | "draft" | "archived";

function statusKey(post: Post): StatusKey {
  if (post.status === "published") return "published";
  if (post.workflow_status === "pending_review") return "pending_review";
  if (post.workflow_status === "rejected") return "rejected";
  if (post.status === "draft") return "draft";
  return "archived";
}

const STATUS_LABELS: Record<StatusKey, string> = {
  published: "Published",
  pending_review: "In review",
  rejected: "Rejected",
  draft: "Draft",
  archived: "Archived",
};

function StatusBadge({ post }: { post: Post }) {
  const key = statusKey(post);
  if (key === "published") return <Badge variant="success">Published</Badge>;
  if (key === "pending_review") return <Badge variant="info">In review</Badge>;
  if (key === "rejected") return <Badge variant="destructive">Rejected</Badge>;
  if (key === "draft") return <Badge variant="warning">Draft</Badge>;
  return <Badge variant="muted">Archived</Badge>;
}

function TypeBadge({ type }: { type: string }) {
  return (
    <Badge variant="outline" className="capitalize text-xs">
      {type}
    </Badge>
  );
}

export function PostsTable() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusKey | "all">("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [siteFilter, setSiteFilter] = useState<string>("all");
  const [deleteTarget, setDeleteTarget] = useState<Post | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: posts = [], isLoading } = useQuery<Post[]>({
    queryKey: ["posts"],
    queryFn: () => listPosts(),
  });

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ["sites"],
    queryFn: listSites,
  });
  const siteNameBySlug = new Map(sites.map((s) => [s.slug, s.name]));
  // Sites a post targets but nobody registered (or the registry hasn't
  // loaded yet) still need a label — fall back to the slug itself.
  const siteLabel = (slug: string) => siteNameBySlug.get(slug) ?? slug;
  // RSS/sitemap need a real Site row with a url (loadFeedData 404s
  // otherwise) — the virtual "in-use:" entries from mergeSites don't qualify.
  const registeredSites = sites.filter((s) => !s.id.startsWith("in-use:") && s.url);
  const siteUrlBySlug = new Map(sites.filter((s) => s.url).map((s) => [s.slug, s.url as string]));
  // Same join `src/lib/feed.ts` uses to build a feed item's <link> — only
  // meaningful once the post is actually live, since a draft has nothing to
  // visit yet at that path.
  function postUrl(post: Post, slug: string): string | null {
    if (post.status !== "published") return null;
    const base = siteUrlBySlug.get(slug);
    return base ? `${base.replace(/\/+$/, "")}/${post.slug}` : null;
  }

  const typeOptions = [...new Set(posts.map((p) => p.type))].sort();
  const siteOptions = [...new Set([...sites.map((s) => s.slug), ...posts.flatMap((p) => p.platforms)])].sort(
    (a, b) => siteLabel(a).localeCompare(siteLabel(b))
  );

  const publishMutation = useMutation({
    mutationFn: (id: string) => publishPost(id),
    onSuccess: () => {
      toast.success("Post published");
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
    // The route names a specific reason (missing content, missing featured
    // image) — show it instead of a generic failure.
    onError: (e: Error) =>
      toast.error(e instanceof ApiError && e.message ? e.message : "Failed to publish post"),
  });

  const unpublishMutation = useMutation({
    mutationFn: (id: string) => unpublishPost(id),
    onSuccess: () => {
      toast.success("Post unpublished");
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
    onError: () => toast.error("Failed to unpublish post"),
  });

  const submitMutation = useMutation({
    mutationFn: (id: string) => workflowAction(id, "submit"),
    onSuccess: () => {
      toast.success("Post submitted for review");
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
    onError: () => toast.error("Failed to submit post"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePost(id),
    onSuccess: () => {
      toast.success("Post deleted");
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
    onError: () => toast.error("Failed to delete post"),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (slugs: string[]) => bulkDeletePosts(slugs),
    onSuccess: () => {
      toast.success(`Deleted ${selected.size} posts`);
      setSelected(new Set());
      setBulkDeleteOpen(false);
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
    onError: () => toast.error("Failed to delete posts"),
  });

  const resolveConflictMutation = useMutation({
    // Send the hash this row was loaded with so a fresher edit landing
    // between the list loading and this click isn't silently overridden.
    mutationFn: (post: Post) => resolveSyncConflict(post.id, post.content_hash),
    onSuccess: () => {
      toast.success("Resolved — the CMS version will be pushed to the repo");
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
    onError: (error) => {
      const conflict = postSaveConflictMessage(error);
      if (conflict) {
        toast.error(conflict, { action: { label: "Reload", onClick: () => window.location.reload() } });
        return;
      }
      toast.error("Failed to resolve conflict");
    },
  });

  const filtered = posts.filter((p) => {
    const matchesSearch =
      !search ||
      p.title?.toLowerCase().includes(search.toLowerCase()) ||
      p.slug?.toLowerCase().includes(search.toLowerCase()) ||
      p.excerpt?.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || statusKey(p) === statusFilter;
    const matchesType = typeFilter === "all" || p.type === typeFilter;
    const matchesSite = siteFilter === "all" || p.platforms.includes(siteFilter);
    return matchesSearch && matchesStatus && matchesType && matchesSite;
  });

  const allSelected =
    filtered.length > 0 && filtered.every((p) => selected.has(p.id));
  const someSelected = filtered.some((p) => selected.has(p.id));

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((p) => p.id)));
    }
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function handleBulkDelete() {
    const selectedPosts = posts.filter((p) => selected.has(p.id));
    const slugs = selectedPosts.map((p) => p.slug);
    bulkDeleteMutation.mutate(slugs);
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search posts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusKey | "all")}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(Object.keys(STATUS_LABELS) as StatusKey[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {STATUS_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {typeOptions.map((type) => (
                <SelectItem key={type} value={type} className="capitalize">
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={siteFilter} onValueChange={setSiteFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Site" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              {siteOptions.map((slug) => (
                <SelectItem key={slug} value={slug}>
                  {siteLabel(slug)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Rss className="h-4 w-4 mr-2" />
                Feeds
                <ChevronDown className="h-4 w-4 ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild className="gap-2">
                <a href="/api/public/posts" target="_blank" rel="noreferrer">
                  All published posts (JSON)
                </a>
              </DropdownMenuItem>
              {registeredSites.map((site) => (
                <div key={site.id}>
                  <DropdownMenuItem asChild className="gap-2">
                    <a
                      href={`/api/public/posts?platform=${site.slug}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {site.name} — JSON
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="gap-2">
                    <a
                      href={`/api/public/rss.xml?platform=${site.slug}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {site.name} — RSS
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="gap-2">
                    <a
                      href={`/api/public/sitemap.xml?platform=${site.slug}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {site.name} — Sitemap
                    </a>
                  </DropdownMenuItem>
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Selected ({selected.size})
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Post
                <ChevronDown className="h-4 w-4 ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => router.push("/posts/new")}
                className="gap-2"
              >
                <Plus className="h-4 w-4" />
                Manual Input
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push("/posts/upload")}
                className="gap-2"
              >
                <Upload className="h-4 w-4" />
                Upload Post
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                  className={
                    someSelected && !allSelected ? "opacity-50" : undefined
                  }
                />
              </TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-28">Type</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-40">Sites</TableHead>
              <TableHead className="w-36">Author</TableHead>
              <TableHead className="w-36">Published</TableHead>
              <TableHead className="w-36">Updated</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <p className="text-sm">
                      {search || statusFilter !== "all" || typeFilter !== "all" || siteFilter !== "all"
                        ? "No posts match your filters"
                        : "No posts yet"}
                    </p>
                    {!search && statusFilter === "all" && typeFilter === "all" && siteFilter === "all" && (
                      <Button variant="outline" size="sm" asChild>
                        <Link href="/posts/new">Create your first post</Link>
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((post) => (
                <TableRow key={post.id} data-state={selected.has(post.id) ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(post.id)}
                      onCheckedChange={() => toggleOne(post.id)}
                      aria-label={`Select ${post.title}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="min-w-0">
                      <Link
                        href={`/posts/${post.slug}/edit`}
                        className="font-medium text-sm hover:underline block truncate max-w-xs"
                      >
                        {post.title || "(Untitled)"}
                      </Link>
                      {post.excerpt && (
                        <p className="text-xs text-muted-foreground truncate max-w-xs mt-0.5">
                          {truncate(post.excerpt, 80)}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <TypeBadge type={post.type} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <StatusBadge post={post} />
                      {post.sync_conflict && (
                        <Badge
                          variant="destructive"
                          className="gap-1 cursor-pointer"
                          title="Someone edited this post's file in the git repo since the CMS last synced it. Click to keep the CMS version and re-push it."
                          onClick={() => resolveConflictMutation.mutate(post)}
                        >
                          <GitMergeConflict className="h-3 w-3" />
                          Needs merge
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {post.platforms.length > 0 ? (
                        post.platforms.map((slug) => {
                          const url = postUrl(post, slug);
                          return url ? (
                            <a
                              key={slug}
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              title={url}
                              className="inline-flex"
                            >
                              <Badge
                                variant="outline"
                                className="gap-1 text-xs hover:bg-accent hover:text-accent-foreground"
                              >
                                {siteLabel(slug)}
                                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                              </Badge>
                            </a>
                          ) : (
                            <Badge key={slug} variant="outline" className="text-xs">
                              {siteLabel(slug)}
                            </Badge>
                          );
                        })
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {post.author_name || "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(post.published_at)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(post.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Actions"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild className="gap-2">
                          <Link href={`/posts/${post.slug}/edit`}>
                            <Edit className="h-4 w-4" />
                            Edit
                          </Link>
                        </DropdownMenuItem>
                        {post.content_format === "markdown" && (
                          <DropdownMenuItem asChild className="gap-2">
                            <a href={`/write?post=${post.id}`} target="_blank" rel="noreferrer">
                              <PenLine className="h-4 w-4" />
                              Open in writer
                            </a>
                          </DropdownMenuItem>
                        )}
                        {can("content:publish") &&
                          (post.status === "published" ? (
                            <DropdownMenuItem
                              className="gap-2"
                              onClick={() => unpublishMutation.mutate(post.id)}
                            >
                              <EyeOff className="h-4 w-4" />
                              Unpublish
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              className="gap-2"
                              onClick={() => publishMutation.mutate(post.id)}
                            >
                              <Globe className="h-4 w-4" />
                              Publish
                            </DropdownMenuItem>
                          ))}
                        {!can("content:publish") &&
                          post.status !== "published" &&
                          ["draft", "rejected"].includes(post.workflow_status) && (
                            <DropdownMenuItem
                              className="gap-2"
                              onClick={() => submitMutation.mutate(post.id)}
                            >
                              <Globe className="h-4 w-4" />
                              Submit for review
                            </DropdownMenuItem>
                          )}
                        {can("content:delete") && (
                          <DropdownMenuItem
                            className="gap-2 text-destructive focus:text-destructive"
                            onClick={() => setDeleteTarget(post)}
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Showing {filtered.length} of {posts.length} posts
      </p>

      {/* Delete single confirm */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Post</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.title}&rdquo;? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteTarget && deleteMutation.mutate(deleteTarget.id)
              }
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirm */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selected.size} Posts</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {selected.size} selected posts?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={bulkDeleteMutation.isPending}
            >
              {bulkDeleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Delete {selected.size} Posts
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
