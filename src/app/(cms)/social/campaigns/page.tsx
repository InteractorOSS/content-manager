import { Metadata } from "next";
import { CampaignsManager } from "@/components/social/campaigns-manager";

export const metadata: Metadata = {
  title: "Campaigns",
};

export default function SocialCampaignsPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Campaigns</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Group social posts into campaigns
        </p>
      </div>
      <CampaignsManager />
    </div>
  );
}
