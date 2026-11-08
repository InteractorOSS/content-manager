import { Metadata } from "next";
import { CommentsTable } from "@/components/cms/comments-table";

export const metadata: Metadata = {
  title: "Comments",
};

export default function CommentsPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Comments</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Moderate blog comments — new submissions land as Pending until approved
        </p>
      </div>
      <CommentsTable />
    </div>
  );
}
