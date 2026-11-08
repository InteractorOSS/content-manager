import { writeFile, mkdir, readFile } from "fs/promises";
import { extname, join, resolve, sep } from "path";
import { NextResponse } from "next/server";
import { isOwnS3Url, isS3Configured, readFromS3ByUrl, uploadToS3 } from "@/lib/s3";

/**
 * Thrown when a production server has no S3 credentials. The local-disk
 * fallback is dev-only: a production Next.js server does not serve files
 * written to public/ after it started, and a deploy replaces the directory
 * anyway. Falling back silently is how cms.interactor.com stored every upload
 * at a /uploads/... URL that 404'd — so production refuses instead.
 */
export class MediaStorageNotConfiguredError extends Error {
  constructor() {
    super(
      "Media storage isn't configured on this server (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set), so the file was not saved. Ask an administrator to configure S3."
    );
    this.name = "MediaStorageNotConfiguredError";
  }
}

/** True where the dev-only public/uploads fallback may be used. */
export function localMediaFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Persist an uploaded (or generated) media file and return the path to store
 * on the Media row / post. Production media lives on S3 (shared with the
 * website); local disk under public/uploads is a dev-only fallback when AWS
 * credentials are absent, and production throws MediaStorageNotConfiguredError
 * rather than using it. One place so the upload route and generated featured
 * images can't drift apart.
 */
export async function storeMediaFile(
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<string> {
  if (isS3Configured()) {
    const uploaded = await uploadToS3(buffer, filename, contentType);
    return uploaded.publicUrl;
  }
  if (!localMediaFallbackAllowed()) {
    console.error("[media-storage] refusing upload: S3 is not configured in production");
    throw new MediaStorageNotConfiguredError();
  }
  const uploadDir = join(process.cwd(), "public", "uploads");
  await mkdir(uploadDir, { recursive: true });
  await writeFile(join(uploadDir, filename), buffer);
  return `/uploads/${filename}`;
}

/** 503 carrying the error's sentence, or null if `err` is anything else. */
export function mediaStorageErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof MediaStorageNotConfiguredError)) return null;
  return NextResponse.json({ error: err.message, code: "media_storage_not_configured" }, { status: 503 });
}

/** A stored media file that is no longer where its Media row says it is. */
export class MediaFileMissingError extends Error {
  constructor(url: string) {
    super(`The media file at ${url} no longer exists`);
    this.name = "MediaFileMissingError";
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

function mimeFromName(name: string): string {
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * A stored media path this server will not read: neither an object under our
 * own S3 bucket/prefix nor, outside production, a file inside public/uploads
 * — a row imported from another site, or a path that climbs out with `..`.
 * Refused before any read or fetch: the bytes are handed to a public social
 * network, so the server must never go and get an arbitrary address for it.
 */
export class MediaFileRefusedError extends Error {
  constructor(filePath: string) {
    super(`The media file at ${filePath} is not in this server's media storage`);
    this.name = "MediaFileRefusedError";
  }
}

/** True when any `/`- or `\`-separated segment of `path` is `.` or `..`. */
function hasDotSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === "." || segment === "..");
}

/**
 * The bytes of a stored media file, by the `file_path` `storeMediaFile`
 * returned — what a network that takes uploads (X, LinkedIn, Facebook) is
 * sent. Exactly two places are ever read: an object under our own S3
 * bucket/prefix, through the S3 API, and — outside production only — a file
 * that resolves inside public/uploads. Anything else (another host, a `..`
 * segment, the dev path in production) is a MediaFileRefusedError with no I/O
 * at all. Throws MediaFileMissingError when the file is gone, so the publisher
 * can say so instead of retrying.
 */
export async function readMediaFile(filePath: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const path = filePath.split(/[?#]/)[0];

  if (isOwnS3Url(path)) {
    if (hasDotSegment(path.slice(path.indexOf("://") + 3))) throw new MediaFileRefusedError(filePath);
    if (!isS3Configured()) throw new MediaStorageNotConfiguredError();
    const object = await readFromS3ByUrl(path);
    if (!object) throw new MediaFileMissingError(filePath);
    return { bytes: object.bytes, contentType: object.contentType ?? mimeFromName(path) };
  }

  if (localMediaFallbackAllowed() && path.startsWith("/uploads/")) {
    let name: string;
    try {
      name = decodeURIComponent(path.slice("/uploads/".length));
    } catch {
      throw new MediaFileRefusedError(filePath);
    }
    const root = resolve(process.cwd(), "public", "uploads");
    const file = resolve(root, name);
    if (!name || hasDotSegment(name) || !file.startsWith(root + sep)) {
      throw new MediaFileRefusedError(filePath);
    }
    try {
      const bytes = await readFile(file);
      return { bytes: new Uint8Array(bytes), contentType: mimeFromName(file) };
    } catch (err) {
      if ((err as { code?: unknown })?.code === "ENOENT") throw new MediaFileMissingError(filePath);
      throw err;
    }
  }

  throw new MediaFileRefusedError(filePath);
}
