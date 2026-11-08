import { Metadata } from "next";
import { ReviewQueue } from "@/components/cms/review-queue";

export const metadata: Metadata = {
  title: "Review",
};

export default function ReviewPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Review queue</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Posts submitted for review, awaiting approval or rejection
        </p>
      </div>
      <ReviewQueue />
    </div>
  );
}
