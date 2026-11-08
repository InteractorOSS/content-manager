import { Metadata } from "next";
import { ContentSyncManager } from "@/components/cms/content-sync-manager";

export const metadata: Metadata = {
  title: "Content Sync",
};

export default function ContentSyncPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Content Sync</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Two-way sync between posts and a git repository
        </p>
      </div>
      <ContentSyncManager />
    </div>
  );
}
