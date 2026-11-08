import { Metadata } from "next";
import { MyFeedbackList } from "@/components/cms/my-feedback-list";

export const metadata: Metadata = {
  title: "My Submissions",
};

export default function MyFeedbackPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">My Submissions</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Feedback, ideas, and support tickets you&apos;ve submitted via the feedback widget
        </p>
      </div>
      <MyFeedbackList />
    </div>
  );
}
