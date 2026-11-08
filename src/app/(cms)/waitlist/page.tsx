import { Metadata } from "next";
import { WaitlistTable } from "@/components/cms/waitlist-table";

export const metadata: Metadata = {
  title: "Waitlist",
};

export default function WaitlistPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Waitlist</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Manage waitlist signups and send invitations
        </p>
      </div>
      <WaitlistTable />
    </div>
  );
}
