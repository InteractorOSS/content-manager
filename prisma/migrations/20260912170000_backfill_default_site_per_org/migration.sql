-- src/lib/sites.ts no longer supplies "website" / "product-manager" as
-- virtual BUILT_IN_SITES (a shared, Interactor-branded default made no sense
-- once any org can self-serve sign up onto its own tenant). But the post
-- editor always sends an explicit `platforms` selection, and the create/
-- update routes validate an explicit selection against the org's REGISTERED
-- sites (orgSiteSlugs) — with none, every new post would be refused until
-- someone found Settings -> Sites first. New orgs get a real "website" row
-- from createOrganizationWithOwner going forward; this backfills the same
-- row for every org that already exists, so nothing already in production
-- (including Interactor's own org) loses the ability to create a post the
-- moment this deploys.

INSERT INTO "sites" ("id", "organization_id", "slug", "name", "sort_order", "updated_at")
SELECT
  'site_website_' || o."id",
  o."id",
  'website',
  'Website',
  0,
  NOW()
FROM "organizations" o
WHERE NOT EXISTS (
  SELECT 1 FROM "sites" s WHERE s."organization_id" = o."id" AND s."slug" = 'website'
);

-- Interactor's own org additionally has real posts already targeting
-- "product-manager" (the old BUILT_IN_SITES entry) — register that one too,
-- scoped to Interactor specifically, not as a generic per-org default (no
-- other org has ever used this slug).
INSERT INTO "sites" ("id", "organization_id", "slug", "name", "sort_order", "updated_at")
SELECT 'site_product_manager_interactor', 'org_interactor', 'product-manager', 'Product Manager', 1, NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "sites" WHERE "organization_id" = 'org_interactor' AND "slug" = 'product-manager'
)
AND EXISTS (SELECT 1 FROM "organizations" WHERE "id" = 'org_interactor');
