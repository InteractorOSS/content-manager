/**
 * Pure, dependency-free core of the tenant scope (SMM-CONSOLIDATION-PUNCHLIST
 * T4). Kept separate from `tenant-db.ts` (which wires it into a real Prisma
 * client) so the isolation guarantee can be exercised without a database — see
 * `scripts/verify-tenant-scope.ts`.
 */

/**
 * The single existing tenant, created and backfilled by the T2 migration
 * (`20260717000000_add_organization_tenancy`). Public, unauthenticated write
 * paths (the website form POSTs) have no actor to derive an org from, so per
 * D4 / punchlist §P they pin their inserts to this org. The full public-API
 * pinning + regression suite is tracked separately as P1.
 */
export const INTERACTOR_ORG_ID = "org_interactor";

/**
 * Models that own an `organization_id` column and are therefore rewritten by
 * the tenant scope. Keys are Prisma model names (PascalCase, as seen by the
 * `$allOperations` extension), not the mapped table names. Child models
 * (Comment, ContentApproval, SocialPostTarget, SocialPostApproval, StyleSample,
 * StyleGuideVersion, GuideAmendmentSuggestion) inherit their org through a
 * parent FK, so they are deliberately absent — scope the parent.
 */
export const ORG_SCOPED_MODELS = new Set<string>([
  "Post",
  "Category",
  "Media",
  "Invitation",
  "ContactSubmission",
  "NewsletterSubscription",
  "Waitlist",
  "SocialChannel",
  "SocialCampaign",
  "SocialPost",
  "StyleProfile",
  "GenerationJob",
  "Feedback",
  "Faq",
  "ContentType",
  "Site",
  "DeletedPost",
]);

/** Operations that write new rows — `organization_id` is injected into `data`. */
const CREATE_OPS = new Set<string>([
  "create",
  "createMany",
  "createManyAndReturn",
]);

/**
 * Operations that read or mutate existing rows — `organization_id` is ANDed
 * into `where`. `findUnique`/`findUniqueOrThrow` accept the extra non-unique
 * filter (Prisma's extended `where`), so the compound scope is safe there too.
 * `upsert` is handled separately (it has both `where` and `create`).
 */
const WHERE_OPS = new Set<string>([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
]);

type ScopedArgs = {
  data?: unknown;
  where?: Record<string, unknown>;
  create?: Record<string, unknown>;
};

/** Stamp `organization_id` onto a create payload (single row or array). */
function withOrg(data: unknown, organizationId: string | null): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => ({
      ...(row as Record<string, unknown>),
      organization_id: organizationId,
    }));
  }
  return {
    ...(data as Record<string, unknown>),
    organization_id: organizationId,
  };
}

/**
 * Given a Prisma operation and its args, return the args rewritten so the query
 * is constrained to `organizationId`:
 *
 *   - create / createMany / createManyAndReturn → inject `organization_id` into
 *     `data` (force-overriding any caller-supplied value);
 *   - upsert → inject into both `where` and `create`;
 *   - every read / update / delete / count / aggregate → AND `organization_id`
 *     into `where`.
 *
 * Non-org-scoped models are returned unchanged. Side-effect-free (it builds new
 * args rather than mutating the input), so it is safe to unit-test directly.
 */
export function scopeArgsForOrg(
  model: string | undefined,
  operation: string,
  args: unknown,
  organizationId: string | null
): unknown {
  if (!model || !ORG_SCOPED_MODELS.has(model)) return args;

  const input = (args ?? {}) as ScopedArgs;
  const a: ScopedArgs = { ...input };

  if (operation === "upsert") {
    a.where = { ...(input.where ?? {}), organization_id: organizationId };
    a.create = { ...(input.create ?? {}), organization_id: organizationId };
  } else if (CREATE_OPS.has(operation)) {
    a.data = withOrg(input.data, organizationId);
  } else if (WHERE_OPS.has(operation)) {
    a.where = { ...(input.where ?? {}), organization_id: organizationId };
  }

  return a;
}
