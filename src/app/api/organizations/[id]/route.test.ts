import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const requireActor = vi.fn();
const orgFindUnique = vi.fn();
const orgUpdate = vi.fn();

vi.mock("@/lib/guard", () => ({
  requireActor: (...a: unknown[]) => requireActor(...a),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    organization: {
      findUnique: (...a: unknown[]) => orgFindUnique(...a),
      update: (...a: unknown[]) => orgUpdate(...a),
    },
  },
}));

import { GET as getOrg, PATCH as patchOrg } from "./route";

const OWNER = { id: "org-a", name: "Acme", slug: "acme", role: "owner" };
const EDITOR = { id: "org-a", name: "Acme", slug: "acme", role: "editor" };

function actorWith(organizations: Array<typeof OWNER>) {
  return {
    actor: {
      user: { id: "user-1" },
      organizationId: organizations[0]?.id ?? null,
      organizations,
    },
  };
}

function patch(body: unknown) {
  return new NextRequest("http://localhost/api/organizations/org-a", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ id: "org-a" });

beforeEach(() => {
  requireActor.mockReset();
  orgFindUnique.mockReset();
  orgUpdate.mockReset();
});

describe("GET /api/organizations/[id]", () => {
  it("returns the org for a member", async () => {
    requireActor.mockResolvedValue(actorWith([OWNER]));
    orgFindUnique.mockResolvedValue({
      id: "org-a",
      name: "Acme",
      slug: "acme",
      logo: null,
      branding: null,
      inserted_at: new Date(),
    });

    const res = await getOrg(
      new NextRequest("http://localhost/api/organizations/org-a"),
      { params }
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.role).toBe("owner");
  });

  /**
   * A non-member gets 403 and the org is never read. Answering 404 here would
   * leak which org ids exist to any signed-in user willing to enumerate.
   */
  it("403s a non-member without touching the database", async () => {
    requireActor.mockResolvedValue(actorWith([]));

    const res = await getOrg(
      new NextRequest("http://localhost/api/organizations/org-a"),
      { params }
    );

    expect(res.status).toBe(403);
    expect(orgFindUnique).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/organizations/[id]", () => {
  it("lets an owner rename the org", async () => {
    requireActor.mockResolvedValue(actorWith([OWNER]));
    orgUpdate.mockResolvedValue({
      id: "org-a",
      name: "Acme Inc",
      slug: "acme",
      logo: null,
      branding: null,
    });

    const res = await patchOrg(patch({ name: "Acme Inc" }), { params });

    expect(res.status).toBe(200);
    expect(orgUpdate.mock.calls[0][0].data.name).toBe("Acme Inc");
  });

  it("403s a member whose role cannot manage settings", async () => {
    requireActor.mockResolvedValue(actorWith([EDITOR]));

    const res = await patchOrg(patch({ name: "Hijacked" }), { params });

    expect(res.status).toBe(403);
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("403s a non-member", async () => {
    requireActor.mockResolvedValue(actorWith([]));

    const res = await patchOrg(patch({ name: "Hijacked" }), { params });

    expect(res.status).toBe(403);
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("normalizes a slug rather than rejecting spaces", async () => {
    requireActor.mockResolvedValue(actorWith([OWNER]));
    orgUpdate.mockResolvedValue({
      id: "org-a",
      name: "Acme",
      slug: "my-org",
      logo: null,
      branding: null,
    });

    await patchOrg(patch({ slug: "My Org" }), { params });

    expect(orgUpdate.mock.calls[0][0].data.slug).toBe("my-org");
  });

  it("rejects a slug with nothing usable in it", async () => {
    requireActor.mockResolvedValue(actorWith([OWNER]));

    const res = await patchOrg(patch({ slug: "!!!" }), { params });

    expect(res.status).toBe(400);
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("surfaces a slug collision as a clear 409, not a 500", async () => {
    requireActor.mockResolvedValue(actorWith([OWNER]));
    const { Prisma } = await import("@prisma/client");
    orgUpdate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "7.8.0",
      })
    );

    const res = await patchOrg(patch({ slug: "taken" }), { params });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already in use/i);
  });
});
