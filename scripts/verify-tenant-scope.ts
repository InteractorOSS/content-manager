/**
 * Regression check for the tenant scope (SMM-CONSOLIDATION-PUNCHLIST T4b).
 *
 * Proves — without a live database — that a handler querying through the
 * scoped `db` client cannot read (or write into) another organization's rows.
 * It exercises the real arg-rewriting logic ({@link scopeArgsForOrg}, the exact
 * function the Prisma `$allOperations` extension runs) against an in-memory
 * table, standing in for Postgres.
 *
 *   npm run test:tenant-scope
 */
import assert from "node:assert/strict";
import {
  scopeArgsForOrg,
  ORG_SCOPED_MODELS,
  INTERACTOR_ORG_ID,
} from "../src/lib/tenant-scope";

type Row = { id: string; organization_id: string; title: string };

// Two tenants share the same table. A correctly-scoped handler for org A must
// never be able to observe org B's row, no matter how it queries.
const TABLE: Row[] = [
  { id: "p1", organization_id: "orgA", title: "A: hello" },
  { id: "p2", organization_id: "orgA", title: "A: world" },
  { id: "p3", organization_id: "orgB", title: "B: secret" },
];

/** Minimal stand-in for the DB: honours equality filters in `where`. */
function fakeFind(where: Record<string, unknown> | undefined): Row[] {
  const filter = where ?? {};
  return TABLE.filter((row) =>
    Object.entries(filter).every(
      ([key, value]) => (row as Record<string, unknown>)[key] === value
    )
  );
}

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log("  ok   -", name);
  } catch (e) {
    failures++;
    console.error("  FAIL -", name, "\n        ", (e as Error).message);
  }
}

// 1. The core leak: a handler for org A that FORGOT a where filter entirely
//    still only sees its own org's rows.
check("findMany with no where is scoped to the caller's org", () => {
  const args = scopeArgsForOrg("Post", "findMany", {}, "orgA") as {
    where?: Record<string, unknown>;
  };
  const rows = fakeFind(args.where);
  assert.deepEqual(rows.map((r) => r.id).sort(), ["p1", "p2"]);
  assert.ok(!rows.some((r) => r.organization_id === "orgB"), "org B row leaked");
});

// 2. A handler that passes another org's id (accidentally or maliciously) has
//    it force-overridden back to the caller's org.
check("caller-supplied organization_id cannot widen the scope", () => {
  const args = scopeArgsForOrg(
    "Post",
    "findMany",
    { where: { organization_id: "orgB" } },
    "orgA"
  ) as { where: Record<string, unknown> };
  assert.equal(args.where.organization_id, "orgA");
  assert.ok(fakeFind(args.where).every((r) => r.organization_id === "orgA"));
});

// 3. findUnique by another org's primary key resolves to nothing (the compound
//    scope turns it into id = p3 AND organization_id = orgA).
check("findUnique on another org's id returns no row", () => {
  const args = scopeArgsForOrg("Post", "findUnique", { where: { id: "p3" } }, "orgA") as {
    where: Record<string, unknown>;
  };
  assert.equal(fakeFind(args.where).length, 0);
});

// 4. Writes: create injects the caller's org, overriding a supplied value, so a
//    handler cannot plant a row in another tenant.
check("create injects the caller's organization_id", () => {
  const args = scopeArgsForOrg(
    "Post",
    "create",
    { data: { id: "p4", title: "x", organization_id: "orgB" } },
    "orgA"
  ) as { data: Record<string, unknown> };
  assert.equal(args.data.organization_id, "orgA");
});

// 5. createMany injects org into every row of the batch.
check("createMany injects org into every row", () => {
  const args = scopeArgsForOrg(
    "Post",
    "createMany",
    { data: [{ id: "a" }, { id: "b", organization_id: "orgB" }] },
    "orgA"
  ) as { data: Array<Record<string, unknown>> };
  assert.ok(args.data.every((r) => r.organization_id === "orgA"));
});

// 6. upsert scopes both the lookup and the inserted row.
check("upsert scopes where and create", () => {
  const args = scopeArgsForOrg(
    "Post",
    "upsert",
    { where: { id: "p1" }, create: { id: "p1", title: "x" }, update: { title: "y" } },
    "orgA"
  ) as { where: Record<string, unknown>; create: Record<string, unknown> };
  assert.equal(args.where.organization_id, "orgA");
  assert.equal(args.create.organization_id, "orgA");
});

// 7. Global/identity models (User, Role, …) are deliberately NOT rewritten.
check("non-org-scoped models pass through untouched", () => {
  const input = { where: { email: "a@b.com" } };
  assert.deepEqual(scopeArgsForOrg("User", "findMany", input, "orgA"), input);
  assert.ok(!ORG_SCOPED_MODELS.has("User"));
});

// 8. A null org (a user with no membership) scopes to organization_id IS NULL,
//    which — post-backfill / NOT NULL — matches no real row.
check("a null org scopes to nothing, never another tenant", () => {
  const args = scopeArgsForOrg("Post", "findMany", {}, null) as {
    where: Record<string, unknown>;
  };
  assert.equal(args.where.organization_id, null);
  assert.equal(fakeFind(args.where).length, 0);
});

// 9. Sanity: the pinned public-write org constant is the stable backfill id.
check("INTERACTOR_ORG_ID matches the backfill migration", () => {
  assert.equal(INTERACTOR_ORG_ID, "org_interactor");
});

if (failures > 0) {
  console.error(`\n${failures} tenant-scope isolation check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll tenant-scope isolation checks passed.");
