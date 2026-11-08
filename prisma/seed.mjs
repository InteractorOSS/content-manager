// Seeds the default roles and permissions, ported from the Phoenix app
// (apps/interactor/lib/interactor/accounts/{role.ex,permission.ex}).
// Idempotent: safe to re-run; existing rows are updated, not duplicated.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const ROLES = [
  { name: "super_admin", display_name: "Super Administrator", description: "Full system access and user management", priority: 10 },
  // Org-scoped top role (SMM-CONSOLIDATION-PUNCHLIST T3): a per-org owner who
  // can manage billing and delete the organization, on top of every admin
  // content permission. super_admin stays a GLOBAL (cross-org) role above it.
  { name: "owner", display_name: "Organization Owner", description: "Full organization access, including billing and org deletion", priority: 15 },
  { name: "admin", display_name: "Administrator", description: "Site administration and content management", priority: 20 },
  { name: "editor", display_name: "Editor", description: "Can create, edit and publish content", priority: 30 },
  { name: "reviewer", display_name: "Content Reviewer", description: "Can review and approve content for publication", priority: 40 },
  { name: "author", display_name: "Author", description: "Can create and edit own content, requires approval", priority: 50 },
  { name: "guest_author", display_name: "Guest Author", description: "Limited access, can create drafts only", priority: 60 },
];

const PERMISSIONS = [
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

const ROLE_PERMISSIONS = {
  super_admin: PERMISSIONS.map((p) => p.name),
  // Owner = every admin content permission, plus the org-management surface
  // admin lacks (create/delete users, settings). No billing-specific
  // permission exists yet; owner is the role billing/org-deletion gates on.
  owner: [
    "users:view", "users:create", "users:edit", "users:delete", "users:manage_roles",
    "content:view", "content:create", "content:edit", "content:edit_any", "content:delete",
    "content:publish", "content:approve", "content:reject",
    "categories:manage",
    "media:view", "media:upload", "media:edit", "media:delete",
    "admin:access", "admin:settings", "reports:view",
  ],
  admin: [
    "users:view", "users:edit", "users:manage_roles",
    "content:view", "content:create", "content:edit", "content:edit_any", "content:delete",
    "content:publish", "content:approve", "content:reject",
    "categories:manage",
    "media:view", "media:upload", "media:edit", "media:delete",
    "admin:access", "reports:view",
  ],
  editor: [
    "content:view", "content:create", "content:edit", "content:edit_any", "content:delete", "content:publish",
    "categories:manage",
    "media:view", "media:upload", "media:edit", "media:delete",
    "admin:access", "reports:view",
  ],
  reviewer: [
    "content:view", "content:approve", "content:reject",
    "media:view", "admin:access", "reports:view",
  ],
  author: [
    "content:view", "content:create", "content:edit",
    "media:view", "media:upload", "admin:access",
  ],
  guest_author: ["content:view", "content:create", "media:view", "admin:access"],
};

async function main() {
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: role,
      create: role,
    });
  }
  console.log(`Seeded ${ROLES.length} roles`);

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: permission.name },
      update: permission,
      create: permission,
    });
  }
  console.log(`Seeded ${PERMISSIONS.length} permissions`);

  for (const [roleName, permissionNames] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    for (const permissionName of permissionNames) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { name: permissionName } });
      await prisma.rolePermission.upsert({
        where: { role_id_permission_id: { role_id: role.id, permission_id: permission.id } },
        update: {},
        create: { role_id: role.id, permission_id: permission.id },
      });
    }
    console.log(`Granted ${permissionNames.length} permissions to ${roleName}`);
  }

  // Bootstrap: grant super_admin to the given email so at least one account
  // can manage users after a fresh install or migration.
  const bootstrapEmail = process.env.CMS_BOOTSTRAP_ADMIN_EMAIL;
  if (bootstrapEmail) {
    const user = await prisma.user.findUnique({ where: { email: bootstrapEmail } });
    if (user) {
      const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: "super_admin" } });
      await prisma.userRole.upsert({
        where: { user_id_role_id: { user_id: user.id, role_id: superAdmin.id } },
        update: {},
        create: { user_id: user.id, role_id: superAdmin.id },
      });
      console.log(`Granted super_admin to ${bootstrapEmail}`);
    } else {
      console.warn(`CMS_BOOTSTRAP_ADMIN_EMAIL=${bootstrapEmail} has no user row yet — log in once, then re-run the seed`);
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
