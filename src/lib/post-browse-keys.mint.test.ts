import { describe, expect, it, vi, beforeEach } from "vitest";

type Args = { where: Record<string, unknown>; data: Record<string, unknown> };
const { updateMany, create, transaction } = vi.hoisted(() => ({
  updateMany: vi.fn((args: Args) => ({ op: "updateMany", args })),
  create: vi.fn((args: Args) => ({ op: "create", args })),
  transaction: vi.fn(async () => []),
}));
vi.mock("@/lib/db", () => ({ prisma: { postBrowseKey: { updateMany, create }, $transaction: transaction } }));

import { mintBrowseKey } from "./post-browse-keys";

const base = { userId: "u1", organizationId: "org", apiTokenId: "tok", siteScopes: [], now: 0 };

beforeEach(() => {
  updateMany.mockClear();
  create.mockClear();
});

describe("mintBrowseKey purposes", () => {
  it("a list key replaces only earlier list keys", async () => {
    const { key } = await mintBrowseKey({ ...base, site: "a" });
    expect(key.startsWith("cms_list_")).toBe(true);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ purpose: "list" });
    expect(updateMany.mock.calls[0][0].where).not.toHaveProperty("site");
  });

  it("a mirror key replaces only an earlier mirror key for the same site", async () => {
    const { key } = await mintBrowseKey({ ...base, site: "a", purpose: "mirror" });
    expect(key.startsWith("cms_mirror_")).toBe(true);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ purpose: "mirror", site: "a" });
    expect(create.mock.calls[0][0].data).toMatchObject({ purpose: "mirror", site: "a" });
  });
});
