import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const update = vi.fn();
const create = vi.fn();
const invitationFindFirst = vi.fn();
const membershipCount = vi.fn();
const createOrgWithOwner = vi.fn();
const userFindUnique = vi.fn();
const roleFindMany = vi.fn();
const roleFindUnique = vi.fn();
const invitationUpdate = vi.fn();
const membershipUpsert = vi.fn();
const userRoleUpsert = vi.fn();
const transaction = vi.fn();

vi.mock("./db", () => ({
  prisma: {
    user: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      update: (...a: unknown[]) => update(...a),
      create: (...a: unknown[]) => create(...a),
    },
    invitation: {
      findFirst: (...a: unknown[]) => invitationFindFirst(...a),
      update: (...a: unknown[]) => invitationUpdate(...a),
    },
    membership: {
      count: (...a: unknown[]) => membershipCount(...a),
      upsert: (...a: unknown[]) => membershipUpsert(...a),
    },
    userRole: { upsert: (...a: unknown[]) => userRoleUpsert(...a) },
    role: {
      findMany: (...a: unknown[]) => roleFindMany(...a),
      findUnique: (...a: unknown[]) => roleFindUnique(...a),
    },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
  isUniqueViolation: () => false,
}));

vi.mock("./organizations", () => ({
  createOrganizationWithOwner: (...a: unknown[]) => createOrgWithOwner(...a),
}));

import {
  loadActor,
  provisionUser,
  canSetAuthor,
  resolveOrgAuthor,
  resolveAuthorOverride,
  editPostRefusalMessage,
  canEditPost,
  type Actor,
} from "./rbac";
import type { TenantDb } from "./tenant-db";

beforeEach(() => {
  findFirst.mockReset();
  update.mockReset();
  create.mockReset();
  invitationFindFirst.mockReset();
  invitationFindFirst.mockResolvedValue(null);
  invitationUpdate.mockReset();
  invitationUpdate.mockImplementation((args) => ({ __op: "invitation.update", args }));
  membershipUpsert.mockReset();
  membershipUpsert.mockImplementation((args) => ({ __op: "membership.upsert", args }));
  userRoleUpsert.mockReset();
  userRoleUpsert.mockImplementation((args) => ({ __op: "userRole.upsert", args }));
  roleFindUnique.mockReset();
  roleFindUnique.mockImplementation(({ where }: { where: { name: string } }) =>
    Promise.resolve({ id: `role-${where.name}`, name: where.name, active: true })
  );
  transaction.mockReset();
  transaction.mockResolvedValue([]);
  membershipCount.mockReset();
  // Default: the user already belongs to an org, so the self-serve org create
  // stays out of the way of the provisioning tests below.
  membershipCount.mockResolvedValue(1);
  createOrgWithOwner.mockReset();
  createOrgWithOwner.mockResolvedValue({
    id: "org-new",
    name: "Ada's Organization",
    slug: "adas-organization",
    role: "owner",
  });
  userFindUnique.mockReset();
  roleFindMany.mockReset();
  roleFindMany.mockResolvedValue([]);
});

/** A user row shaped like ACTOR_INCLUDE returns it. */
function userRow(overrides: {
  current_organization_id?: string | null;
  memberships?: Array<{ organization_id: string; role: string; name?: string }>;
}) {
  return {
    id: "local-1",
    email: "ada@interactor.com",
    name: "Ada",
    status: "active",
    current_organization_id: overrides.current_organization_id ?? null,
    roles: [],
    memberships: (overrides.memberships ?? []).map((m) => ({
      organization_id: m.organization_id,
      role: m.role,
      organization: {
        id: m.organization_id,
        name: m.name ?? m.organization_id,
        slug: m.organization_id,
      },
    })),
  };
}

describe("loadActor — which organization is active", () => {
  /**
   * The regression this pins: a browser session resolves from the
   * current_organization_id COLUMN, which POST /api/organizations/switch
   * writes. The old sign-in-time snapshot (session.user.currentOrganizationId,
   * stamped by auth.ts's jwt callback only at sign-in and never refreshed) is
   * deliberately not consulted — when it outranked the column, every guarded
   * route kept serving the previous org and the switcher looked inert.
   */
  it("resolves a session from the column, so a switch takes effect at once", async () => {
    userFindUnique.mockResolvedValue(
      userRow({
        current_organization_id: "org-b",
        memberships: [
          { organization_id: "org-a", role: "owner" },
          { organization_id: "org-b", role: "editor" },
        ],
      })
    );

    const actor = await loadActor({ id: "local-1" });

    expect(actor?.organizationId).toBe("org-b");
    expect(actor?.membershipRole).toBe("editor");
  });

  /**
   * A PAT names exactly one org and may act on no other, so its org is an
   * authoritative override — a property of the token, not of whichever org its
   * owner last selected in a browser tab.
   */
  it("lets a credential's forced org override the stored preference", async () => {
    userFindUnique.mockResolvedValue(
      userRow({
        current_organization_id: "org-b",
        memberships: [
          { organization_id: "org-a", role: "owner" },
          { organization_id: "org-b", role: "editor" },
        ],
      })
    );

    const actor = await loadActor(
      { id: "local-1" },
      { forceOrganizationId: "org-a" }
    );

    expect(actor?.organizationId).toBe("org-a");
    expect(actor?.membershipRole).toBe("owner");
  });

  /**
   * The caller (actorFromApiTokenValue) asserts the resolved org equals the
   * token's, so this fallback is what turns "owner removed from the bound org"
   * into a rejected token rather than a silent hop to another tenant.
   */
  it("does not honour a forced org the user is not a member of", async () => {
    userFindUnique.mockResolvedValue(
      userRow({
        current_organization_id: null,
        memberships: [{ organization_id: "org-a", role: "owner" }],
      })
    );

    const actor = await loadActor(
      { id: "local-1" },
      { forceOrganizationId: "org-gone" }
    );

    expect(actor?.organizationId).toBe("org-a");
    expect(actor?.organizationId).not.toBe("org-gone");
  });

  it("falls back to the first membership when the column is unset", async () => {
    userFindUnique.mockResolvedValue(
      userRow({
        current_organization_id: null,
        memberships: [
          { organization_id: "org-a", role: "owner" },
          { organization_id: "org-b", role: "editor" },
        ],
      })
    );

    const actor = await loadActor({ id: "local-1" });

    expect(actor?.organizationId).toBe("org-a");
  });

  it("ignores an org the user is no longer a member of", async () => {
    userFindUnique.mockResolvedValue(
      userRow({
        current_organization_id: "org-removed",
        memberships: [{ organization_id: "org-a", role: "owner" }],
      })
    );

    const actor = await loadActor({ id: "local-1" });

    expect(actor?.organizationId).toBe("org-a");
  });

  it("exposes every membership for the switcher, sorted by name", async () => {
    userFindUnique.mockResolvedValue(
      userRow({
        current_organization_id: "org-a",
        memberships: [
          { organization_id: "org-z", role: "editor", name: "Zebra" },
          { organization_id: "org-a", role: "owner", name: "Acme" },
        ],
      })
    );

    const actor = await loadActor({ id: "local-1" });

    expect(actor?.organizations.map((o) => o.name)).toEqual(["Acme", "Zebra"]);
    expect(actor?.organizations.find((o) => o.id === "org-a")?.role).toBe("owner");
  });
});

describe("provisionUser — self-serve organization (U1)", () => {
  it("gives a user nobody invited an organization of their own", async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      id: "local-1",
      email: "ada@interactor.com",
      name: "Ada",
    });
    invitationFindFirst.mockResolvedValue(null);
    membershipCount.mockResolvedValue(0);

    await provisionUser({ externalId: "auth-123", email: "ada@interactor.com" });

    expect(createOrgWithOwner).toHaveBeenCalledWith("local-1", "Ada's Organization");
  });

  /**
   * The ordering guarantee behind "invitation-only joining of an existing org":
   * applyPendingInvitation has already created the Membership by the time
   * ensureOwnOrganization looks, so an invited user joins the INVITING org
   * instead of being shunted into a private one of their own.
   */
  it("does not create one for an invited user, who joins the inviting org", async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      id: "local-1",
      email: "ada@interactor.com",
      name: "Ada",
    });
    membershipCount.mockResolvedValue(1);

    await provisionUser({ externalId: "auth-123", email: "ada@interactor.com" });

    expect(createOrgWithOwner).not.toHaveBeenCalled();
  });

  it("falls back to the email local part when the identity has no name", async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      id: "local-1",
      email: "ada@interactor.com",
      name: null,
    });
    membershipCount.mockResolvedValue(0);

    await provisionUser({ externalId: "auth-123", email: "ada@interactor.com" });

    expect(createOrgWithOwner).toHaveBeenCalledWith("local-1", "ada's Organization");
  });
});

describe("provisionUser — accepting an invitation grants a membership only", () => {
  const invitation = (roleName: string) => ({
    id: "inv-1",
    email: "ada@interactor.com",
    role_name: roleName,
    organization_id: "org-a",
    status: "pending",
  });

  function signIn() {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ id: "local-1", email: "ada@interactor.com", name: "Ada" });
    membershipCount.mockResolvedValue(1);
    return provisionUser({ externalId: "auth-123", email: "ada@interactor.com" });
  }

  it("writes Membership.role and NO user_roles row", async () => {
    invitationFindFirst.mockResolvedValue(invitation("editor"));

    await signIn();

    expect(membershipUpsert).toHaveBeenCalledTimes(1);
    expect(membershipUpsert.mock.calls[0][0].update).toEqual({ role: "editor" });
    // The global grant has exactly one writer now — PUT /api/users/[id]/roles,
    // super_admin only. This used to mint one for whatever role was invited,
    // which made "invite yourself as super_admin" a real cross-tenant takeover.
    expect(userRoleUpsert).not.toHaveBeenCalled();
  });

  it("grants nothing for a legacy invitation naming the global role", async () => {
    // POST /api/invitations now refuses to create one of these, but rows from
    // before that gate can still be sitting pending in a live database.
    invitationFindFirst.mockResolvedValue(invitation("super_admin"));

    await signIn();

    expect(membershipUpsert).not.toHaveBeenCalled();
    expect(userRoleUpsert).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    // Left pending rather than marked accepted, so an admin can re-issue it.
    expect(invitationUpdate).not.toHaveBeenCalled();
  });
});

describe("provisionUser", () => {
  /**
   * The cross-account link this guard exists for is the EMPTY STRING, not
   * `undefined` — see the measured SQL in src/lib/prisma-or-undefined.test.ts.
   * `undefined` merely drops its OR branch, but `email: ""` compiles to a real
   * `OR email = ''`, and `User.email` is a non-null unique String, so one
   * blank-claim sign-in persists exactly the row the next one links to.
   *
   * `?.trim()` inside provisionUser turns a whitespace-only claim into that
   * empty string, so both shapes have to be refused before the lookup runs.
   */
  it("refuses to look anyone up when the identity carries no email", async () => {
    findFirst.mockResolvedValue({ id: "somebody-elses-account" });

    await expect(
      provisionUser({ externalId: "auth-123", email: undefined })
    ).rejects.toThrow(/no email address/i);

    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a blank or whitespace-only email", async () => {
    for (const email of ["", "   ", null]) {
      await expect(
        provisionUser({ externalId: "auth-123", email })
      ).rejects.toThrow(/no email address/i);
    }
    expect(findFirst).not.toHaveBeenCalled();
  });

  // Note the different reason from the email guard above: with `external_id`
  // undefined and an email present the SQL is a safe `WHERE email = $1`. What
  // this guard stops is the whitespace-only claim on the next line, which
  // trims to `""` — a value the unique `external_id` column stores, and which
  // the OR then matches for every later identity with a blank external id.
  it("refuses a whitespace-only external id, which persists as an empty unique key", async () => {
    await expect(
      provisionUser({ externalId: "  ", email: "ada@interactor.com" })
    ).rejects.toThrow(/no external id/i);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("says which value was missing, so the log line is actionable", async () => {
    await expect(
      provisionUser({ email: "ada@interactor.com" })
    ).rejects.toThrow(/^provisionUser: /);
  });

  it("queries on both trimmed identifiers when they are present", async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ id: "local-1", email: "ada@interactor.com" });

    await expect(
      provisionUser({
        externalId: " auth-123 ",
        email: " ada@interactor.com ",
        name: "Ada",
      })
    ).resolves.toBe("local-1");

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ external_id: "auth-123" }, { email: "ada@interactor.com" }],
      },
    });
    // Every branch carries a NON-EMPTY string. An empty one is the shape that
    // compiles to a live `email = ''` / `external_id = ''` comparison and
    // links whoever signs in next to the blank row a previous one left behind.
    const where = findFirst.mock.calls[0][0].where as {
      OR: Record<string, unknown>[];
    };
    for (const branch of where.OR) {
      expect(
        Object.values(branch).every((v) => typeof v === "string" && v !== "")
      ).toBe(true);
    }
  });

  it("links an existing row without clobbering its external id", async () => {
    findFirst.mockResolvedValue({ id: "local-1", external_id: "auth-original" });
    update.mockResolvedValue({ id: "local-1", email: "ada@interactor.com" });

    await expect(
      provisionUser({ externalId: "auth-123", email: "ada@interactor.com" })
    ).resolves.toBe("local-1");

    expect(update.mock.calls[0][0].data.external_id).toBe("auth-original");
  });
});

function makeActor(permissions: string[], overrides: Partial<Actor> = {}): Actor {
  return {
    user: { id: "u1", email: "author@example.com", name: "Author One", display_name: null, status: "active" },
    organizationId: "org1",
    membershipRole: "author",
    // Single membership in the actor's own org — the default shape for these
    // authorship tests, which don't exercise the switcher.
    organizations: [{ id: "org1", name: "Org One", slug: "org-one", role: "author" }],
    roles: ["author"],
    isSuperAdmin: false,
    permissions: new Set(permissions),
    ...overrides,
  };
}

describe("canSetAuthor", () => {
  it("requires content:edit_any — content:edit alone is not enough", () => {
    expect(canSetAuthor(makeActor(["content:edit"]))).toBe(false);
    expect(canSetAuthor(makeActor(["content:edit", "content:create"]))).toBe(false);
  });

  it("is granted by content:edit_any", () => {
    expect(canSetAuthor(makeActor(["content:edit_any"]))).toBe(true);
  });
});

describe("editPostRefusalMessage", () => {
  it("names the actual author and the permission that would lift the block", () => {
    const message = editPostRefusalMessage({ author_name: "Jane Doe" });
    expect(message).toContain("Jane Doe");
    expect(message).toContain("content:edit_any");
  });

  it("falls back to a generic label when the post has no author_name on file", () => {
    expect(editPostRefusalMessage({ author_name: null })).toContain("another user");
  });
});

describe("canEditPost — refusal path exercised alongside the message helper", () => {
  it("refuses an actor who only holds content:edit on someone else's post", () => {
    const actor = makeActor(["content:edit"]);
    expect(canEditPost(actor, { author_id: "someone-else" })).toBe(false);
  });
});

describe("resolveOrgAuthor", () => {
  const findUnique = vi.fn();
  const db = { membership: { findUnique: (...a: unknown[]) => findUnique(...a) } } as unknown as Pick<
    TenantDb,
    "membership"
  >;

  beforeEach(() => {
    findUnique.mockReset();
  });

  it("returns null without querying when the actor has no active org", async () => {
    await expect(resolveOrgAuthor(db, "u2", null)).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("looks up the compound (org, user) membership key — never a free-text id", async () => {
    findUnique.mockResolvedValue({
      user: { id: "u2", name: "Casey", email: "casey@example.com", status: "active" },
    });

    const result = await resolveOrgAuthor(db, "u2", "org1");

    expect(findUnique).toHaveBeenCalledWith({
      where: { organization_id_user_id: { organization_id: "org1", user_id: "u2" } },
      select: { user: { select: { id: true, name: true, display_name: true, email: true, status: true } } },
    });
    expect(result).toEqual({ id: "u2", name: "Casey", email: "casey@example.com" });
  });

  it("refuses a deactivated user — nobody could answer for a post credited to them", async () => {
    findUnique.mockResolvedValue({
      user: { id: "u2", name: "Casey", email: "casey@example.com", status: "inactive" },
    });

    await expect(resolveOrgAuthor(db, "u2", "org1")).resolves.toBeNull();
  });

  it("returns null for a user who isn't a member of that org", async () => {
    findUnique.mockResolvedValue(null);
    await expect(resolveOrgAuthor(db, "u2", "org1")).resolves.toBeNull();
  });
});

describe("resolveAuthorOverride", () => {
  const findUnique = vi.fn();
  const db = { membership: { findUnique: (...a: unknown[]) => findUnique(...a) } } as unknown as Pick<
    TenantDb,
    "membership"
  >;
  const current = { author_id: "u1", author_name: "Author One" };

  beforeEach(() => {
    findUnique.mockReset();
  });

  it("is a no-op — no query, no gate — when author_id round-trips the current author", async () => {
    const actor = makeActor(["content:edit"]);

    const outcome = await resolveAuthorOverride(db, actor, { author_id: "u1" }, current);

    expect(outcome).toEqual({ ok: true, authorNameTouched: false, authorName: "Author One" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("treats explicit null the same as absent for both fields — never coerces to the string \"null\"", async () => {
    const actor = makeActor(["content:edit"]);

    const outcome = await resolveAuthorOverride(
      db,
      actor,
      { author_id: null, author_name: null },
      current
    );

    expect(outcome).toEqual({ ok: true, authorNameTouched: false, authorName: "Author One" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("is a no-op for an unchanged author_name — no gate for an ordinary author's save", async () => {
    const actor = makeActor(["content:edit"]);

    const same = await resolveAuthorOverride(db, actor, { author_name: "Author One" }, current);
    expect(same).toEqual({ ok: true, authorNameTouched: false, authorName: "Author One" });
  });

  it("is a no-op for a blank author_name when there is nothing to clear (create's null baseline)", async () => {
    const actor = makeActor(["content:edit"]);

    const blank = await resolveAuthorOverride(
      db,
      actor,
      { author_name: "" },
      { author_id: "u1", author_name: null }
    );
    expect(blank).toEqual({ ok: true, authorNameTouched: false, authorName: null });
  });

  it("treats a blank author_name against a real existing value as a clear — gated like any other change", async () => {
    // Restores the capability that existed (ungated) before this goal:
    // clearing an existing post's byline to null. Now it requires
    // content:edit_any like any other authorship change, and an ordinary
    // author is refused rather than silently no-op'd.
    const noPermission = makeActor(["content:edit"]);
    const refused = await resolveAuthorOverride(db, noPermission, { author_name: "" }, current);
    expect(refused).toEqual({
      ok: false,
      status: 403,
      error: "Setting a post's author name requires content:edit_any",
    });

    const privileged = makeActor(["content:edit", "content:edit_any"]);
    const cleared = await resolveAuthorOverride(db, privileged, { author_name: "" }, current);
    expect(cleared).toEqual({ ok: true, authorNameTouched: true, authorName: null });
  });

  it("refuses a real author_id change without content:edit_any", async () => {
    const actor = makeActor(["content:edit"]);

    const outcome = await resolveAuthorOverride(db, actor, { author_id: "u2" }, current);

    expect(outcome).toEqual({
      ok: false,
      status: 403,
      error: "Crediting a post to another user requires content:edit_any",
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("resolves a real author_id change for a content:edit_any holder, ignoring a diverging author_name", async () => {
    const actor = makeActor(["content:edit", "content:edit_any"]);
    findUnique.mockResolvedValue({
      user: { id: "u2", name: "Casey Writer", email: "casey@example.com", status: "active" },
    });

    const outcome = await resolveAuthorOverride(
      db,
      actor,
      { author_id: "u2", author_name: "Ghost Writer" },
      current
    );

    expect(outcome).toEqual({
      ok: true,
      authorId: "u2",
      authorNameTouched: true,
      authorName: "Casey Writer",
    });
  });

  it("400s an author_id that doesn't name a member of the org", async () => {
    const actor = makeActor(["content:edit", "content:edit_any"]);
    findUnique.mockResolvedValue(null);

    const outcome = await resolveAuthorOverride(db, actor, { author_id: "u2" }, current);

    expect(outcome).toEqual({
      ok: false,
      status: 400,
      error: "author_id must be a member of your organization",
    });
  });

  it("alsoUnchangedIfNamed: is a no-op for a caller redundantly naming themselves, even with different casing", async () => {
    const actor = makeActor(["content:edit"]);
    const createCurrent = { author_id: "u1", author_name: null };

    const exact = await resolveAuthorOverride(
      db,
      actor,
      { author_name: "Author One" },
      createCurrent,
      "Author One"
    );
    expect(exact).toEqual({ ok: true, authorNameTouched: false, authorName: null });

    const differentCase = await resolveAuthorOverride(
      db,
      actor,
      { author_name: "author one" },
      createCurrent,
      "Author One"
    );
    expect(differentCase).toEqual({ ok: true, authorNameTouched: false, authorName: null });
  });

  it("alsoUnchangedIfNamed does not exempt a genuinely different name from the gate", async () => {
    const actor = makeActor(["content:edit"]);

    const outcome = await resolveAuthorOverride(
      db,
      actor,
      { author_name: "Someone Else" },
      { author_id: "u1", author_name: null },
      "Author One"
    );

    expect(outcome).toEqual({
      ok: false,
      status: 403,
      error: "Setting a post's author name requires content:edit_any",
    });
  });
});
