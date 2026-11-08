import { describe, expect, it } from "vitest";
import { describeMemberFailure } from "@/lib/member-errors";

/** Same shape as ApiError in src/lib/api.ts, without importing the client. */
class FakeApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

describe("describeMemberFailure", () => {
  it("passes a route's own refusal through, with no extra action to take", () => {
    const sentence =
      "Only the organization's owner can make someone an owner. Ask your owner to make this change.";
    const failure = describeMemberFailure(new FakeApiError(403, sentence), "save");
    expect(failure.message).toBe(sentence);
    expect(failure.action).toBe("none");
  });

  it("offers a reload when the member is gone from this organization", () => {
    const sentence =
      "That person isn't a member of this organization. Invite them from the Invitations tab first.";
    const failure = describeMemberFailure(new FakeApiError(404, sentence), "save");
    expect(failure.message).toBe(sentence);
    expect(failure.action).toBe("refresh");
  });

  it("translates the guard's bare 'Forbidden' into who to ask", () => {
    const failure = describeMemberFailure(new FakeApiError(403, "Forbidden"), "save");
    expect(failure.message).not.toContain("Forbidden");
    expect(failure.message).toContain("permission");
    expect(failure.message).toContain("Ask an administrator");
    expect(failure.action).toBe("none");
  });

  it("sends an expired session to sign in again", () => {
    const failure = describeMemberFailure(new FakeApiError(401, "Unauthorized"), "save");
    expect(failure.message).not.toContain("Unauthorized");
    expect(failure.action).toBe("signin");
  });

  it("never shows the HTTP status the API client fell back to", () => {
    const failure = describeMemberFailure(new FakeApiError(502, "HTTP 502"), "load");
    expect(failure.message).not.toMatch(/\d{3}/);
    expect(failure.action).toBe("retry");
  });

  it("replaces a 5xx body wholesale, so Prisma text can't reach the page", () => {
    const prisma =
      "\nInvalid `prisma.membership.findUnique()` invocation:\nCan't reach database server";
    const failure = describeMemberFailure(new FakeApiError(500, prisma), "save");
    expect(failure.message).not.toContain("prisma");
    expect(failure.message).toContain("nothing changed");
    expect(failure.action).toBe("retry");
  });

  it("reads a rejected fetch as a connection problem, not a refusal", () => {
    const failure = describeMemberFailure(new TypeError("Failed to fetch"), "save");
    expect(failure.message).not.toContain("fetch");
    expect(failure.message).toContain("nothing changed");
    expect(failure.action).toBe("retry");
  });

  it("says the list didn't load when the failure was a read", () => {
    const failure = describeMemberFailure(new TypeError("Failed to fetch"), "load");
    expect(failure.message).toContain("Check your connection");
    expect(failure.action).toBe("retry");
  });
});

/**
 * The invitations tab of the same page. "Nothing changed" only reassures when
 * it names the thing that didn't change, so each operation has to answer for
 * itself rather than borrowing the members tab's sentence about a role.
 */
describe("describeMemberFailure, invitations tab", () => {
  it("never shows the client's status-code fallback while loading the list", () => {
    const failure = describeMemberFailure(new FakeApiError(502, "HTTP 502"), "invitations_load");
    expect(failure.message).not.toMatch(/\d{3}/);
    expect(failure.message).toContain("invitation list");
    expect(failure.action).toBe("retry");
  });

  it("names inviting, not role-changing, when the guard refuses a create", () => {
    const failure = describeMemberFailure(new FakeApiError(403, "Forbidden"), "invite");
    expect(failure.message).not.toContain("Forbidden");
    expect(failure.message).toContain("invite people");
    expect(failure.action).toBe("none");
  });

  it("promises nothing was sent when a create falls over", () => {
    const failure = describeMemberFailure(new FakeApiError(500, "kaboom"), "invite");
    expect(failure.message).not.toContain("kaboom");
    expect(failure.message).toContain("nothing was sent");
    expect(failure.action).toBe("retry");
  });

  it("passes a create's own refusal through — it already says what to do", () => {
    const sentence =
      "Super administrator is a global role, not an organization role. Invite this person with an organization role, then grant super administrator from the Members tab once they have signed in.";
    const failure = describeMemberFailure(new FakeApiError(400, sentence), "invite");
    expect(failure.message).toBe(sentence);
    expect(failure.action).toBe("none");
  });

  it("says the invitation is still active when revoking fails", () => {
    const failure = describeMemberFailure(new FakeApiError(500, "kaboom"), "revoke");
    expect(failure.message).toContain("still active");
    expect(failure.action).toBe("retry");
  });

  it("says the invitation is unchanged when extending it fails", () => {
    const failure = describeMemberFailure(new TypeError("Failed to fetch"), "resend");
    expect(failure.message).toContain("unchanged");
    expect(failure.action).toBe("retry");
  });

  it("offers a reload when the invitation is already gone", () => {
    const failure = describeMemberFailure(
      new FakeApiError(404, "That invitation no longer exists."),
      "revoke"
    );
    expect(failure.action).toBe("refresh");
  });
});
