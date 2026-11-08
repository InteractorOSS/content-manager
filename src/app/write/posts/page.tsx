import type { Metadata } from "next";
import { PostListLoader } from "@/components/writer/post-list-loader";

// The writer's post list, opened in Claude's browser panel by the
// open_post_list tool. Public route: it holds no data of its own and reads a
// short-lived browse key from the URL fragment. See src/components/writer/post-list.tsx.
export const metadata: Metadata = {
  title: "Posts | Interactor CMS",
  robots: { index: false, follow: false },
};

export default function WritePostsPage() {
  return <PostListLoader />;
}
