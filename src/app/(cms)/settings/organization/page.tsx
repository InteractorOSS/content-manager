import { Metadata } from "next";
import { OrganizationSettings } from "@/components/cms/organization-settings";

export const metadata: Metadata = {
  title: "Organization",
};

export default function OrganizationSettingsPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Organization</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Settings for your active organization
        </p>
      </div>
      <OrganizationSettings />
    </div>
  );
}
