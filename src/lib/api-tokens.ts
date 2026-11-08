import { createHash, randomBytes } from "crypto";

const TOKEN_PREFIX = "cms_pat_";
const PREFIX_DISPLAY_LEN = 12;

/** Generate a new raw token — shown to the user exactly once. */
export function generateRawToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function displayPrefix(rawToken: string): string {
  return rawToken.slice(0, PREFIX_DISPLAY_LEN);
}

export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}
