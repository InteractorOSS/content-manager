// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CmsUser, Me, Role } from "@/types/cms";

/**
 * The members admin renders the SAME rows twice — as cards below md and as a
 * table above it — because CSS, not JavaScript, picks between them. jsdom
 * applies no stylesheet, so both are in the document here and every query goes
 * through `all` + [0]. That duplication is the responsive treatment, not a bug.
 */

const api = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listRoles: vi.fn(),
  setMemberRole: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

const meState = vi.hoisted(() => ({ value: null as Me | null }));

vi.mock("@/hooks/use-me", () => ({
  useMe: () => ({
    me: meState.value,
    isLoading: false,
    can: (permission: string) => meState.value?.permissions.includes(permission) ?? false,
    organizations: meState.value?.organizations ?? [],
    currentOrg: null,
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { UsersManager } = await import("./users-manager");

class FakeApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

function member(overrides: Partial<CmsUser> = {}): CmsUser {
  return {
    membership_id: "m-1",
    id: "u-1",
    email: "ada@example.com",
    name: "Ada Lovelace",
    status: "active",
    avatar_url: null,
    membership_role: "editor",
    membership_role_display_name: "Editor",
    organization: { id: "org-1", name: "Interactor", slug: "interactor" },
    super_admin: false,
    post_count: 3,
    last_login_at: null,
    joined_at: "2026-01-01T00:00:00.000Z",
    inserted_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function role(name: string, display: string, assignable: boolean, scope: Role["scope"] = "organization"): Role {
  return {
    id: `r-${name}`,
    name,
    display_name: display,
    description: null,
    priority: 1,
    permissions: [],
    user_count: 1,
    scope,
    assignable,
  };
}

function signedInAs(overrides: Partial<Me> = {}): Me {
  return {
    user: { id: "u-me", email: "admin@example.com", name: "Admin", status: "active" },
    organization_id: "org-1",
    organization: { id: "org-1", name: "Interactor", slug: "interactor" },
    membership_role: "admin",
    organizations: [],
    roles: ["admin"],
    is_super_admin: false,
    permissions: ["users:view", "users:manage_roles", "users:edit"],
    auth_method: "session",
    token: null,
    ...overrides,
  } as Me;
}

function renderManager() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={client}>
      <UsersManager />
    </QueryClientProvider>
  );
  return { ...view, client, invalidate };
}

/**
 * Radix's Select probes pointer-capture and scrolls the active item into view;
 * jsdom implements neither, so opening the menu needs these stubs.
 */
function enableSelectMenu() {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

beforeEach(() => {
  meState.value = signedInAs();
  api.listUsers.mockResolvedValue([member()]);
  api.listRoles.mockResolvedValue([
    role("owner", "Owner", false),
    role("admin", "Administrator", true),
    role("editor", "Editor", true),
    role("author", "Author", true),
    role("super_admin", "Super administrator", false, "global"),
  ]);
  api.setMemberRole.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("members table", () => {
  it("shows the role in force in this organization", async () => {
    renderManager();
    await waitFor(() => expect(screen.getAllByText("Editor").length).toBeGreaterThan(0));
    // The global grant is a separate indicator, absent when not held.
    expect(screen.queryByText("Super admin")).toBeNull();
  });

  it("marks cross-org access with its own labelled indicator", async () => {
    api.listUsers.mockResolvedValue([member({ super_admin: true })]);
    renderManager();
    await waitFor(() => expect(screen.getAllByText("Super admin").length).toBeGreaterThan(0));
    // Still one organization role alongside it, not a merged list.
    expect(screen.getAllByText("Editor").length).toBeGreaterThan(0);
  });

  it("says the list didn't load rather than pretending the org is empty", async () => {
    api.listUsers.mockRejectedValue(new FakeApiError(500, "boom"));
    renderManager();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Try again");
    expect(alert.textContent).not.toContain("boom");
    expect(alert.textContent).not.toMatch(/\d{3}/);
    expect(screen.queryByText("No members yet")).toBeNull();
  });

  it("keeps the rows it already had when a refresh fails", async () => {
    api.listUsers.mockResolvedValueOnce([member()]);
    api.listUsers.mockRejectedValue(new TypeError("Failed to fetch"));
    const { client } = renderManager();
    await waitFor(() => expect(screen.getAllByText("Editor").length).toBeGreaterThan(0));

    await act(async () => {
      await client.refetchQueries({ queryKey: ["users"] });
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Check your connection");
    // The last thing the server said is still on screen.
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
  });

  it("offers a way back when a search matches nobody", async () => {
    renderManager();
    await waitFor(() => expect(screen.getAllByText("Editor").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Search members by name or email"), {
      target: { value: "zzz" },
    });
    expect(screen.getAllByText(/No members match/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Clear search" })[0]);
    expect(screen.queryByText(/No members match/)).toBeNull();
  });

  it("tells a lone admin how another member gets a role", async () => {
    api.listUsers.mockResolvedValue([member({ id: "u-me", membership_id: "m-me" })]);
    renderManager();
    expect(
      await screen.findByText(/You're the only member of Interactor/)
    ).toBeTruthy();
  });
});

describe("role editor", () => {
  async function openEditor() {
    const view = renderManager();
    await waitFor(() => expect(screen.getAllByText("Editor").length).toBeGreaterThan(0));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Change Ada Lovelace's role" })[0]
    );
    await screen.findByText("Change role");
    return view;
  }

  it("is a single choice, pre-selected to the member's current role", async () => {
    await openEditor();
    const trigger = screen.getByRole("combobox", { name: "Role" });
    expect(trigger.textContent).toContain("Editor");
    // Not a set: nothing to tick, so two roles can never both be requested.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("lists only the roles this admin may actually hand out", async () => {
    enableSelectMenu();
    await openEditor();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Role" }), { key: "Enter" });
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toContain("Editor");
    expect(options).toContain("Administrator");
    // Neither privileged grant is offered — the route would refuse both.
    expect(options).not.toContain("Owner");
    expect(options).not.toContain("Super administrator");
  });

  it("hides the global grant from an admin who cannot give it", async () => {
    await openEditor();
    expect(screen.queryByLabelText("Super administrator")).toBeNull();
  });

  it("offers the global grant to a super administrator", async () => {
    meState.value = signedInAs({ is_super_admin: true });
    await openEditor();
    expect(screen.getByLabelText("Super administrator")).toBeTruthy();
  });

  it("writes the single role and refreshes the caller's own permissions", async () => {
    const { invalidate } = await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    await waitFor(() =>
      expect(api.setMemberRole).toHaveBeenCalledWith("u-1", { role: "editor" })
    );
    await waitFor(() => {
      const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(keys).toContain(JSON.stringify({ queryKey: ["users"] }));
      expect(keys).toContain(JSON.stringify({ queryKey: ["me"] }));
    });
  });

  it("keeps the refusal on screen in the words the server used", async () => {
    const sentence =
      "This would leave you unable to manage roles, so you could not undo it. Ask another administrator or your organization's owner to change your own role.";
    api.setMemberRole.mockRejectedValue(new FakeApiError(400, sentence));
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("unable to manage roles");
  });

  it("translates a bare permission refusal into who to ask", async () => {
    api.setMemberRole.mockRejectedValue(new FakeApiError(403, "Forbidden"));
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("Forbidden");
    expect(alert.textContent).toContain("Ask an administrator");
  });

  it("explains rather than offers when the member is the sitting owner", async () => {
    api.listUsers.mockResolvedValue([
      member({ membership_role: "owner", membership_role_display_name: "Owner" }),
    ]);
    renderManager();
    await waitFor(() => expect(screen.getAllByText("Owner").length).toBeGreaterThan(0));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Change Ada Lovelace's role" })[0]
    );
    await screen.findByText("Change role");
    expect(screen.getByRole("combobox", { name: "Role" })).toHaveProperty("disabled", true);
    expect(
      screen.getByText(/Only the organization's owner can change the owner's role/)
    ).toBeTruthy();
  });
});
