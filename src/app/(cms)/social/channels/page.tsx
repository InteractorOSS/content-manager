import { Metadata } from "next";
import { ChannelsManager } from "@/components/social/channels-manager";

export const metadata: Metadata = {
  title: "Channels",
};

export default function SocialChannelsPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Channels</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Connect and manage your social media accounts
        </p>
      </div>
      <ChannelsManager />
    </div>
  );
}
