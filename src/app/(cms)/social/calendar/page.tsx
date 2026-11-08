import { Metadata } from "next";
import { SocialCalendar } from "@/components/social/social-calendar";

export const metadata: Metadata = {
  title: "Calendar",
};

export default function SocialCalendarPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Calendar</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Plan your social posts across the month
        </p>
      </div>
      <SocialCalendar />
    </div>
  );
}
