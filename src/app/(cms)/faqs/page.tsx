import { Metadata } from "next";
import { FaqManager } from "@/components/cms/faq-manager";

export const metadata: Metadata = {
  title: "FAQ",
};

export default function FaqPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">FAQ</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Answers to recurring customer questions, publishable without a deploy.
        </p>
      </div>
      <FaqManager />
    </div>
  );
}
