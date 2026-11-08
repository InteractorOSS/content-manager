import { Metadata } from "next";
import { PostsTable } from "@/components/cms/posts-table";
import { AiDraftButton } from "@/components/cms/ai-draft-button";

export const metadata: Metadata = {
  title: "Posts",
};

export default function PostsPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Posts</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Manage all your content posts
          </p>
        </div>
        <AiDraftButton />
      </div>
      <PostsTable />
    </div>
  );
}
