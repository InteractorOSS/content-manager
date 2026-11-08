import { Metadata } from "next";
import { CategoryManager } from "@/components/cms/category-manager";

export const metadata: Metadata = {
  title: "Categories",
};

export default function CategoriesPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Categories</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Organize your posts into categories
        </p>
      </div>
      <CategoryManager />
    </div>
  );
}
