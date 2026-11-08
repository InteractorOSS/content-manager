import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { postSaveConflictMessage } from "./post-save-conflict";

describe("postSaveConflictMessage", () => {
  it("returns null for a non-ApiError", () => {
    expect(postSaveConflictMessage(new Error("boom"))).toBeNull();
  });

  it("returns null for a 409 without current_hash (e.g. slug conflict)", () => {
    const error = new ApiError(409, "A post with this slug already exists", {
      error: "A post with this slug already exists",
    });
    expect(postSaveConflictMessage(error)).toBeNull();
  });

  it("names the last editor when known", () => {
    const error = new ApiError(409, "conflict", {
      error: "conflict",
      current_hash: "hash-v2",
      updated_at: "2026-01-01T00:00:00.000Z",
      last_editor: { id: "u2", name: "Riley" },
    });
    expect(postSaveConflictMessage(error)).toMatch(/Riley/);
  });

  it("falls back to a generic message when the last editor is unknown", () => {
    const error = new ApiError(409, "conflict", {
      error: "conflict",
      current_hash: "hash-v2",
      updated_at: "2026-01-01T00:00:00.000Z",
      last_editor: null,
    });
    const message = postSaveConflictMessage(error);
    expect(message).toBeTruthy();
    expect(message).not.toMatch(/null/);
  });
});
