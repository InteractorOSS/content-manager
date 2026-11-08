import { Metadata } from "next";
import { SitesManager } from "@/components/cms/sites-manager";

export const metadata: Metadata = {
  title: "Sites",
};

export default function SitesSettingsPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Sites</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          The places this organization publishes to
        </p>
      </div>
      <SitesManager />
    </div>
  );
}
