/**
 * Kebab any free-text label into a slug candidate. Dependency-free on
 * purpose — organizations.ts's slugifyOrgName (server-only: it imports
 * prisma) and the client-side manual-channel dialog (channels-manager.tsx)
 * both need the exact same lowercase/strip-punctuation/trim-hyphens logic,
 * and only a zero-import module like this one is safe to import from a
 * "use client" component without dragging prisma into the browser bundle.
 * Empty string means the input had nothing usable, so callers can reject it
 * or fall back to their own default.
 */
export function slugify(value: string, opts: { maxLength?: number } = {}): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return opts.maxLength ? slug.slice(0, opts.maxLength) : slug;
}
