-- A byline name the person chooses; never overwritten by SSO sign-in.
ALTER TABLE "users" ADD COLUMN "display_name" TEXT;
