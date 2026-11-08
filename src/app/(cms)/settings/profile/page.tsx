import { Metadata } from "next";
import { ProfileSettings } from "@/components/cms/profile-settings";

export const metadata: Metadata = {
  title: "Profile",
};

export default function ProfileSettingsPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Profile</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          How you appear as the author of your posts
        </p>
      </div>
      <ProfileSettings />
    </div>
  );
}
