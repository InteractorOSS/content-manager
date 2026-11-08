import { Metadata } from "next";
import { QueueBoard } from "@/components/social/queue-board";

export const metadata: Metadata = {
  title: "Queue",
};

export default function SocialQueuePage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Queue</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Scheduled, drafted, and published social posts
        </p>
      </div>
      <QueueBoard />
    </div>
  );
}
