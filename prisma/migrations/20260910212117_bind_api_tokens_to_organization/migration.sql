-- AlterTable
ALTER TABLE "api_tokens" ADD COLUMN     "organization_id" TEXT;

-- CreateIndex
CREATE INDEX "api_tokens_organization_id_idx" ON "api_tokens"("organization_id");

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: bind every existing token to the organization it was already
-- resolving to, so live tokens keep working across this deploy.
--
-- That org is whatever loadActor() would have picked: the owner's
-- current_organization_id when it names a real membership, else their first
-- membership. The old code read "first" from an unordered Prisma include, so
-- for a multi-org owner it was not actually deterministic — this pins the
-- earliest membership by inserted_at, which is what the session path
-- (getCurrentOrganizationId) has always used.
--
-- For a single-org owner this reproduces the previous behaviour exactly. For a
-- multi-org owner it may pin an org the token was not meant for; that was
-- already true of every request such a token made, and unlike before, the
-- binding is now visible in the token list, in /api/me and in the MCP `whoami`
-- tool, so a wrong pin can be seen and the token re-minted. Tokens whose owner
-- belongs to no organization stay NULL and are refused at request time — they
-- could not have carried any permission anyway.
UPDATE "api_tokens" t
SET "organization_id" = COALESCE(
  (
    SELECT u."current_organization_id"
    FROM "users" u
    JOIN "memberships" m
      ON m."user_id" = u."id"
     AND m."organization_id" = u."current_organization_id"
    WHERE u."id" = t."user_id"
  ),
  (
    SELECT m."organization_id"
    FROM "memberships" m
    WHERE m."user_id" = t."user_id"
    ORDER BY m."inserted_at" ASC, m."id" ASC
    LIMIT 1
  )
)
WHERE t."organization_id" IS NULL;
