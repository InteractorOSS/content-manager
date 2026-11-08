import { Metadata } from "next";
import { TagManager } from "@/components/cms/tag-manager";

export const metadata: Metadata = {
  title: "Tags",
};

export default function TagsPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Tags</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          View and manage all tags across your posts
        </p>
      </div>
      <TagManager />
    </div>
  );
}
