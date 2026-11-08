import { Metadata } from "next";
import { ManualQueue } from "@/components/social/manual-queue";

export const metadata: Metadata = {
  title: "Manual queue",
};

export default function SocialManualQueuePage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Manual queue</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Posts waiting on a human — channels with no API access at all (like a
          personal Facebook profile). Paste the copy on the real platform
          yourself, then mark it posted.
        </p>
      </div>
      <ManualQueue />
    </div>
  );
}
