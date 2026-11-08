import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { INTERACTOR_ORG_ID, scopeArgsForOrg } from "@/lib/tenant-scope";

/**
 * Tenant-scoped Prisma client (SMM-CONSOLIDATION-PUNCHLIST T4 — the
 * leak-proofing mechanism).
 *
 * A missed `where: { organization_id }` in a route handler is now a
 * cross-tenant data leak. Rather than trust every call site to remember the
 * filter, {@link tenantDb} returns a Prisma client extension bound to one
 * organization that:
 *
 *   (a) force-injects `organization_id` on create / createMany / upsert, so a
 *       handler can never write a row into another tenant's org (and a handler
 *       that passes the wrong org has it corrected); and
 *   (b) ANDs `organization_id` into the `where` of every read/update/delete/
 *       count/aggregate, so a handler can never read or mutate across tenants.
 *
 * The arg-rewriting itself lives in the pure, database-free
 * {@link scopeArgsForOrg} (src/lib/tenant-scope.ts) so the isolation guarantee
 * can be exercised without a live DB (scripts/verify-tenant-scope.ts). Only the
 * models in `ORG_SCOPED_MODELS` — those that carry their own `organization_id`
 * column (the tenancy map in T2) — are rewritten. Child models (Comment,
 * ContentApproval, SocialPostTarget, SocialPostApproval, StyleSample,
 * StyleGuideVersion, GuideAmendmentSuggestion) inherit their org through a
 * parent FK, so scoping the parent scopes them.
 *
 * The raw `prisma` / `db` export stays reserved for explicitly-GLOBAL code:
 * NextAuth + provisioning, the seed script, the public API, the scheduler
 * (which sweeps due posts across every org), and super_admin cross-org
 * surfaces. Everything else should reach Prisma through the `db` handed back
 * by {@link requirePermission}.
 */

// Re-exported so public write paths can pin their inserts without reaching into
// the pure-scope module directly.
export { INTERACTOR_ORG_ID };

function buildTenantClient(organizationId: string | null) {
  return prisma.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          const scoped = scopeArgsForOrg(model, operation, args, organizationId);
          return query(scoped as typeof args);
        },
      },
    },
  });
}

/**
 * A Prisma client scoped to a single organization. Every query against an
 * org-scoped model is automatically constrained to `organizationId`.
 *
 *   const { actor, db, error } = await requirePermission("content:create");
 *   if (error) return error;
 *   const post = await db.post.create({ data }); // organization_id injected
 *
 * Pass the actor's current org (`actor.organizationId`). A null org (a user
 * with no membership) scopes to `organization_id IS NULL`, which post-backfill
 * matches nothing — such a request never sees another tenant's data, and a
 * write it attempts is rejected by the NOT NULL column (T4b).
 */
export function tenantDb(organizationId: string | null): TenantDb {
  return buildTenantClient(organizationId) as unknown as TenantDb;
}

// ---------------------------------------------------------------------------
// Typing. `organization_id` is a required (NOT NULL) column (T4b), so Prisma's
// generated create inputs demand it. The scope injects it at runtime, so call
// sites must NOT have to pass it. We therefore expose the scoped client with
// the create-family inputs of the org-scoped delegates loosened to make
// `organization_id` / `organization` optional; every other operation, and
// every other model, keeps its exact generated types (including the precise,
// include/select-aware return types).
// ---------------------------------------------------------------------------

type RawTenantClient = ReturnType<typeof buildTenantClient>;

/** Prisma delegate property names for the org-scoped models. */
type OrgScopedDelegateKey =
  | "post"
  | "category"
  | "media"
  | "invitation"
  | "contactSubmission"
  | "newsletterSubscription"
  | "waitlist"
  | "socialChannel"
  | "socialCampaign"
  | "socialPost"
  | "styleProfile"
  | "generationJob"
  | "feedback"
  | "faq"
  | "contentType"
  | "site"
  | "deletedPost";

/** Drop the injected org keys from a single create payload. */
type OrgOptional<T> = Omit<T, "organization" | "organization_id"> & {
  organization?: unknown;
  organization_id?: string | null;
};

/** Drop the injected org keys from a create payload (single row or array). */
type OrgOptionalData<D> = D extends readonly (infer E)[]
  ? OrgOptional<E>[]
  : OrgOptional<D>;

type LooseCreateArgs<D> = Omit<Prisma.Args<D, "create">, "data"> & {
  data: OrgOptionalData<Prisma.Args<D, "create">["data"]>;
};
type LooseCreateManyArgs<D> = Omit<Prisma.Args<D, "createMany">, "data"> & {
  data: OrgOptionalData<Prisma.Args<D, "createMany">["data"]>;
};
type LooseUpsertArgs<D> = Omit<Prisma.Args<D, "upsert">, "create"> & {
  create: OrgOptional<Prisma.Args<D, "upsert">["create"]>;
};

/** A delegate whose create-family inputs no longer require `organization_id`. */
type OrgLooseDelegate<D> = Omit<
  D,
  "create" | "createMany" | "createManyAndReturn" | "upsert"
> & {
  create<A extends LooseCreateArgs<D>>(
    args: A
  ): Prisma.PrismaPromise<Prisma.Result<D, A, "create">>;
  createMany<A extends LooseCreateManyArgs<D>>(
    args: A
  ): Prisma.PrismaPromise<Prisma.Result<D, A, "createMany">>;
  createManyAndReturn<A extends LooseCreateArgs<D>>(
    args: A
  ): Prisma.PrismaPromise<Prisma.Result<D, A, "createManyAndReturn">>;
  upsert<A extends LooseUpsertArgs<D>>(
    args: A
  ): Prisma.PrismaPromise<Prisma.Result<D, A, "upsert">>;
};

/** Strongly-typed org-scoped client, as returned by {@link tenantDb}. */
export type TenantDb = Omit<RawTenantClient, OrgScopedDelegateKey> & {
  [K in OrgScopedDelegateKey]: OrgLooseDelegate<RawTenantClient[K]>;
};
