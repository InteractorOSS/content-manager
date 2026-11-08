-- The writer's post list in Claude's browser panel (/write/posts): a
-- short-lived browse key, and a source on edit keys so a session opened from
-- the list doesn't replace the one Claude's sync holds. See PostBrowseKey.

-- AlterTable
ALTER TABLE "post_edit_keys" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'connection';

-- CreateTable
CREATE TABLE "post_browse_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "api_token_id" TEXT,
    "site_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "site" TEXT,
    "key_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_browse_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "post_browse_keys_key_hash_key" ON "post_browse_keys"("key_hash");

-- CreateIndex
CREATE INDEX "post_browse_keys_user_id_organization_id_idx" ON "post_browse_keys"("user_id", "organization_id");

-- AddForeignKey
ALTER TABLE "post_browse_keys" ADD CONSTRAINT "post_browse_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_browse_keys" ADD CONSTRAINT "post_browse_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_browse_keys" ADD CONSTRAINT "post_browse_keys_api_token_id_fkey" FOREIGN KEY ("api_token_id") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
