import { Metadata } from "next";
import { notFound } from "next/navigation";
import { PostEditor } from "@/components/cms/post-editor";
import { serverGetPostBySlug } from "@/lib/server-data";
import { auth } from "@/lib/auth";
import { loadActor } from "@/lib/rbac";
import { requirePageActor } from "@/lib/server-actor";

interface EditPostPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: EditPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  try {
    // Best-effort only — never redirect from metadata generation. The page
    // body below is what actually enforces the session/org gate.
    const session = await auth();
    if (!session?.user) return { title: "Edit Post" };
    const actor = await loadActor(session.user);
    if (!actor) return { title: "Edit Post" };
    const post = await serverGetPostBySlug(slug, actor.organizationId);
    return { title: post ? `Edit: ${post.title}` : "Edit Post" };
  } catch {
    return { title: "Edit Post" };
  }
}

export default async function EditPostPage({ params }: EditPostPageProps) {
  const { slug } = await params;
  const actor = await requirePageActor();

  const post = await serverGetPostBySlug(slug, actor.organizationId);
  if (!post) notFound();

  return (
    <div className="-m-6 h-[calc(100vh-4rem)] flex flex-col animate-fade-in">
      <PostEditor post={post} />
    </div>
  );
}
