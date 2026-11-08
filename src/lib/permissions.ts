// Permission names mirror the Phoenix app's RBAC
// (apps/interactor/lib/interactor/accounts/permission.ex).
export type PermissionName =
  | "users:view"
  | "users:create"
  | "users:edit"
  | "users:delete"
  | "users:manage_roles"
  | "content:view"
  | "content:create"
  | "content:edit"
  | "content:edit_any"
  | "content:delete"
  | "content:publish"
  | "content:approve"
  | "content:reject"
  | "categories:manage"
  | "media:view"
  | "media:upload"
  | "media:edit"
  | "media:delete"
  | "admin:access"
  | "admin:settings"
  | "reports:view";

export interface PermissionInfo {
  name: PermissionName;
  display_name: string;
  description: string;
  category: string;
}

// Mirrors prisma/seed.mjs's PERMISSIONS array (the seed script runs under
// plain Node, with no TypeScript loader, so it can't import this module
// directly). Keep the two in sync by hand when a permission is added,
// renamed, or redescribed — this is the source the docs site (/docs/auth)
// renders from.
export const PERMISSIONS: PermissionInfo[] = [
  { name: "users:view", display_name: "View Users", description: "Can view user list and profiles", category: "user_management" },
  { name: "users:create", display_name: "Create Users", description: "Can create new user accounts", category: "user_management" },
  { name: "users:edit", display_name: "Edit Users", description: "Can edit user information", category: "user_management" },
  { name: "users:delete", display_name: "Delete Users", description: "Can delete user accounts", category: "user_management" },
  { name: "users:manage_roles", display_name: "Manage User Roles", description: "Can assign and remove user roles", category: "user_management" },
  { name: "content:view", display_name: "View Content", description: "Can view content in admin area", category: "content" },
  { name: "content:create", display_name: "Create Content", description: "Can create new content", category: "content" },
  { name: "content:edit", display_name: "Edit Content", description: "Can edit existing content", category: "content" },
  { name: "content:edit_any", display_name: "Edit Any Content", description: "Can edit content created by others, including reassigning a post's author to any other org member", category: "content" },
  { name: "content:delete", display_name: "Delete Content", description: "Can delete content", category: "content" },
  { name: "content:publish", display_name: "Publish Content", description: "Can publish content directly without approval", category: "content" },
  { name: "content:approve", display_name: "Approve Content", description: "Can approve content for publication", category: "content" },
  { name: "content:reject", display_name: "Reject Content", description: "Can reject content submissions", category: "content" },
  { name: "categories:manage", display_name: "Manage Categories", description: "Can create, edit, and delete categories", category: "site_management" },
  { name: "media:view", display_name: "View Media", description: "Can view media library", category: "media" },
  { name: "media:upload", display_name: "Upload Media", description: "Can upload new media files", category: "media" },
  { name: "media:edit", display_name: "Edit Media", description: "Can edit media information", category: "media" },
  { name: "media:delete", display_name: "Delete Media", description: "Can delete media files", category: "media" },
  { name: "admin:access", display_name: "Admin Access", description: "Can access admin dashboard", category: "admin" },
  { name: "admin:settings", display_name: "Admin Settings", description: "Can modify site settings", category: "admin" },
  { name: "reports:view", display_name: "View Reports", description: "Can view reports and analytics", category: "reporting" },
];
