import { Metadata } from "next";
import { ContactsTable } from "@/components/cms/contacts-table";

export const metadata: Metadata = {
  title: "Contacts",
};

export default function ContactsPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Contact Submissions</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Manage contact form submissions and demo requests
        </p>
      </div>
      <ContactsTable />
    </div>
  );
}
