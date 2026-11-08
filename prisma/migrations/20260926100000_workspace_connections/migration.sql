-- Workspace connections: one connection (the Interactor Writing plugin's)
-- that reaches every organization its accounts belong to, with each request
-- naming the account, organization and site. See src/lib/workspaces.ts.

-- AlterTable
ALTER TABLE "api_tokens" ADD COLUMN "all_organizations" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "oauth_authorization_codes" ALTER COLUMN "organization_id" DROP NOT NULL,
ADD COLUMN "all_organizations" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "linked_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "api_token_accounts" (
    "id" TEXT NOT NULL,
    "api_token_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_token_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_token_accounts_api_token_id_user_id_key" ON "api_token_accounts"("api_token_id", "user_id");

-- AddForeignKey
ALTER TABLE "api_token_accounts" ADD CONSTRAINT "api_token_accounts_api_token_id_fkey" FOREIGN KEY ("api_token_id") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token_accounts" ADD CONSTRAINT "api_token_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
