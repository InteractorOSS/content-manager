import { z } from "zod";

const envSchema = z.object({
  // NextAuth. The default is the origin the app is served on, NOT the old
  // pm.interactor.com name: next-auth rewrites every request's origin to this
  // value, and it also builds the Interactor Core OAuth return URLs
  // (src/app/api/social/channels, src/app/api/content-sync/connect), so a
  // stale host here breaks SSO and channel connect alike.
  NEXTAUTH_URL: z.url().default("https://cms.interactor.com"),
  NEXTAUTH_SECRET: z.string().min(1),

  // Interactor OAuth
  INTERACTOR_CLIENT_ID: z.string().min(1),
  INTERACTOR_CLIENT_SECRET: z.string().min(1),

  // Backend URLs
  ACCOUNT_SERVER_URL: z.url().default("https://auth.interactor.com"),

  // Interactor SSO (OIDC) — lets MFA accounts log in via Account Server's
  // hosted login instead of the credentials form, which can't do MFA. Unset
  // by default; the provider is hidden until both are configured. Same var
  // names product-manager uses for its interactorOidcProvider.
  INTERACTOR_AUTH_CLIENT_ID: z.string().optional(),
  INTERACTOR_AUTH_CLIENT_SECRET: z.string().optional(),

  // Interactor Core (integration platform: hosted OAuth, service execution)
  INTERACTOR_CORE_URL: z.url().default("https://core.interactor.com"),
  // App-token credentials for Core API calls; falls back to the login OAuth
  // client when unset (see interactor.ts).
  INTERACTOR_API_CLIENT_ID: z.string().optional(),
  INTERACTOR_API_CLIENT_SECRET: z.string().optional(),
  INTERACTOR_WEBHOOK_SECRET: z.string().optional(),

  // User Knowledge-Base (Phase E, CONTENT-AI-PLAN.md §6): optional push of
  // the org brand-voice guide as a domain_knowledge entry. Unset by default —
  // the feature no-ops until a platform-issued org JWT is configured; see
  // src/lib/ai/ukb.ts for the unverified parts of this contract.
  UKB_URL: z.url().default("https://ukb.interactor.com"),
  UKB_ORG_JWT: z.string().optional(),

  // Local dev-only login shortcut (src/lib/auth.ts) — skips the real Account
  // Server call for one specific email/password pair. Gated on
  // NODE_ENV === "development" regardless of whether these are set; unset by
  // default, so set both in .env.local (gitignored) to opt in.
  DEV_LOGIN_BYPASS_EMAIL: z.string().optional(),
  DEV_LOGIN_BYPASS_PASSWORD: z.string().optional(),

  // Interactor Build feedback widget + "My submissions" page. embed-token is
  // project-scoped and designed to be public (like a publishable key); still
  // no-ops until configured (see src/lib/build-feedback.ts).
  BUILD_FEEDBACK_PROJECT_ID: z.string().optional(),
  BUILD_FEEDBACK_EMBED_TOKEN: z.string().optional(),
  BUILD_FEEDBACK_API_BASE: z.url().default("https://build.interactor.com"),

  // CMS G#8 (FAQ intake automation). A personal access token (see
  // /settings/tokens, src/lib/api-tokens.ts) belonging to a user with
  // content:create + content:edit, used by src/lib/faq-automation-client.ts
  // to call POST/PATCH /api/automation/faq on this same app. Unset by
  // default — the intake pipeline no-ops (logs and skips) until configured.
  FAQ_AUTOMATION_API_TOKEN: z.string().optional(),

  // Runtime
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `Invalid environment variables:\n${result.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n")}`
      );
    }
    console.warn(
      "Environment variable warnings:",
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
    );
    return envSchema.parse({
      NEXTAUTH_URL: process.env.NEXTAUTH_URL || "https://cms.interactor.com",
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET || "dev-secret-not-for-production",
      INTERACTOR_CLIENT_ID: process.env.INTERACTOR_CLIENT_ID || "dev-client-id",
      INTERACTOR_CLIENT_SECRET: process.env.INTERACTOR_CLIENT_SECRET || "dev-client-secret",
      ACCOUNT_SERVER_URL: process.env.ACCOUNT_SERVER_URL || "https://auth.interactor.com",
      NODE_ENV: process.env.NODE_ENV || "development",
    });
  }
  return result.data;
}

export const env = parseEnv();
