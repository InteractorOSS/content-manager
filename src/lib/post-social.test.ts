import { describe, expect, it, vi } from "vitest";
import { listPostSocial, parseSocialSave, savePostSocial } from "./post-social";
import { SOCIAL_NETWORKS } from "./social-networks";
import { SOCIAL_FORMATS } from "./ai/generate";

type Row = {
  id: string;
  network: string;
  body: string;
  parts?: unknown;
  status: string;
  updated_at: Date;
  scheduled_at: null;
  published_at: null;
};

function fakeDb(rows: Row[]) {
  return {
    socialPost: {
      findMany: vi.fn(async () => [...rows].sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { body: string } }) => ({
        ...rows.find((r) => r.id === where.id)!,
        ...data,
      })),
      create: vi.fn(async ({ data }: { data: { body: string; network: string } }) => ({
        id: "new",
        status: "draft",
        updated_at: new Date(),
        scheduled_at: null,
        published_at: null,
        ...data,
      })),
      delete: vi.fn(async () => ({})),
    },
  };
}

const row = (over: Partial<Row>): Row => ({
  id: "s1",
  network: "linkedin",
  body: "Old",
  status: "draft",
  updated_at: new Date(1000),
  scheduled_at: null,
  published_at: null,
  ...over,
});

it("the client-safe network list matches the AI fan-out's", () => {
  expect([...SOCIAL_NETWORKS]).toEqual([...SOCIAL_FORMATS]);
});

describe("listPostSocial", () => {
  it("returns the newest copy per network, in network order", async () => {
    const db = fakeDb([
      row({ id: "a", network: "twitter", updated_at: new Date(1) }),
      row({ id: "b", network: "linkedin", updated_at: new Date(2) }),
      row({ id: "c", network: "linkedin", updated_at: new Date(3), status: "published" }),
    ]);
    const list = await listPostSocial(db as never, "p1");
    expect(list.map((d) => [d.network, d.id, d.editable])).toEqual([
      ["linkedin", "c", false],
      ["twitter", "a", true],
    ]);
  });
});

describe("savePostSocial", () => {
  const save = (db: ReturnType<typeof fakeDb>, body: string) =>
    savePostSocial(db as never, { postId: "p1", network: "linkedin", body, userId: "u1" });

  it("edits the current draft in place", async () => {
    const db = fakeDb([row({})]);
    expect((await save(db, "New"))?.body).toBe("New");
    expect(db.socialPost.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { body: "New", parts: [] } });
  });

  it("starts a draft when there is none, linked to the post", async () => {
    const db = fakeDb([]);
    await save(db, "First");
    expect(db.socialPost.create.mock.calls[0][0].data).toMatchObject({
      body: "First",
      network: "linkedin",
      source_post_id: "p1",
      status: "draft",
    });
  });

  it("never rewrites copy that has gone out: a new draft instead", async () => {
    const db = fakeDb([row({ status: "published" })]);
    await save(db, "Follow-up");
    expect(db.socialPost.update).not.toHaveBeenCalled();
    expect(db.socialPost.create).toHaveBeenCalled();
  });

  // G#27: awaiting_manual (a manual-delivery target is waiting on a human to
  // paste it — nothing has actually gone out yet) is deliberately NOT in
  // LOCKED, same treatment as "scheduled": still editable in place, so a
  // typo can be fixed before the human posts it for real.
  it("edits copy in place while it's only awaiting_manual — nothing has gone out yet", async () => {
    const db = fakeDb([row({ status: "awaiting_manual" })]);
    expect((await save(db, "Fixed typo"))?.body).toBe("Fixed typo");
    expect(db.socialPost.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { body: "Fixed typo", parts: [] } });
    expect(db.socialPost.create).not.toHaveBeenCalled();
  });

  it("stores an X thread as its first tweet plus thread parts, and reads it back as the same text", async () => {
    const db = fakeDb([]);
    const saved = await savePostSocial(db as never, {
      postId: "p1",
      network: "twitter",
      body: "Hook\n---\nSecond tweet\n---\nThird tweet\n--- first comment\nRead it: the link",
      userId: "u1",
    });
    expect(db.socialPost.create.mock.calls[0][0].data).toMatchObject({
      body: "Hook",
      parts: [
        { kind: "thread", body: "Second tweet" },
        { kind: "thread", body: "Third tweet" },
        { kind: "first_comment", body: "Read it: the link" },
      ],
    });
    expect(saved?.body).toBe("Hook\n---\nSecond tweet\n---\nThird tweet\n--- first comment\nRead it: the link");
    expect(saved?.parts).toHaveLength(3);
  });

  it("keeps a --- line on LinkedIn as text, but takes its first comment", async () => {
    const db = fakeDb([]);
    await savePostSocial(db as never, {
      postId: "p1",
      network: "linkedin",
      body: "Part one\n---\nPart two\n--- First comment\nhttps://example.com",
      userId: "u1",
    });
    expect(db.socialPost.create.mock.calls[0][0].data).toMatchObject({
      body: "Part one\n---\nPart two",
      parts: [{ kind: "first_comment", body: "https://example.com" }],
    });
  });

  it("opens an X draft written before parts existed as the thread it was meant to be", async () => {
    const db = fakeDb([row({ network: "twitter", body: "One\n---\nTwo", parts: null })]);
    const [draft] = await listPostSocial(db as never, "p1");
    expect(draft.body).toBe("One\n---\nTwo");
    expect(draft.parts).toEqual([{ kind: "thread", body: "Two" }]);
  });

  it("an empty body removes an unscheduled draft, and only that", async () => {
    const draft = fakeDb([row({})]);
    expect(await save(draft, "  ")).toBeNull();
    expect(draft.socialPost.delete).toHaveBeenCalledWith({ where: { id: "s1" } });
    const scheduled = fakeDb([row({ status: "scheduled" })]);
    await save(scheduled, "");
    expect(scheduled.socialPost.delete).not.toHaveBeenCalled();
  });
});

describe("parseSocialSave", () => {
  it("accepts a known network and a string body", () => {
    expect(parseSocialSave({ network: "twitter", body: "hi" })).toEqual({ network: "twitter", body: "hi" });
  });
  it("refuses anything else", () => {
    expect(parseSocialSave({ network: "myspace", body: "hi" })).toHaveProperty("error");
    expect(parseSocialSave({ network: "twitter" })).toHaveProperty("error");
    expect(parseSocialSave(null)).toHaveProperty("error");
  });
  it("refuses an X text that splits into more parts than a post can carry", () => {
    const body = Array.from({ length: 40 }, (_, i) => `Tweet ${i + 1}`).join("\n---\n");
    expect(parseSocialSave({ network: "twitter", body })).toHaveProperty("error");
    // The same text is one post with literal dividers on LinkedIn, which has no threads.
    expect(parseSocialSave({ network: "linkedin", body })).toEqual({ network: "linkedin", body });
  });
});

describe("savePostSocial bound", () => {
  it("throws before any write when called with too many parts", async () => {
    const db = fakeDb([row({ network: "twitter" })]);
    const body = Array.from({ length: 40 }, (_, i) => `Tweet ${i + 1}`).join("\n---\n");
    await expect(
      savePostSocial(db as never, { postId: "p1", network: "twitter", body, userId: "u1" })
    ).rejects.toThrow(/at most 25/);
    expect(db.socialPost.update).not.toHaveBeenCalled();
    expect(db.socialPost.create).not.toHaveBeenCalled();
  });
});
