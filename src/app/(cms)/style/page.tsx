import { Metadata } from "next";
import { StyleProfilesManager } from "@/components/cms/style-profiles-manager";

export const metadata: Metadata = {
  title: "Writing Style",
};

export default function StylePage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Writing style</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Teach the CMS your voice — add writing you like, tell it why, and it
          distills a style guide used for AI drafting
        </p>
      </div>
      <StyleProfilesManager />
    </div>
  );
}
