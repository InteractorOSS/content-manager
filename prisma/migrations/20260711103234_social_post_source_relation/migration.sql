-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_source_post_id_fkey" FOREIGN KEY ("source_post_id") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
