-- Add site scope to API tokens (G#21). An empty array (the default, which
-- ADD COLUMN also fills into every existing row) means the token acts on all
-- sites in its org, exactly as before. When populated, the token may only act
-- on posts targeting these sites — see src/lib/token-site-scope.ts.
--
-- Slugs are validated against the org's sites at mint time and never
-- re-validated: deleting a site leaves a token scoped to a slug nothing
-- targets, which reaches nothing, rather than silently widening it to all sites.

-- AddColumn
ALTER TABLE "api_tokens" ADD COLUMN "site_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
