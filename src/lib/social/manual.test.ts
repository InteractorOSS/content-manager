import { describe, expect, it } from "vitest";
import { canMarkPosted, deriveRolledUpStatus, isManualChannel } from "./manual";

describe("isManualChannel", () => {
  it("is true only for delivery_mode 'manual'", () => {
    expect(isManualChannel({ delivery_mode: "manual" })).toBe(true);
    expect(isManualChannel({ delivery_mode: "automated" })).toBe(false);
    expect(isManualChannel({ delivery_mode: null })).toBe(false);
    expect(isManualChannel({})).toBe(false);
  });
});

describe("canMarkPosted", () => {
  it("only allows marking a target that is actually awaiting_manual", () => {
    expect(canMarkPosted({ status: "awaiting_manual" })).toBe(true);
    expect(canMarkPosted({ status: "published" })).toBe(false);
    expect(canMarkPosted({ status: "pending" })).toBe(false);
    expect(canMarkPosted({ status: "failed" })).toBe(false);
  });
});

describe("deriveRolledUpStatus", () => {
  it("returns null for no targets", () => {
    expect(deriveRolledUpStatus([])).toBeNull();
  });

  it("returns null while any target is still pending or publishing (work in flight)", () => {
    expect(deriveRolledUpStatus([{ status: "pending" }, { status: "published" }])).toBeNull();
    expect(deriveRolledUpStatus([{ status: "publishing" }])).toBeNull();
  });

  it("rolls up to published when every target published cleanly", () => {
    expect(deriveRolledUpStatus([{ status: "published" }, { status: "published" }])).toBe("published");
  });

  it("rolls up to partially_published when some published and some failed", () => {
    expect(deriveRolledUpStatus([{ status: "published" }, { status: "failed" }])).toBe("partially_published");
  });

  it("rolls up to failed when nothing published", () => {
    expect(deriveRolledUpStatus([{ status: "failed" }, { status: "skipped" }])).toBe("failed");
  });

  it("rolls up to awaiting_manual when a manual target is still outstanding, even alongside settled ones", () => {
    expect(deriveRolledUpStatus([{ status: "published" }, { status: "awaiting_manual" }])).toBe("awaiting_manual");
    expect(deriveRolledUpStatus([{ status: "failed" }, { status: "awaiting_manual" }])).toBe("awaiting_manual");
  });

  it("resolves once every awaiting_manual target has been marked posted (no longer stuck)", () => {
    // Before marking posted: one target still needs a human.
    expect(
      deriveRolledUpStatus([{ status: "published" }, { status: "awaiting_manual" }])
    ).toBe("awaiting_manual");
    // After marking posted: rolls all the way to a terminal status.
    expect(
      deriveRolledUpStatus([{ status: "published" }, { status: "published" }])
    ).toBe("published");
  });
});
