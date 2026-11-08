-- One-post, short-lived edit keys for the Interactor Writing plugin's live
-- sync. See the PostEditKey model and src/lib/post-edit-keys.ts.

-- CreateTable
CREATE TABLE "post_edit_keys" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "api_token_id" TEXT,
    "site_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "key_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_edit_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "post_edit_keys_key_hash_key" ON "post_edit_keys"("key_hash");

-- CreateIndex
CREATE INDEX "post_edit_keys_post_id_user_id_idx" ON "post_edit_keys"("post_id", "user_id");

-- AddForeignKey
ALTER TABLE "post_edit_keys" ADD CONSTRAINT "post_edit_keys_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_edit_keys" ADD CONSTRAINT "post_edit_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_edit_keys" ADD CONSTRAINT "post_edit_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_edit_keys" ADD CONSTRAINT "post_edit_keys_api_token_id_fkey" FOREIGN KEY ("api_token_id") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
