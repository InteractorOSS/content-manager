import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import crypto from "node:crypto";

/**
 * The receiver is on the proxy's public allowlist, so its signature check is
 * the only thing above a write to a tenant's channels. These cases pin what
 * reaches the database and which refusal an operator sees; the signature
 * function's own edge cases live in src/lib/interactor.test.ts.
 *
 * Only the database and the parsed env are stubbed — the real verification
 * code runs, because "the route forgot to call it" is exactly the defect
 * being guarded against.
 */

vi.mock("server-only", () => ({}));

const mocked = vi.hoisted(() => ({
  env: {
    INTERACTOR_CORE_URL: "https://core.test",
    INTERACTOR_WEBHOOK_SECRET: undefined as string | undefined,
  },
}));
vi.mock("@/lib/env", () => mocked);

const updateMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { socialChannel: { updateMany: (...a: unknown[]) => updateMany(...a) } },
}));

import { POST } from "./route";

const SECRET = "whsec_test";

function body(type = "credential.revoked", credentialId = "cred_1") {
  return JSON.stringify({ type, data: { credential_id: credentialId } });
}

function sign(raw: string, timestamp: string, secret = SECRET) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${raw}`)
    .digest("hex");
}

/** A delivery with whatever headers the caller asks for (none by default). */
function deliver(raw: string, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/webhooks/interactor", {
      method: "POST",
      body: raw,
      headers: { "Content-Type": "application/json", ...headers },
    })
  );
}

/** A correctly signed delivery, optionally with a shifted timestamp. */
function signedDeliver(raw: string, offsetSeconds = 0, secret = SECRET) {
  const ts = String(Math.floor(Date.now() / 1000) + offsetSeconds);
  return deliver(raw, {
    "x-interactor-timestamp": ts,
    "x-interactor-signature": sign(raw, ts, secret),
  });
}

beforeEach(() => {
  updateMany.mockReset();
  updateMany.mockResolvedValue({ count: 1 });
  mocked.env.INTERACTOR_WEBHOOK_SECRET = SECRET;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/webhooks/interactor", () => {
  it("updates the channel's status for a correctly signed delivery", async () => {
    const res = await signedDeliver(body("credential.revoked"));

    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith({
      where: { credential_id: "cred_1" },
      data: { status: "revoked" },
    });
  });

  it("maps every subscribed credential event to its channel status", async () => {
    for (const [type, status] of [
      ["credential.ready", "active"],
      ["credential.expired", "expired"],
      ["credential.refresh_failed", "error"],
    ]) {
      updateMany.mockClear();
      await signedDeliver(body(type));
      expect(updateMany.mock.calls[0][0].data).toEqual({ status });
    }
  });

  it("answers 503 and writes nothing when no signing secret is configured", async () => {
    // Misconfiguration, not an attack: the operator must be able to tell this
    // apart from a forged delivery by the response alone.
    mocked.env.INTERACTOR_WEBHOOK_SECRET = undefined;

    const res = await signedDeliver(body());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: expect.stringContaining("INTERACTOR_WEBHOOK_SECRET"),
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("answers 401 and writes nothing for an unsigned delivery", async () => {
    const res = await deliver(body());

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("answers 401 and writes nothing when the timestamp header is missing", async () => {
    const raw = body();
    const res = await deliver(raw, {
      "x-interactor-signature": sign(raw, String(Math.floor(Date.now() / 1000))),
    });

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("answers 401 and writes nothing for a signature made with another secret", async () => {
    const res = await signedDeliver(body(), 0, "whsec_forged");

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("answers 401 and writes nothing for a replay older than the window", async () => {
    const res = await signedDeliver(body(), -6 * 60);

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const res = await signedDeliver("not json");

    expect(res.status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("acknowledges a signed event it does not act on", async () => {
    const res = await signedDeliver(body("credential.something_else"));

    expect(res.status).toBe(200);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
