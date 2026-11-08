import { Metadata } from "next";
import { NewsletterTable } from "@/components/cms/newsletter-table";

export const metadata: Metadata = {
  title: "Newsletter",
};

export default function NewsletterPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Newsletter Subscriptions</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Manage newsletter subscribers and their preferences
        </p>
      </div>
      <NewsletterTable />
    </div>
  );
}
