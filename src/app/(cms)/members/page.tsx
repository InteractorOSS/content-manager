import { Metadata } from "next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsersManager } from "@/components/cms/users-manager";
import { InvitationsManager } from "@/components/cms/invitations-manager";

export const metadata: Metadata = {
  title: "Members",
};

export default function MembersPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Members</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Manage team members, roles, and invitations
        </p>
      </div>
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="invitations">Invitations</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="mt-4">
          <UsersManager />
        </TabsContent>
        <TabsContent value="invitations" className="mt-4">
          <InvitationsManager />
        </TabsContent>
      </Tabs>
    </div>
  );
}
