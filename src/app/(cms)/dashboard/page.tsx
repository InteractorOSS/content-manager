import { Metadata } from "next";
import Link from "next/link";
import {
  FileText,
  FolderOpen,
  Tag,
  Image,
  Plus,
  Upload,
  ArrowRight,
  TrendingUp,
  MessageSquare,
  Mail,
  Users,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { serverListPosts, serverListCategories, serverListMedia, serverGetSubmissionCounts } from "@/lib/server-data";
import { requirePageActor } from "@/lib/server-actor";
import { formatDate, truncate } from "@/lib/utils";
import type { Post } from "@/types/cms";

export const metadata: Metadata = {
  title: "Dashboard",
};

// Per-actor data (org-scoped) — a shared 60s revalidation window would leak
// one organization's cached stats to the next viewer from another org.
export const revalidate = 0;

async function getDashboardData(organizationId: string | null) {
  try {
    const [allPosts, categories, media, submissionCounts] = await Promise.allSettled([
      serverListPosts(organizationId),
      serverListCategories(organizationId),
      serverListMedia(organizationId),
      serverGetSubmissionCounts(organizationId),
    ]);

    const posts = allPosts.status === "fulfilled" ? allPosts.value : [];
    const cats = categories.status === "fulfilled" ? categories.value : [];
    const mediaItems = media.status === "fulfilled" ? media.value : [];
    const counts = submissionCounts.status === "fulfilled"
      ? submissionCounts.value
      : { newContacts: 0, activeNewsletter: 0, pendingWaitlist: 0 };

    const published = posts.filter((p) => p.status === "published");
    const drafts = posts.filter((p) => p.status === "draft");
    const archived = posts.filter((p) => p.status === "archived");

    const allTags = Array.from(new Set(posts.flatMap((p) => p.tags || [])));
    const recentPosts = [...posts]
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )
      .slice(0, 5);

    return {
      totalPosts: posts.length,
      publishedPosts: published.length,
      draftPosts: drafts.length,
      archivedPosts: archived.length,
      totalCategories: cats.length,
      totalTags: allTags.length,
      totalMedia: mediaItems.length,
      recentPosts,
      newContacts: counts.newContacts,
      activeNewsletter: counts.activeNewsletter,
      pendingWaitlist: counts.pendingWaitlist,
    };
  } catch {
    return {
      totalPosts: 0,
      publishedPosts: 0,
      draftPosts: 0,
      archivedPosts: 0,
      totalCategories: 0,
      totalTags: 0,
      totalMedia: 0,
      recentPosts: [] as Post[],
      newContacts: 0,
      activeNewsletter: 0,
      pendingWaitlist: 0,
    };
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === "published")
    return <Badge variant="success">Published</Badge>;
  if (status === "draft") return <Badge variant="warning">Draft</Badge>;
  return <Badge variant="muted">Archived</Badge>;
}

export default async function DashboardPage() {
  const actor = await requirePageActor();
  const stats = await getDashboardData(actor.organizationId);

  const statCards = [
    {
      title: "Total Posts",
      value: stats.totalPosts,
      icon: FileText,
      color: "text-blue-500",
      bg: "bg-blue-50",
      href: "/posts",
    },
    {
      title: "Published",
      value: stats.publishedPosts,
      icon: TrendingUp,
      color: "text-green-500",
      bg: "bg-green-50",
      href: "/posts",
    },
    {
      title: "Drafts",
      value: stats.draftPosts,
      icon: FileText,
      color: "text-yellow-500",
      bg: "bg-yellow-50",
      href: "/posts",
    },
    {
      title: "Categories",
      value: stats.totalCategories,
      icon: FolderOpen,
      color: "text-purple-500",
      bg: "bg-purple-50",
      href: "/categories",
    },
    {
      title: "Tags",
      value: stats.totalTags,
      icon: Tag,
      color: "text-orange-500",
      bg: "bg-orange-50",
      href: "/tags",
    },
    {
      title: "Media",
      value: stats.totalMedia,
      icon: Image,
      color: "text-pink-500",
      bg: "bg-pink-50",
      href: "/media",
    },
    {
      title: "New Contacts",
      value: stats.newContacts,
      icon: MessageSquare,
      color: "text-blue-500",
      bg: "bg-blue-50",
      href: "/contacts",
    },
    {
      title: "Subscribers",
      value: stats.activeNewsletter,
      icon: Mail,
      color: "text-indigo-500",
      bg: "bg-indigo-50",
      href: "/newsletter",
    },
    {
      title: "Waitlist",
      value: stats.pendingWaitlist,
      icon: Users,
      color: "text-teal-500",
      bg: "bg-teal-50",
      href: "/waitlist",
    },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Overview of your content
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/posts/upload">
              <Upload className="h-4 w-4 mr-2" />
              Upload Post
            </Link>
          </Button>
          <Button asChild>
            <Link href="/posts/new">
              <Plus className="h-4 w-4 mr-2" />
              New Post
            </Link>
          </Button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-9">
        {statCards.map((card) => (
          <Link key={card.title} href={card.href}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer">
              <CardContent className="p-4">
                <div className={`inline-flex p-2 rounded-lg ${card.bg} mb-3`}>
                  <card.icon className={`h-4 w-4 ${card.color}`} />
                </div>
                <p className="text-2xl font-bold">{card.value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {card.title}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent posts */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-4">
            <div>
              <CardTitle className="text-base font-semibold">
                Recent Posts
              </CardTitle>
              <CardDescription>Last 5 updated posts</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/posts" className="gap-1 text-xs">
                View all
                <ArrowRight className="h-3 w-3" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {stats.recentPosts.length === 0 ? (
              <div className="px-6 py-8 text-center">
                <FileText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No posts yet.</p>
                <Button variant="outline" size="sm" className="mt-3" asChild>
                  <Link href="/posts/new">Create your first post</Link>
                </Button>
              </div>
            ) : (
              <div className="divide-y">
                {stats.recentPosts.map((post) => (
                  <div
                    key={post.id}
                    className="flex items-center gap-4 px-6 py-3 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/posts/${post.slug}/edit`}
                        className="font-medium text-sm hover:underline text-foreground truncate block"
                      >
                        {post.title || "(Untitled)"}
                      </Link>
                      {post.excerpt && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          {truncate(post.excerpt, 80)}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <StatusBadge status={post.status} />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDate(post.updated_at)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick actions */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-semibold">
              Quick Actions
            </CardTitle>
            <CardDescription>Common tasks</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button className="w-full justify-start gap-2" asChild>
              <Link href="/posts/new">
                <Plus className="h-4 w-4" />
                New Post
              </Link>
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/posts/upload">
                <Upload className="h-4 w-4" />
                Upload Post
              </Link>
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/categories">
                <FolderOpen className="h-4 w-4" />
                Manage Categories
              </Link>
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/media">
                <Image className="h-4 w-4" />
                Media Library
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
