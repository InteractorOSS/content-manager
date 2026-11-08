import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

// Mirrors the website's S3 setup (apps/interactor_web/lib/interactor_web/s3.ex):
// same bucket, key prefix, and "{timestamp}_{filename}" naming, so media
// uploaded from either app lands in one place and existing URLs stay valid.
const BUCKET = process.env.S3_BUCKET || "interactor-media";
const PREFIX = process.env.S3_PREFIX || "www.interactor.com/images/";
const REGION = process.env.AWS_REGION || "us-west-2";
const PUBLIC_URL_BASE =
  process.env.S3_PUBLIC_URL || `https://${BUCKET}.s3.${REGION}.amazonaws.com/${PREFIX}`;

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({ region: REGION });
  }
  return client;
}

export function isS3Configured(): boolean {
  return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

export async function uploadToS3(
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<{ key: string; publicUrl: string }> {
  const uniqueFilename = `${Date.now()}_${filename}`;
  const key = `${PREFIX}${uniqueFilename}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "public-read",
    })
  );

  return { key, publicUrl: `${PUBLIC_URL_BASE}${uniqueFilename}` };
}

/** Best-effort delete for media whose file_path is one of our public S3 URLs. */
export async function deleteFromS3ByUrl(fileUrl: string): Promise<void> {
  if (!fileUrl.startsWith(PUBLIC_URL_BASE)) return;
  const key = `${PREFIX}${fileUrl.slice(PUBLIC_URL_BASE.length)}`;
  await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/** Whether `fileUrl` is one of the public URLs this bucket/prefix hands out. */
export function isOwnS3Url(fileUrl: string): boolean {
  return fileUrl.startsWith(PUBLIC_URL_BASE);
}

/**
 * The bytes of one of our public S3 objects (`isOwnS3Url`), read through the
 * API with this server's credentials rather than over the public URL. Null
 * when the object no longer exists.
 */
export async function readFromS3ByUrl(
  fileUrl: string
): Promise<{ bytes: Uint8Array; contentType: string | null } | null> {
  const key = `${PREFIX}${fileUrl.slice(PUBLIC_URL_BASE.length)}`;
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!res.Body) return null;
    return { bytes: await res.Body.transformToByteArray(), contentType: res.ContentType ?? null };
  } catch (err) {
    if ((err as { name?: unknown })?.name === "NoSuchKey") return null;
    throw err;
  }
}
