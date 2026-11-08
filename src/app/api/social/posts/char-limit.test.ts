import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The character limit is a WRITE-SEAM rule, not a browser courtesy.
 *
 * The composer has always counted characters, but `POST`/`PUT
 * /api/social/posts` never did — so a REST, MCP or fan-out caller could store
 * a body no network would take, and the only sign of it was an opaque provider
 * rejection inside `publishTarget` days later. These tests pin the refusal at
 * the door, and pin that a refused write changes nothing at all.
 */

const channelFindMany = vi.fn();
const postCreate = vi.fn();
const postFindUnique = vi.fn();
const postUpdate = vi.fn();
const targetDeleteMany = vi.fn();
const targetCreateMany = vi.fn();
const targetUpdateMany = vi.fn();
const transaction = vi.fn();

const db = {
  socialChannel: { findMany: (...a: unknown[]) => channelFindMany(...a) },
  socialPost: {
    create: (...a: unknown[]) => postCreate(...a),
    findUnique: (...a: unknown[]) => postFindUnique(...a),
    update: (...a: unknown[]) => postUpdate(...a),
  },
  socialPostTarget: {
    deleteMany: (...a: unknown[]) => targetDeleteMany(...a),
    createMany: (...a: unknown[]) => targetCreateMany(...a),
    updateMany: (...a: unknown[]) => targetUpdateMany(...a),
  },
  $transaction: (...a: unknown[]) => transaction(...a),
};

const permissions = new Set<string>([
  "content:create",
  "content:edit",
  "content:publish",
]);

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (_req: unknown, ...perms: string[]) => {
    const { NextResponse } = await import("next/server");
    const missing = perms.filter((p) => !permissions.has(p));
    if (missing.length > 0) {
      return {
        error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      };
    }
    return {
      actor: { user: { id: "u1" }, permissions },
      db,
    };
  }),
}));

import { POST } from "./route";
import { PUT } from "./[id]/route";

// --- fixtures --------------------------------------------------------------

const TWITTER = {
  id: "ch_x",
  service_id: "twitter",
  service_name: "X (Twitter)",
  account_name: "@interactor",
};
const SLACK = {
  id: "ch_slack",
  service_id: "slack",
  service_name: "Slack",
  account_name: "#launches",
};
/** A channel connected against a service this build has no adapter for. */
const MYSPACE = {
  id: "ch_myspace",
  service_id: "myspace",
  service_name: "MySpace",
  account_name: "tom",
};

function text(length: number): string {
  return "a".repeat(length);
}

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/social/posts", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function putReq(body: unknown) {
  return new NextRequest("http://localhost/api/social/posts/p1", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({ id: "p1" }) };

/** The channels this org has; the route asks for them by id. */
function seedChannels(...rows: { id: string }[]) {
  channelFindMany.mockImplementation(
    async ({ where }: { where: { id: { in: string[] } } }) =>
      rows.filter((r) => where.id.in.includes(r.id))
  );
}

function expectNothingWritten() {
  expect(postCreate).not.toHaveBeenCalled();
  expect(postUpdate).not.toHaveBeenCalled();
  expect(targetDeleteMany).not.toHaveBeenCalled();
  expect(targetCreateMany).not.toHaveBeenCalled();
  expect(targetUpdateMany).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const fn of [
    channelFindMany,
    postCreate,
    postFindUnique,
    postUpdate,
    targetDeleteMany,
    targetCreateMany,
    targetUpdateMany,
    transaction,
  ]) {
    fn.mockReset();
  }
  postCreate.mockResolvedValue({ id: "p_new", targets: [], media: [] });
  postUpdate.mockResolvedValue({ id: "p1", targets: [], media: [] });
  transaction.mockResolvedValue([]);
  postFindUnique.mockResolvedValue({
    id: "p1",
    status: "draft",
    body: "Ship it",
    targets: [],
  });
});

// --- POST ------------------------------------------------------------------

describe("POST /api/social/posts character limits", () => {
  it("refuses copy written for one channel that its own network won't take", async () => {
    seedChannels(TWITTER, SLACK);

    const res = await POST(
      postReq({
        body: "Short enough for everyone",
        channel_ids: [SLACK.id, TWITTER.id],
        body_overrides: { [TWITTER.id]: text(300) },
      })
    );

    expect(res.status).toBe(400);
    const { error } = await res.json();
    // Names the channel that refused, not just "too long".
    expect(error).toContain("X (Twitter)");
    expect(error).toContain("@interactor");
    expect(error).toContain("280");
    expect(error).toMatch(/Shorten/);
    // Slack takes 40,000 — the shared body was never the problem.
    expect(error).not.toContain("Slack");
    expectNothingWritten();
  });

  it("refuses a shared body over the smallest selected network's limit", async () => {
    seedChannels(TWITTER, SLACK);

    const res = await POST(
      postReq({ body: text(281), channel_ids: [SLACK.id, TWITTER.id] })
    );

    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("X (Twitter)");
    expect(error).toContain("280");
    // The shared body is over, so the fix offered is the shared one.
    expect(error).toMatch(/Shorten the message by 1 character/);
    expectNothingWritten();
  });

  it("accepts a body at exactly the limit", async () => {
    seedChannels(TWITTER);

    const res = await POST(
      postReq({ body: text(280), channel_ids: [TWITTER.id] })
    );

    expect(res.status).toBe(201);
    expect(postCreate).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default limit for a service with no adapter", async () => {
    seedChannels(MYSPACE);

    expect(
      (await POST(postReq({ body: text(5000), channel_ids: [MYSPACE.id] })))
        .status
    ).toBe(201);

    postCreate.mockClear();
    const res = await POST(
      postReq({ body: text(5001), channel_ids: [MYSPACE.id] })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("MySpace");
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("does not ask the database for channels when none are selected", async () => {
    const res = await POST(postReq({ body: text(100_000) }));

    expect(res.status).toBe(201);
    expect(channelFindMany).not.toHaveBeenCalled();
  });
});

// --- PUT -------------------------------------------------------------------

describe("PUT /api/social/posts/[id] character limits", () => {
  it("refuses before reconciling targets, so nothing is half-written", async () => {
    seedChannels(TWITTER, SLACK);
    postFindUnique.mockResolvedValue({
      id: "p1",
      status: "draft",
      body: "Ship it",
      targets: [
        { id: "t1", channel_id: SLACK.id, body_override: null },
      ],
    });

    const res = await PUT(
      putReq({
        body: "Ship it",
        // Adding X would delete/create targets and write overrides in three
        // separate statements — all of which must be skipped.
        channel_ids: [SLACK.id, TWITTER.id],
        body_overrides: { [TWITTER.id]: text(400) },
      }),
      ctx
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("X (Twitter)");
    expectNothingWritten();
  });

  it("checks the shared body against the targets the post already has", async () => {
    seedChannels(TWITTER);
    postFindUnique.mockResolvedValue({
      id: "p1",
      status: "draft",
      body: "Ship it",
      targets: [{ id: "t1", channel_id: TWITTER.id, body_override: null }],
    });

    // No channel_ids in the payload: the post keeps the channels it has.
    const res = await PUT(putReq({ body: text(400) }), ctx);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("X (Twitter)");
    expectNothingWritten();
  });

  it("lets a stored override shield a shared body the network would refuse", async () => {
    seedChannels(TWITTER, SLACK);
    postFindUnique.mockResolvedValue({
      id: "p1",
      status: "draft",
      body: "Ship it",
      targets: [
        { id: "t1", channel_id: SLACK.id, body_override: null },
        { id: "t2", channel_id: TWITTER.id, body_override: "Ship it (short)" },
      ],
    });

    // The payload never mentions X's copy, and the write wouldn't touch it —
    // so the check has to see the override that is already stored.
    const res = await PUT(putReq({ body: text(1000) }), ctx);

    expect(res.status).toBe(200);
    expect(postUpdate).toHaveBeenCalledTimes(1);
  });

  it("refuses when the payload blanks an override back onto a long shared body", async () => {
    seedChannels(TWITTER);
    postFindUnique.mockResolvedValue({
      id: "p1",
      status: "draft",
      body: text(1000),
      targets: [
        { id: "t2", channel_id: TWITTER.id, body_override: "Ship it (short)" },
      ],
    });

    const res = await PUT(putReq({ body_overrides: { [TWITTER.id]: "" } }), ctx);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("X (Twitter)");
    expectNothingWritten();
  });
});

describe("posts as ordered parts at the write seam", () => {
  const LINKEDIN = { id: "ch_li", service_id: "linkedin", service_name: "LinkedIn", account_name: "Interactor" };

  it("stores a thread whose every tweet fits, as parts beside the root", async () => {
    seedChannels(TWITTER);
    const parts = [
      { kind: "thread", body: text(280) },
      { kind: "first_comment", body: "Read it: https://interactor.com" },
    ];

    const res = await POST(postReq({ body: text(280), parts, channel_ids: [TWITTER.id] }));

    expect(res.status).toBe(201);
    expect(postCreate.mock.calls[0][0].data).toMatchObject({ body: text(280), parts });
  });

  it("refuses a thread with one tweet over the limit, naming the tweet, and writes nothing", async () => {
    seedChannels(TWITTER);

    const res = await POST(
      postReq({ body: "Hook", parts: [{ kind: "thread", body: text(290) }], channel_ids: [TWITTER.id] })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Tweet 2 of 2 for X (Twitter) (@interactor) is 290 characters long, and X (Twitter) only accepts 280 characters. Shorten it by 10 characters, and save again."
    );
    expectNothingWritten();
  });

  it("measures a thread as one post on a network that doesn't thread", async () => {
    seedChannels(LINKEDIN);

    const res = await POST(
      postReq({
        body: text(2000),
        parts: [{ kind: "thread", body: text(1500) }],
        channel_ids: [LINKEDIN.id],
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(
      /^Your message is 3,502 characters long once its thread is joined into one post \(LinkedIn doesn't post threads\), and LinkedIn only accepts 3,000 characters\./
    );
  });

  it("refuses a malformed part plainly", async () => {
    seedChannels(TWITTER);
    const res = await POST(postReq({ body: "Hi", parts: [{ kind: "reply", body: "x" }], channel_ids: [TWITTER.id] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Part 1 needs a kind of thread or first_comment.");
    expectNothingWritten();
  });

  it("PUT keeps the stored parts when the payload doesn't send any, and checks them", async () => {
    seedChannels(TWITTER);
    postFindUnique.mockResolvedValue({
      id: "p1",
      status: "draft",
      body: "Hook",
      parts: [{ kind: "thread", body: "Second" }],
      targets: [{ channel_id: TWITTER.id, body_override: null }],
    });

    const res = await PUT(putReq({ body: text(281) }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("The first tweet of the thread for X (Twitter)");

    const ok = await PUT(putReq({ parts: [{ kind: "thread", body: "Rewritten" }] }), ctx);
    expect(ok.status).toBe(200);
    expect(postUpdate.mock.calls[0][0].data).toMatchObject({
      body: "Hook",
      parts: [{ kind: "thread", body: "Rewritten" }],
    });
  });
});
