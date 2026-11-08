// Copies CMS content from the Phoenix website database into this app's database.
//
//   SOURCE_DATABASE_URL=postgresql://postgres:postgres@localhost:5443/interactor_website_dev \
//     node scripts/migrate-from-website.mjs
//
// Idempotent: every row is upserted by its stable key (uuid id, slug, or email),
// so it can be re-run for dry runs against staging and again at cutover.
// Media files stay on S3 — only database rows move. Roles/permissions are NOT
// copied; they are matched by name against this app's seeded roles
// (run `npx prisma db seed` first).
//
// Ecto stores naive UTC timestamps; every timestamp column is read
// `AT TIME ZONE 'UTC'` so it lands as a correct timestamptz.
import "dotenv/config";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
if (!SOURCE_URL) {
  console.error("SOURCE_DATABASE_URL is required (the website's Postgres)");
  process.exit(1);
}

const source = new pg.Client({ connectionString: SOURCE_URL });
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const utc = (col) => `${col} AT TIME ZONE 'UTC' AS ${col}`;

async function rows(sql) {
  return (await source.query(sql)).rows;
}

async function migrateUsers() {
  const users = await rows(
    `SELECT id, email, name, external_id, status, avatar_url, bio,
            ${utc("last_login_at")}, ${utc("inserted_at")}, ${utc("updated_at")}
     FROM users`
  );
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {
        name: u.name,
        external_id: u.external_id,
        status: u.status ?? "active",
        avatar_url: u.avatar_url,
        bio: u.bio,
      },
      create: {
        id: u.id,
        email: u.email,
        name: u.name,
        external_id: u.external_id,
        status: u.status ?? "active",
        avatar_url: u.avatar_url,
        bio: u.bio,
        last_login_at: u.last_login_at,
        inserted_at: u.inserted_at,
      },
    });
  }
  console.log(`users: ${users.length}`);
}

async function migrateUserRoles() {
  const userRoles = await rows(
    `SELECT ur.user_id, r.name AS role_name, u.email
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     JOIN users u ON u.id = ur.user_id`
  );
  let applied = 0;
  for (const ur of userRoles) {
    const role = await prisma.role.findUnique({ where: { name: ur.role_name } });
    if (!role) {
      console.warn(`  skipping unknown role '${ur.role_name}' for ${ur.email} — run prisma db seed`);
      continue;
    }
    const user = await prisma.user.findUnique({ where: { email: ur.email } });
    if (!user) continue;
    await prisma.userRole.upsert({
      where: { user_id_role_id: { user_id: user.id, role_id: role.id } },
      update: {},
      create: { user_id: user.id, role_id: role.id },
    });
    applied++;
  }
  console.log(`user_roles: ${applied}/${userRoles.length}`);
}

async function migrateCategories() {
  const categories = await rows(
    `SELECT id, name, slug, description, color, sort_order, ${utc("inserted_at")}, ${utc("updated_at")}
     FROM categories`
  );
  for (const c of categories) {
    await prisma.category.upsert({
      where: { slug: c.slug },
      update: {
        name: c.name,
        description: c.description,
        color: c.color,
        sort_order: c.sort_order ?? 0,
      },
      create: {
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        color: c.color,
        sort_order: c.sort_order ?? 0,
        inserted_at: c.inserted_at,
      },
    });
  }
  console.log(`categories: ${categories.length}`);
}

async function migratePosts() {
  const posts = await rows(
    `SELECT id, title, slug, excerpt, content, meta_description, meta_keywords,
            status, type, featured_image, featured_image_alt, featured_image_metadata,
            author_name, reading_time, tags, workflow_status, rejection_reason,
            category_id, author_id, approved_by, content_format, content_styles,
            original_filename,
            ${utc("published_at")}, ${utc("approved_at")}, ${utc("inserted_at")}, ${utc("updated_at")}
     FROM posts`
  );
  // Guard relations: a post may reference a user/category that no longer exists here.
  const userIds = new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
  const categoryIds = new Set(
    (await prisma.category.findMany({ select: { id: true } })).map((c) => c.id)
  );

  for (const p of posts) {
    // Legacy posts published before the workflow existed carry
    // workflow_status 'draft'; normalize so published implies approved.
    const workflowStatus =
      p.status === "published" && (p.workflow_status ?? "draft") === "draft"
        ? "approved"
        : p.workflow_status ?? "draft";
    const data = {
      title: p.title ?? "",
      excerpt: p.excerpt,
      content: p.content,
      meta_description: p.meta_description,
      meta_keywords: p.meta_keywords,
      status: p.status ?? "draft",
      type: p.type ?? "blog",
      featured_image: p.featured_image,
      featured_image_alt: p.featured_image_alt,
      featured_image_metadata: p.featured_image_metadata ?? undefined,
      author_name: p.author_name,
      reading_time: p.reading_time,
      tags: p.tags ?? [],
      workflow_status: workflowStatus,
      rejection_reason: p.rejection_reason,
      content_format: p.content_format ?? "markdown",
      content_styles: p.content_styles,
      original_filename: p.original_filename,
      published_at: p.published_at,
      approved_at: p.approved_at,
      category_id: p.category_id && categoryIds.has(p.category_id) ? p.category_id : null,
      author_id: p.author_id && userIds.has(p.author_id) ? p.author_id : null,
      approved_by_id: p.approved_by && userIds.has(p.approved_by) ? p.approved_by : null,
      updated_at: p.updated_at,
    };
    await prisma.post.upsert({
      where: { slug: p.slug },
      update: data,
      create: { id: p.id, slug: p.slug, ...data, inserted_at: p.inserted_at },
    });
  }
  console.log(`posts: ${posts.length}`);
}

async function migrateMedia() {
  const media = await rows(
    `SELECT id, filename, original_filename, file_path, file_size, mime_type,
            alt_text, caption, width, height, uploaded_by, ${utc("inserted_at")}, ${utc("updated_at")}
     FROM media`
  );
  for (const m of media) {
    const data = {
      filename: m.filename,
      original_filename: m.original_filename ?? m.filename,
      file_path: m.file_path,
      file_size: m.file_size ?? 0,
      mime_type: m.mime_type ?? "application/octet-stream",
      alt_text: m.alt_text,
      caption: m.caption,
      width: m.width,
      height: m.height,
      uploaded_by: m.uploaded_by,
    };
    await prisma.media.upsert({
      where: { id: m.id },
      update: data,
      create: { id: m.id, ...data, inserted_at: m.inserted_at },
    });
  }
  console.log(`media: ${media.length}`);
}

async function migrateContentApprovals() {
  const approvals = await rows(
    `SELECT id, post_id, reviewer_id, action, comments,
            ${utc("reviewed_at")}, ${utc("inserted_at")}, ${utc("updated_at")}
     FROM content_approvals`
  );
  const postIds = new Set((await prisma.post.findMany({ select: { id: true } })).map((p) => p.id));
  const userIds = new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
  let applied = 0;
  for (const a of approvals) {
    if (!postIds.has(a.post_id)) continue;
    await prisma.contentApproval.upsert({
      where: { id: a.id },
      update: {},
      create: {
        id: a.id,
        post_id: a.post_id,
        reviewer_id: a.reviewer_id && userIds.has(a.reviewer_id) ? a.reviewer_id : null,
        action: a.action,
        comments: a.comments,
        reviewed_at: a.reviewed_at ?? a.inserted_at,
        inserted_at: a.inserted_at,
      },
    });
    applied++;
  }
  console.log(`content_approvals: ${applied}/${approvals.length}`);
}

async function migrateInvitations() {
  const invitations = await rows(
    `SELECT id, email, name, role_name, status, token, notes, external_id, invited_by_id,
            ${utc("expires_at")}, ${utc("accepted_at")}, ${utc("last_sent_at")},
            ${utc("inserted_at")}, ${utc("updated_at")}
     FROM invitations`
  );
  const userIds = new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
  for (const i of invitations) {
    await prisma.invitation.upsert({
      where: { token: i.token },
      update: { status: i.status },
      create: {
        id: i.id,
        email: i.email,
        name: i.name,
        role_name: i.role_name ?? "author",
        status: i.status ?? "pending",
        token: i.token,
        notes: i.notes,
        external_id: i.external_id,
        invited_by_id: i.invited_by_id && userIds.has(i.invited_by_id) ? i.invited_by_id : null,
        expires_at: i.expires_at ?? new Date(),
        accepted_at: i.accepted_at,
        last_sent_at: i.last_sent_at,
        inserted_at: i.inserted_at,
      },
    });
  }
  console.log(`invitations: ${invitations.length}`);
}

async function migrateContacts() {
  const contacts = await rows(
    `SELECT id, name, first_name, last_name, email, company, job_title, phone,
            product_interest, country, subject, message, type, status, source, metadata,
            ${utc("inserted_at")}, ${utc("updated_at")}
     FROM contact_submissions`
  );
  for (const c of contacts) {
    await prisma.contactSubmission.upsert({
      where: { id: c.id },
      update: { status: c.status ?? "new" },
      create: {
        id: c.id,
        firstName: c.first_name ?? c.name ?? "",
        lastName: c.last_name ?? "",
        email: c.email,
        company: c.company,
        jobTitle: c.job_title,
        phone: c.phone,
        productInterest: c.product_interest,
        country: c.country,
        subject: c.subject,
        message: c.message ?? "",
        type: c.type ?? "contact",
        status: c.status ?? "new",
        source: c.source,
        metadata: c.metadata ?? undefined,
        createdAt: c.inserted_at,
      },
    });
  }
  console.log(`contact_submissions: ${contacts.length}`);
}

async function migrateNewsletter() {
  const subs = await rows(
    `SELECT id, email, first_name, last_name, company, status, source, preferences, metadata,
            ${utc("confirmed_at")}, ${utc("unsubscribed_at")}, ${utc("inserted_at")}, ${utc("updated_at")}
     FROM newsletter_subscriptions`
  );
  for (const s of subs) {
    await prisma.newsletterSubscription.upsert({
      where: { email: s.email },
      update: { status: s.status ?? "active" },
      create: {
        id: s.id,
        email: s.email,
        firstName: s.first_name,
        lastName: s.last_name,
        company: s.company,
        status: s.status ?? "active",
        source: s.source,
        preferences: s.preferences ?? undefined,
        metadata: s.metadata ?? undefined,
        confirmedAt: s.confirmed_at,
        unsubscribedAt: s.unsubscribed_at,
        createdAt: s.inserted_at,
      },
    });
  }
  console.log(`newsletter_subscriptions: ${subs.length}`);
}

async function migrateWaitlist() {
  const entries = await rows(
    `SELECT id, email, status, source, metadata, ip_address, user_agent,
            ${utc("confirmed_at")}, ${utc("invited_at")}, ${utc("inserted_at")}, ${utc("updated_at")}
     FROM waitlist`
  );
  for (const w of entries) {
    await prisma.waitlist.upsert({
      where: { email: w.email },
      update: { status: w.status ?? "pending" },
      create: {
        id: w.id,
        email: w.email,
        status: w.status ?? "pending",
        source: w.source,
        metadata: w.metadata ?? undefined,
        ipAddress: w.ip_address,
        userAgent: w.user_agent,
        confirmedAt: w.confirmed_at,
        invitedAt: w.invited_at,
        createdAt: w.inserted_at,
      },
    });
  }
  console.log(`waitlist: ${entries.length}`);
}

async function main() {
  await source.connect();
  console.log("Migrating from website database...");
  await migrateUsers();
  await migrateUserRoles();
  await migrateCategories();
  await migratePosts();
  await migrateMedia();
  await migrateContentApprovals();
  await migrateInvitations();
  await migrateContacts();
  await migrateNewsletter();
  await migrateWaitlist();
  console.log("Done.");
}

main()
  .then(async () => {
    await source.end();
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await source.end().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
