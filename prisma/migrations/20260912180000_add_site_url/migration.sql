-- Site.url is the site's base URL (e.g. https://example.com), used to build
-- the per-site RSS feed's <link> and the sitemap's <loc> entries. It's
-- NOT NULL going forward: a site nobody can build a link for isn't
-- meaningfully registered.
--
-- Every existing row -- both sites an org already registered before this
-- shipped, and the ones the previous migration
-- (20260912170000_backfill_default_site_per_org) just created -- predates
-- the column and has no real URL on file. There's no way to infer one, so
-- each gets a placeholder derived from the org's own slug under a fake
-- domain: obviously wrong so it gets noticed and corrected from
-- Settings -> Sites, and a *path* rather than a *subdomain* so fixing it
-- never looks like it requires new DNS.

ALTER TABLE "sites" ADD COLUMN "url" TEXT;

UPDATE "sites" s
SET "url" = 'https://example.com/' || o."slug"
FROM "organizations" o
WHERE s."organization_id" = o."id" AND s."url" IS NULL;

ALTER TABLE "sites" ALTER COLUMN "url" SET NOT NULL;
