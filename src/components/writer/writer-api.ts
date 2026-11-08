// Small client helpers the writer pages share. Every call carries the page's
// short-lived key as a bearer; nothing here reads the CMS session.

export const LIST_KEY_STORAGE = "interactor-cms-list-key";

export type WriterDetails = {
  slug: string;
  category: string;
  tags: string[];
  platforms: string[];
  featured_image: string;
  featured_image_alt: string;
  meta_description: string;
  meta_keywords: string;
};

export type WriterOptions = {
  categories: { name: string; slug: string }[];
  sites: { name: string; slug: string }[];
  tags: string[];
  can_upload: boolean;
  can_delete: boolean;
};

export type UploadedImage = { url: string; alt_text: string | null };

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error ?? `${fallback} (${res.status})`;
}

/** Upload an image in this editing session; returns its URL. */
export async function uploadImage(key: string, file: File, alt?: string): Promise<UploadedImage> {
  const form = new FormData();
  form.set("file", file);
  if (alt) form.set("alt_text", alt);
  const res = await fetch("/api/edit/media", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(await errorOf(res, "Couldn't upload the image"));
  return (await res.json()).data as UploadedImage;
}

/** Render a title-card featured image for the post; returns its URL. */
export async function generateTitleCard(key: string): Promise<UploadedImage> {
  const res = await fetch("/api/edit/featured-image", { method: "POST", headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(await errorOf(res, "Couldn't make a title card"));
  return (await res.json()).data as UploadedImage;
}


export { altFromFilename } from "./use-image-paste-drop";

/** Keep a list key that rode in on the editor's fragment (#key=…&list=…). */
export function storeListKeyFromHash(): void {
  const list = new URLSearchParams(window.location.hash.slice(1)).get("list");
  if (!list) return;
  try {
    sessionStorage.setItem(LIST_KEY_STORAGE, list);
  } catch {
    /* storage unavailable */
  }
}
