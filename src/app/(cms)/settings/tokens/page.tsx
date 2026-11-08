import { Metadata } from "next";
import { ApiTokensManager } from "@/components/cms/api-tokens-manager";

export const metadata: Metadata = {
  title: "API Tokens",
};

export default function ApiTokensPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">API Tokens</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Sync posts as Markdown files from your desktop
        </p>
      </div>
      <ApiTokensManager />
    </div>
  );
}
