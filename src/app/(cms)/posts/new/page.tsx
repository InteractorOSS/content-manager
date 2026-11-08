import { Metadata } from "next";
import { PostEditor } from "@/components/cms/post-editor";

export const metadata: Metadata = {
  title: "New Post",
};

export default function NewPostPage() {
  return (
    <div className="-m-6 h-[calc(100vh-4rem)] flex flex-col animate-fade-in">
      <PostEditor />
    </div>
  );
}
