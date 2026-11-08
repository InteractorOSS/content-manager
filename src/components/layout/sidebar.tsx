"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  UserRound,
  LayoutDashboard,
  FileText,
  FolderOpen,
  Tag,
  Image,
  ChevronRight,
  MessageSquare,
  MessageCircle,
  Mail,
  Users,
  UserCog,
  ClipboardCheck,
  CalendarDays,
  ListTodo,
  Share2,
  Megaphone,
  Inbox,
  PenLine,
  KeyRound,
  GitBranch,
  HelpCircle,
  Building2,
  Globe2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMe } from "@/hooks/use-me";
import { OrgSwitcher } from "@/components/layout/org-switcher";

// id injected by the vendored feedback-widget.js embed (see src/app/layout.tsx)
const FEEDBACK_LAUNCHER_ID = "_iqfw-launcher";

function openFeedbackWidget() {
  document.getElementById(FEEDBACK_LAUNCHER_ID)?.click();
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  exact?: boolean;
  permission?: string;
}

const contentNavItems: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: <LayoutDashboard className="h-4 w-4" />,
    exact: true,
  },
  {
    href: "/posts",
    label: "Posts",
    icon: <FileText className="h-4 w-4" />,
  },
  {
    href: "/review",
    label: "Review",
    icon: <ClipboardCheck className="h-4 w-4" />,
    permission: "content:approve",
  },
  {
    href: "/categories",
    label: "Categories",
    icon: <FolderOpen className="h-4 w-4" />,
  },
  {
    href: "/tags",
    label: "Tags",
    icon: <Tag className="h-4 w-4" />,
  },
  {
    href: "/faqs",
    label: "FAQ",
    icon: <HelpCircle className="h-4 w-4" />,
  },
  {
    href: "/media",
    label: "Media",
    icon: <Image className="h-4 w-4" />,
  },
  {
    href: "/style",
    label: "Writing Style",
    icon: <PenLine className="h-4 w-4" />,
    permission: "content:create",
  },
];

const socialNavItems: NavItem[] = [
  {
    href: "/social/calendar",
    label: "Calendar",
    icon: <CalendarDays className="h-4 w-4" />,
  },
  {
    href: "/social/queue",
    label: "Queue",
    icon: <ListTodo className="h-4 w-4" />,
  },
  {
    href: "/social/manual",
    label: "Manual queue",
    icon: <Inbox className="h-4 w-4" />,
  },
  {
    href: "/social/channels",
    label: "Channels",
    icon: <Share2 className="h-4 w-4" />,
  },
  {
    href: "/social/campaigns",
    label: "Campaigns",
    icon: <Megaphone className="h-4 w-4" />,
  },
];

const submissionsNavItems: NavItem[] = [
  {
    href: "/contacts",
    label: "Contacts",
    icon: <MessageSquare className="h-4 w-4" />,
  },
  {
    href: "/newsletter",
    label: "Newsletter",
    icon: <Mail className="h-4 w-4" />,
  },
  {
    href: "/waitlist",
    label: "Waitlist",
    icon: <Users className="h-4 w-4" />,
  },
  {
    href: "/comments",
    label: "Comments",
    icon: <MessageCircle className="h-4 w-4" />,
  },
];

const adminNavItems: NavItem[] = [
  {
    href: "/members",
    label: "Members",
    icon: <UserCog className="h-4 w-4" />,
    permission: "users:view",
  },
];

// No permission gate — API tokens are self-service, scoped to whatever the
// signed-in user can already do (see FILE-BASED-CONTENT-PLAN.md Phase 1).
const settingsNavItems: NavItem[] = [
  {
    href: "/settings/profile",
    label: "Profile",
    icon: <UserRound className="h-4 w-4" />,
  },
  {
    // No permission gate: every member can view their org's settings; the page
    // and the PATCH route both restrict *editing* to owner/admin.
    href: "/settings/organization",
    label: "Organization",
    icon: <Building2 className="h-4 w-4" />,
  },
  {
    href: "/settings/sites",
    label: "Sites",
    icon: <Globe2 className="h-4 w-4" />,
  },
  {
    href: "/settings/tokens",
    label: "API Tokens",
    icon: <KeyRound className="h-4 w-4" />,
  },
  {
    href: "/settings/content-sync",
    label: "Content Sync",
    icon: <GitBranch className="h-4 w-4" />,
    permission: "admin:settings",
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { can } = useMe();

  function isActive(item: NavItem): boolean {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href);
  }

  function visible(items: NavItem[]): NavItem[] {
    return items.filter((item) => !item.permission || can(item.permission));
  }

  function renderItems(items: NavItem[]) {
    return visible(items).map((item) => (
      <Link
        key={item.href}
        href={item.href}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive(item)
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        )}
      >
        <span className={cn(isActive(item) ? "text-sidebar-primary" : "opacity-60")}>
          {item.icon}
        </span>
        {item.label}
        {isActive(item) && (
          <ChevronRight className="ml-auto h-3 w-3 opacity-50" />
        )}
      </Link>
    ));
  }

  const adminVisible = visible(adminNavItems).length > 0;

  return (
    <aside className="flex h-full w-64 flex-col bg-sidebar border-r border-sidebar-border">
      {/* Logo */}
      <div className="flex h-16 items-center px-6 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sidebar-primary">
            <span className="text-sidebar-primary-foreground font-bold text-sm">I</span>
          </div>
          <div>
            <p className="text-sidebar-foreground font-semibold text-sm leading-none">
              Interactor
            </p>
            <p className="text-sidebar-foreground/60 text-xs mt-0.5">CMS</p>
          </div>
        </div>
      </div>

      {/* Active tenant + switcher (T5) */}
      <div className="border-b border-sidebar-border px-3 py-2">
        <OrgSwitcher />
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="space-y-1">
          <p className="px-3 text-xs font-semibold text-sidebar-foreground/40 uppercase tracking-wider mb-2">
            Content
          </p>
          {renderItems(contentNavItems)}

          <p className="px-3 text-xs font-semibold text-sidebar-foreground/40 uppercase tracking-wider mt-4 mb-2">
            Social
          </p>
          {renderItems(socialNavItems)}

          <p className="px-3 text-xs font-semibold text-sidebar-foreground/40 uppercase tracking-wider mt-4 mb-2">
            Submissions
          </p>
          {renderItems(submissionsNavItems)}

          {adminVisible && (
            <>
              <p className="px-3 text-xs font-semibold text-sidebar-foreground/40 uppercase tracking-wider mt-4 mb-2">
                Administration
              </p>
              {renderItems(adminNavItems)}
            </>
          )}

          <p className="px-3 text-xs font-semibold text-sidebar-foreground/40 uppercase tracking-wider mt-4 mb-2">
            Settings
          </p>
          {renderItems(settingsNavItems)}
        </nav>
      </ScrollArea>

      {/* Footer */}
      <div className="border-t border-sidebar-border px-3 py-3 space-y-2">
        <button
          type="button"
          onClick={openFeedbackWidget}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        >
          <MessageSquare className="h-4 w-4 opacity-60" />
          Give Feedback
        </button>
        <p className="text-xs text-sidebar-foreground/40 px-3">
          Interactor CMS v0.1
        </p>
      </div>
    </aside>
  );
}
