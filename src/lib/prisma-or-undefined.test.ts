/**
 * Pins the Prisma behaviour that the SECURITY comment in src/lib/rbac.ts
 * relies on, so the claim can never quietly drift out of date — and so the
 * next reader who doubts it (as one reviewer rightly did) gets an answer from
 * the suite instead of having to rebuild the harness by hand.
 *
 * The original comment asserted that an `undefined` filter key becomes an
 * empty `{}` OR branch that matches EVERY row. It does not. These tests
 * capture the SQL @prisma/client actually emits by handing the client a stub
 * driver adapter that records `queryRaw` and returns no rows — no Postgres,
 * no DATABASE_URL, nothing to connect to.
 *
 * Requires the generated client, which CI produces with `npx prisma generate`
 * before `npm test` (.github/workflows/ci.yml).
 */

import { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

interface CapturedQuery {
  sql: string;
  args: unknown[];
}

const captured: CapturedQuery[] = [];

/** The read/write half of the driver-adapter contract: record, return nothing. */
function recordingQueryable() {
  return {
    provider: "postgres" as const,
    adapterName: "@prisma/adapter-pg",
    async queryRaw(params: CapturedQuery) {
      captured.push({ sql: params.sql, args: params.args });
      return { columnTypes: [], columnNames: [], rows: [] };
    },
    async executeRaw(params: CapturedQuery) {
      captured.push({ sql: params.sql, args: params.args });
      return 0;
    },
  };
}

const recordingAdapterFactory = {
  provider: "postgres" as const,
  adapterName: "@prisma/adapter-pg",
  async connect() {
    return {
      ...recordingQueryable(),
      async executeScript() {},
      async startTransaction() {
        return {
          ...recordingQueryable(),
          options: { usePhantomQuery: false },
          async commit() {},
          async rollback() {},
        };
      },
      getConnectionInfo() {
        return { supportsRelationJoins: false };
      },
      async dispose() {},
    };
  },
};

// The adapter interface is structurally satisfied above; the exported types are
// internal to @prisma/driver-adapter-utils, so this is the one cast we need.
const prisma = new PrismaClient({
  adapter: recordingAdapterFactory as never,
});

/** Run a findFirst and hand back its WHERE clause, whitespace-normalised. */
async function whereClauseFor(where: object): Promise<{
  clause: string;
  args: unknown[];
}> {
  captured.length = 0;
  await prisma.user.findFirst({ where: where as never });
  const query = captured[0];
  const sql = query.sql.replace(/\s+/g, " ");
  const clause = sql.slice(sql.indexOf("WHERE ")).replace(/ LIMIT .*$/, "");
  return { clause, args: query.args };
}

beforeEach(() => {
  captured.length = 0;
});

describe("Prisma 7.8 OR-branch compilation (pins the rbac.ts SECURITY note)", () => {
  it("DROPS an undefined branch instead of making it match every row", async () => {
    const { clause } = await whereClauseFor({
      OR: [{ external_id: "x" }, { email: undefined }],
    });

    // The refuted claim would show up as no WHERE restriction at all.
    expect(clause).toContain(`"users"."external_id" = $1`);
    expect(clause).not.toContain("email");
    expect(clause).not.toContain(" OR ");
  });

  it("compiles an all-undefined where to WHERE 1=0, matching nothing", async () => {
    const { clause } = await whereClauseFor({
      OR: [{ external_id: undefined }, { email: undefined }],
    });

    expect(clause).toContain("1=0");
  });

  it("leaves a lone defined branch safely restrictive", async () => {
    // With no external id but a real email the query is `WHERE email = $1`,
    // which is why the external-id guard needs the empty-string justification
    // rather than an `undefined` one.
    const { clause, args } = await whereClauseFor({
      OR: [{ external_id: undefined }, { email: "ada@interactor.com" }],
    });

    expect(clause).toContain(`"users"."email" = $1`);
    expect(args[0]).toBe("ada@interactor.com");
  });

  it("KEEPS an empty-string branch — the real cross-account-link risk", async () => {
    const { clause, args } = await whereClauseFor({
      OR: [{ external_id: "x" }, { email: "" }],
    });

    expect(clause).toContain(" OR ");
    expect(clause).toContain(`"users"."email" = $2`);
    // `''` is bound as a real value: it matches any persisted blank-email row,
    // and User.email is a non-null unique String, so such a row can exist.
    expect(args).toContain("");
  });

  it("keeps an empty-string external id the same way", async () => {
    const { clause, args } = await whereClauseFor({
      OR: [{ external_id: "" }, { email: "ada@interactor.com" }],
    });

    expect(clause).toContain(`"users"."external_id" = $1`);
    expect(args[0]).toBe("");
  });
});
