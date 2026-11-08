// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Invitation, Me, Role } from "@/types/cms";

/**
 * The invitations tab shares `/users` with the members tab, so it has to fail
 * the same way: a plain sentence plus something to do about it, never the
 * guard's "Forbidden" or the API client's "HTTP 502" fallback. These pin the
 * surfaces that used to render `ApiError.message` straight to the page.
 */

const api = vi.hoisted(() => ({
  listInvitations: vi.fn(),
  createInvitation: vi.fn(),
  resendInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  listRoles: vi.fn(),
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

const toastState = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastState }));

const { InvitationsManager } = await import("./invitations-manager");

/** Same shape as ApiError in src/lib/api.ts, without importing the client. */
class FakeApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: "inv-1",
    email: "ada@example.com",
    name: "Ada Lovelace",
    role_name: "author",
    status: "pending",
    invited_by: null,
    expires_at: "2026-12-01T00:00:00.000Z",
    inserted_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Invitation;
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

function signedInAs(): Me {
  return {
    user: { id: "u-me", email: "admin@example.com", name: "Admin", display_name: null, status: "active" },
    organization_id: "org-1",
    organization: { id: "org-1", name: "Interactor", slug: "interactor" },
    membership_role: "admin",
    organizations: [],
    roles: ["admin"],
    is_super_admin: false,
    permissions: ["users:view", "users:create"],
    auth_method: "session",
    token: null,
  } as Me;
}

function renderManager() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <InvitationsManager />
      </QueryClientProvider>
    ),
    client,
  };
}

async function openInviteDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Invite user" }));
  fireEvent.change(await screen.findByLabelText("Email"), {
    target: { value: "ada@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
}

beforeEach(() => {
  meState.value = signedInAs();
  api.listInvitations.mockResolvedValue([invitation()]);
  api.listRoles.mockResolvedValue([
    role("owner", "Owner", false),
    role("author", "Author", true),
    role("super_admin", "Super administrator", false, "global"),
  ]);
  api.createInvitation.mockResolvedValue(invitation());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("invitations list", () => {
  it("says the list didn't load rather than claiming there are no invitations", async () => {
    api.listInvitations.mockRejectedValue(new FakeApiError(502, "HTTP 502"));
    renderManager();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("invitation list didn't load");
    expect(alert.textContent).not.toMatch(/\d{3}/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    // The empty state is a claim about this organization — not something to say
    // when the server never answered.
    expect(screen.queryByText("No invitations yet")).toBeNull();
  });

  it("translates the guard's bare refusal into who to ask", async () => {
    api.listInvitations.mockRejectedValue(new FakeApiError(403, "Forbidden"));
    renderManager();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("Forbidden");
    expect(alert.textContent).toContain("Ask an administrator");
  });
});

describe("creating an invitation", () => {
  it("keeps the route's own refusal, which already says what to do instead", async () => {
    const sentence =
      "Super administrator is a global role, not an organization role. Invite this person with an organization role, then grant super administrator from the Members tab once they have signed in.";
    api.createInvitation.mockRejectedValue(new FakeApiError(400, sentence));
    renderManager();
    await openInviteDialog();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(sentence);
  });

  it("never shows a status code or a stack when the route fell over", async () => {
    api.createInvitation.mockRejectedValue(
      new FakeApiError(500, "Invalid `prisma.invitation.create()` invocation")
    );
    renderManager();
    await openInviteDialog();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("prisma");
    expect(alert.textContent).toContain("nothing was sent");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("drops the previous failure when the dialog is opened again", async () => {
    api.createInvitation.mockRejectedValueOnce(new FakeApiError(500, "boom"));
    renderManager();
    await openInviteDialog();
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Invite user" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("acting on a pending invitation", () => {
  it("explains a failed revoke without saying 'Forbidden'", async () => {
    api.revokeInvitation.mockRejectedValue(new FakeApiError(403, "Forbidden"));
    renderManager();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke invitation" }));

    await waitFor(() => expect(toastState.error).toHaveBeenCalled());
    const message = toastState.error.mock.calls[0][0] as string;
    expect(message).not.toContain("Forbidden");
    expect(message).toContain("permission");
  });

  it("says the invitation is unchanged when extending it fails", async () => {
    api.resendInvitation.mockRejectedValue(new TypeError("Failed to fetch"));
    renderManager();

    fireEvent.click(await screen.findByRole("button", { name: "Extend expiry" }));

    await waitFor(() => expect(toastState.error).toHaveBeenCalled());
    const message = toastState.error.mock.calls[0][0] as string;
    expect(message).not.toContain("fetch");
    expect(message).toContain("unchanged");
  });
});
