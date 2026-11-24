-- What a browse key is for: "list" (the writer's post list, cms_list_) or
-- "mirror" (the Interactor CMS plugin's local posts folder, cms_mirror_).
-- Every existing row is a list key. Minting a key replaces only the caller's
-- earlier key of the same purpose, so the two never cut each other off.
ALTER TABLE "post_browse_keys" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'list';
