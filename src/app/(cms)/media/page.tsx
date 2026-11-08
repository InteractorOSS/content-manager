import { Metadata } from "next";
import { MediaLibrary } from "@/components/cms/media-library";

export const metadata: Metadata = {
  title: "Media",
};

export default function MediaPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Media Library</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Manage your images and files
        </p>
      </div>
      <MediaLibrary />
    </div>
  );
}
