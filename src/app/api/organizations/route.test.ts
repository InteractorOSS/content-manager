import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const requireActor = vi.fn();
const createOrganizationWithOwner = vi.fn();
const userUpdate = vi.fn();

vi.mock("@/lib/guard", () => ({
  requireActor: (...a: unknown[]) => requireActor(...a),
}));

vi.mock("@/lib/organizations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/organizations")>(
    "@/lib/organizations"
  );
  return {
    ...actual,
    createOrganizationWithOwner: (...a: unknown[]) =>
      createOrganizationWithOwner(...a),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { user: { update: (...a: unknown[]) => userUpdate(...a) } },
}));

import { GET as listOrgs, POST as createOrg } from "./route";
import { POST as switchOrg } from "./switch/route";

const ORG_A = { id: "org-a", name: "Acme", slug: "acme", role: "owner" };
const ORG_B = { id: "org-b", name: "Beta", slug: "beta", role: "editor" };

function actorWith(organizations: typeof ORG_A[] = [ORG_A]) {
  return {
    actor: {
      user: { id: "user-1", email: "ada@interactor.com" },
      organizationId: organizations[0]?.id ?? null,
      organizations,
    },
  };
}

function post(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  requireActor.mockReset();
  createOrganizationWithOwner.mockReset();
  userUpdate.mockReset();
  userUpdate.mockResolvedValue({});
});

describe("GET /api/organizations", () => {
  it("returns only the caller's own memberships", async () => {
    requireActor.mockResolvedValue(actorWith([ORG_A, ORG_B]));

    const res = await listOrgs();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((o: { id: string }) => o.id)).toEqual(["org-a", "org-b"]);
    expect(body.meta.current_organization_id).toBe("org-a");
  });

  it("401s an unauthenticated caller", async () => {
    const { NextResponse } = await import("next/server");
    requireActor.mockResolvedValue({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await listOrgs();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/organizations", () => {
  it("creates an org and makes the caller its owner", async () => {
    requireActor.mockResolvedValue(actorWith([]));
    createOrganizationWithOwner.mockResolvedValue({
      id: "org-new",
      name: "Personal",
      slug: "personal",
      role: "owner",
    });

    const res = await createOrg(
      post("http://localhost/api/organizations", { name: "Personal" })
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.role).toBe("owner");
    // The membership-less caller is the self-serve signup case — it must NOT
    // be rejected for holding no permissions.
    expect(createOrganizationWithOwner).toHaveBeenCalledWith("user-1", "Personal");
  });

  it("rejects a blank name", async () => {
    requireActor.mockResolvedValue(actorWith());

    const res = await createOrg(
      post("http://localhost/api/organizations", { name: "   " })
    );

    expect(res.status).toBe(400);
    expect(createOrganizationWithOwner).not.toHaveBeenCalled();
  });

  it("bounds the name length before it reaches the database", async () => {
    requireActor.mockResolvedValue(actorWith());

    const res = await createOrg(
      post("http://localhost/api/organizations", { name: "x".repeat(121) })
    );

    expect(res.status).toBe(400);
    expect(createOrganizationWithOwner).not.toHaveBeenCalled();
  });

  it("never takes an organization id from the request body", async () => {
    requireActor.mockResolvedValue(actorWith());
    createOrganizationWithOwner.mockResolvedValue({
      id: "org-new",
      name: "X",
      slug: "x",
      role: "owner",
    });

    await createOrg(
      post("http://localhost/api/organizations", {
        name: "X",
        id: "org-someone-else",
        organization_id: "org-someone-else",
      })
    );

    expect(createOrganizationWithOwner).toHaveBeenCalledWith("user-1", "X");
  });
});

describe("POST /api/organizations/switch", () => {
  it("switches to an org the caller belongs to", async () => {
    requireActor.mockResolvedValue(actorWith([ORG_A, ORG_B]));

    const res = await switchOrg(
      post("http://localhost/api/organizations/switch", {
        organization_id: "org-b",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.current_organization_id).toBe("org-b");
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { current_organization_id: "org-b" },
    });
  });

  /**
   * Authorization is checked against the caller's OWN memberships, which come
   * from the session — so a guessed org id cannot move them into a tenant they
   * do not belong to, and must leave their active org untouched.
   */
  it("403s a non-member and leaves the active org unchanged", async () => {
    requireActor.mockResolvedValue(actorWith([ORG_A]));

    const res = await switchOrg(
      post("http://localhost/api/organizations/switch", {
        organization_id: "org-someone-else",
      })
    );

    expect(res.status).toBe(403);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("400s when no organization id is supplied", async () => {
    requireActor.mockResolvedValue(actorWith([ORG_A]));

    const res = await switchOrg(
      post("http://localhost/api/organizations/switch", {})
    );

    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller", async () => {
    const { NextResponse } = await import("next/server");
    requireActor.mockResolvedValue({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await switchOrg(
      post("http://localhost/api/organizations/switch", {
        organization_id: "org-a",
      })
    );

    expect(res.status).toBe(401);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
