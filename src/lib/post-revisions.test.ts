import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  MCP_DELEGATE_HEADER,
  RETENTION_CEILING,
  WRITING_CHECKPOINT_GAP_MS,
  postContentChanged,
  pruneOldRevisions,
  resolveRevisionSource,
  revisionSnapshotData,
  revisionsToPrune,
  writingSaveCheckpoints,
} from "./post-revisions";

const snapshot = {
  title: "Original title",
  content: "Original content",
  content_format: "markdown",
  content_html: "<p>Original content</p>",
  excerpt: "Original excerpt",
  content_hash: "hash-1",
};

describe("postContentChanged", () => {
  it("is false when no snapshotted field is present in the update", () => {
    expect(postContentChanged({ status: "published" } as never, snapshot)).toBe(false);
  });

  it("is false when a field is present but equals the existing value", () => {
    expect(postContentChanged({ title: "Original title" }, snapshot)).toBe(false);
  });

  it("is true when title changes", () => {
    expect(postContentChanged({ title: "New title" }, snapshot)).toBe(true);
  });

  it("is true when content changes", () => {
    expect(postContentChanged({ content: "New content" }, snapshot)).toBe(true);
  });

  it("is true when content_format changes", () => {
    expect(postContentChanged({ content_format: "html" }, snapshot)).toBe(true);
  });

  it("is true when excerpt changes", () => {
    expect(postContentChanged({ excerpt: "New excerpt" }, snapshot)).toBe(true);
  });
});

describe("resolveRevisionSource", () => {
  function req(headers: Record<string, string> = {}) {
    return new NextRequest("http://localhost/api/cms/posts/1", { headers });
  }

  it("is cms_ui for a browser session", () => {
    expect(resolveRevisionSource(req(), "session")).toBe("cms_ui");
  });

  it("is api for a bare PAT call", () => {
    expect(resolveRevisionSource(req(), "token")).toBe("api");
  });

  it("is mcp for a token call carrying the MCP delegate marker", () => {
    expect(resolveRevisionSource(req({ [MCP_DELEGATE_HEADER]: "1" }), "token")).toBe("mcp");
  });

  it("ignores the MCP marker on a session call (session always wins)", () => {
    expect(resolveRevisionSource(req({ [MCP_DELEGATE_HEADER]: "1" }), "session")).toBe("cms_ui");
  });
});

describe("revisionSnapshotData", () => {
  it("builds a create payload from the existing snapshot", () => {
    expect(revisionSnapshotData("post-1", snapshot, "user-1", "cms_ui")).toEqual({
      post_id: "post-1",
      title: snapshot.title,
      content: snapshot.content,
      content_format: snapshot.content_format,
      content_html: snapshot.content_html,
      excerpt: snapshot.excerpt,
      content_hash: snapshot.content_hash,
      edited_by_id: "user-1",
      source: "cms_ui",
    });
  });
});

describe("revisionsToPrune", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const at = (msAgo: number, id: string, label: string | null = null) => ({
    id,
    inserted_at: new Date(now.getTime() - msAgo),
    label,
  });
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("keeps every revision from the last day, however many", () => {
    const revs = Array.from({ length: 300 }, (_, i) => at(i * MIN, `r${i}`));
    expect(revisionsToPrune(revs, now)).toEqual([]);
  });

  it("keeps only the newest per hour between a day and a week old", () => {
    const base = 2 * DAY;
    const revs = [at(base + 5 * MIN, "newer"), at(base + 20 * MIN, "older-same-hour"), at(base + 2 * HOUR, "other-hour")];
    // "newer" and "older-same-hour" share an hour bucket (both inside the same clock hour here).
    const pruned = revisionsToPrune(revs, now);
    expect(pruned).toEqual(["older-same-hour"]);
  });

  it("keeps only the newest per day beyond a week", () => {
    const revs = [at(10 * DAY + HOUR, "a"), at(10 * DAY + 3 * HOUR, "b"), at(12 * DAY, "c")];
    expect(revisionsToPrune(revs, now)).toEqual(["b"]);
  });

  it("never thins a labelled checkpoint", () => {
    const revs = [at(10 * DAY + HOUR, "a"), at(10 * DAY + 3 * HOUR, "labelled", "Before the rewrite")];
    expect(revisionsToPrune(revs, now)).toEqual([]);
  });

  it("caps the survivors at the ceiling, dropping the oldest", () => {
    const revs = Array.from({ length: RETENTION_CEILING + 3 }, (_, i) => at(i * MIN, `r${i}`, "cp"));
    expect(revisionsToPrune(revs, now)).toEqual([
      `r${RETENTION_CEILING}`,
      `r${RETENTION_CEILING + 1}`,
      `r${RETENTION_CEILING + 2}`,
    ]);
  });
});

describe("writingSaveCheckpoints", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  it("checkpoints the first save of a session", () => {
    expect(writingSaveCheckpoints(null, now)).toBe(true);
  });
  it("doesn't checkpoint saves in the middle of a burst", () => {
    expect(writingSaveCheckpoints(new Date(now.getTime() - 5_000), now)).toBe(false);
  });
  it("checkpoints the first save after a pause", () => {
    expect(writingSaveCheckpoints(new Date(now.getTime() - WRITING_CHECKPOINT_GAP_MS), now)).toBe(true);
  });
});

describe("pruneOldRevisions", () => {
  const findMany = vi.fn();
  const deleteMany = vi.fn();
  const db = { postRevision: { findMany, deleteMany } };
  const now = new Date("2026-09-23T12:00:00Z");

  beforeEach(() => {
    findMany.mockReset();
    deleteMany.mockReset();
  });

  it("does nothing when the policy keeps everything", async () => {
    findMany.mockResolvedValue([{ id: "r1", inserted_at: now, label: null }]);
    await pruneOldRevisions(db, "post-1", now);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("deletes exactly the revisions the policy drops", async () => {
    const old = (h: number, id: string) => ({ id, inserted_at: new Date(now.getTime() - 10 * 86_400_000 - h * 3_600_000), label: null });
    findMany.mockResolvedValue([old(1, "keep"), old(2, "drop")]);
    await pruneOldRevisions(db, "post-1", now);
    expect(deleteMany).toHaveBeenCalledWith({ where: { post_id: "post-1", id: { in: ["drop"] } } });
  });
});
