import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeFile = vi.fn(async () => {});
const mkdir = vi.fn(async () => undefined);
const readFile = vi.fn();
vi.mock("fs/promises", () => ({ writeFile, mkdir, readFile }));

const uploadToS3 = vi.fn(async (_b: Buffer, name: string) => ({
  key: `prefix/${name}`,
  publicUrl: `https://bucket.example/${name}`,
}));
const readFromS3ByUrl = vi.fn();
vi.mock("@/lib/s3", () => ({
  isS3Configured: () => Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
  isOwnS3Url: (url: string) => url.startsWith("https://bucket.example/"),
  readFromS3ByUrl,
  uploadToS3,
}));

const {
  storeMediaFile,
  MediaStorageNotConfiguredError,
  mediaStorageErrorResponse,
  readMediaFile,
  MediaFileMissingError,
  MediaFileRefusedError,
} = await import(
  "@/lib/media-storage"
);

const buf = Buffer.from("x");

describe("storeMediaFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uploads to S3 when configured, in any environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "id");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    await expect(storeMediaFile(buf, "a.png", "image/png")).resolves.toBe("https://bucket.example/a.png");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("refuses in production without S3 instead of writing public/uploads", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(storeMediaFile(buf, "a.png", "image/png")).rejects.toBeInstanceOf(
      MediaStorageNotConfiguredError
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it("falls back to public/uploads outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(storeMediaFile(buf, "a.png", "image/png")).resolves.toBe("/uploads/a.png");
    expect(writeFile).toHaveBeenCalledOnce();
  });
});

describe("mediaStorageErrorResponse", () => {
  it("answers the storage error with a 503 naming the problem", async () => {
    const res = mediaStorageErrorResponse(new MediaStorageNotConfiguredError());
    expect(res?.status).toBe(503);
    const body = await res!.json();
    expect(body.code).toBe("media_storage_not_configured");
    expect(body.error).toMatch(/AWS_ACCESS_KEY_ID/);
  });

  it("leaves any other error alone", () => {
    expect(mediaStorageErrorResponse(new Error("boom"))).toBeNull();
  });
});

describe("readMediaFile", () => {
  const fetch = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AWS_ACCESS_KEY_ID", "id");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads our own S3 objects through the S3 API, not the public URL", async () => {
    readFromS3ByUrl.mockResolvedValue({ bytes: new Uint8Array([1, 2]), contentType: "image/png" });
    await expect(readMediaFile("https://bucket.example/170_a.png")).resolves.toEqual({
      bytes: new Uint8Array([1, 2]),
      contentType: "image/png",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls a deleted S3 object missing, so the publisher stops instead of retrying", async () => {
    readFromS3ByUrl.mockResolvedValue(null);
    await expect(readMediaFile("https://bucket.example/170_a.png")).rejects.toBeInstanceOf(
      MediaFileMissingError
    );
  });

  it("does not fall back to the public URL for an own-bucket file when S3 isn't configured", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    await expect(readMediaFile("https://bucket.example/170_a.png")).rejects.toBeInstanceOf(
      MediaStorageNotConfiguredError
    );
    expect(readFromS3ByUrl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the dev fallback from inside public/uploads", async () => {
    readFile.mockResolvedValue(Buffer.from([7]));
    await expect(readMediaFile("/uploads/170_x.jpg")).resolves.toEqual({
      bytes: new Uint8Array([7]),
      contentType: "image/jpeg",
    });
    expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/public[\\/]uploads[\\/]170_x\.jpg$/));
  });

  it.each([
    "/uploads/../../etc/x.jpg",
    "/uploads/%2e%2e/%2e%2e/etc/x.jpg",
    "/uploads/..%2f..%2fetc%2fx.jpg",
    "/uploads/a/../../x.jpg",
    "https://bucket.example/../other-prefix/x.png",
  ])("refuses the traversal path %s without reading anything", async (path) => {
    await expect(readMediaFile(path)).rejects.toBeInstanceOf(MediaFileRefusedError);
    expect(readFile).not.toHaveBeenCalled();
    expect(readFromS3ByUrl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses the dev fallback path in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(readMediaFile("/uploads/170_x.jpg")).rejects.toBeInstanceOf(MediaFileRefusedError);
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    "https://www.interactor.com/old.webp",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://localhost:4021/api/me",
    "file:///etc/passwd",
    "https://bucket.example.attacker.test/x.png",
  ])("refuses a file stored anywhere else (%s) without fetching it", async (url) => {
    await expect(readMediaFile(url)).rejects.toBeInstanceOf(MediaFileRefusedError);
    expect(fetch).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(readFromS3ByUrl).not.toHaveBeenCalled();
  });
});
