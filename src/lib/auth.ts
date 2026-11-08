import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import {
  authLogger,
  authorizeSignIn,
  logAuthFailure,
  mapInteractorProfile,
  type SignInUser,
} from "@/lib/auth-callbacks";
import { env } from "@/lib/env";

// Surfaced to the login page as result.code so MFA accounts don't just see
// "invalid password" (the CMS login doesn't support the MFA step yet).
class MfaRequiredError extends CredentialsSignin {
  code = "mfa_required";
}

const AUTH_SERVER_URL =
  process.env.ACCOUNT_SERVER_URL || "https://auth.interactor.com";

// Refresh 60 seconds before the token actually expires (tokens live 15 min = 900s).
const ACCESS_TOKEN_TTL_MS = 900 * 1000;
const REFRESH_BUFFER_MS = 60 * 1000;

interface AdminProfile {
  id?: string;
  email?: string;
  name?: string;
  display_name?: string;
  role?: string;
}

interface AuthorizeUser {
  id: string;
  name: string;
  email: string;
  role?: string;
  accessToken: string;
  refreshToken: string;
}

async function refreshAccessToken(refreshToken: string) {
  // Login-issued refresh tokens are opaque, DB-backed admin session tokens
  // (Administrators.create_refresh_token in account-server) — not the JWT
  // "admin_refresh"-typed tokens the /oauth/admin/token grant expects,
  // which are only minted by the authorization_code SSO flow this CMS
  // doesn't use. They redeem via the matching plain admin refresh endpoint
  // instead, which needs no client credentials.
  const res = await fetch(`${AUTH_SERVER_URL}/api/v1/admin/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
  };

  if (!data.access_token) return null;
  return data;
}

// OIDC redirect flow ("Sign in with Interactor SSO"), mirroring
// product-manager's interactorOidcProvider — hands MFA and any other
// Account-Server-side auth step off to its own hosted login instead of
// reimplementing them in the CMS's credentials form. Hidden (provider not
// registered) until both client env vars are configured.
export const oidcEnabled = Boolean(
  env.INTERACTOR_AUTH_CLIENT_ID && env.INTERACTOR_AUTH_CLIENT_SECRET
);

const interactorOidcProvider = {
  id: "interactor",
  name: "Interactor SSO",
  type: "oidc" as const,
  issuer: AUTH_SERVER_URL,
  clientId: env.INTERACTOR_AUTH_CLIENT_ID,
  clientSecret: env.INTERACTOR_AUTH_CLIENT_SECRET,
  authorization: { params: { scope: "openid profile email" } },
  // Mapping lives in auth-callbacks.ts so it can be unit-tested, and so a
  // claim set carrying no `email` yields null instead of the `undefined` cast
  // that used to travel on into provisionUser().
  profile: mapInteractorProfile,
};

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials): Promise<AuthorizeUser | null> {
        if (!credentials?.email || !credentials?.password) return null;

        // DEV-ONLY LOGIN BYPASS. Strictly gated on NODE_ENV === "development"
        // (not a "!== production" deny-list) so it can never activate in
        // staging/production even if NODE_ENV is ever left unset there, and
        // further gated on both DEV_LOGIN_BYPASS_* vars being set (unset by
        // default — opt in via .env.local, which is gitignored). Skips the
        // real Account Server call entirely (useful since the real account
        // has MFA, which this Credentials flow can't complete).
        // provisionUser() below matches the existing local user by email, so
        // normal roles/permissions apply.
        if (
          process.env.NODE_ENV === "development" &&
          env.DEV_LOGIN_BYPASS_EMAIL &&
          env.DEV_LOGIN_BYPASS_PASSWORD &&
          credentials.email === env.DEV_LOGIN_BYPASS_EMAIL &&
          credentials.password === env.DEV_LOGIN_BYPASS_PASSWORD
        ) {
          return {
            // Per email, so two bypass accounts are two identities (testing
            // "Add another account" locally); provisionUser links by email too.
            id: `dev-local-bypass:${env.DEV_LOGIN_BYPASS_EMAIL}`,
            name: env.DEV_LOGIN_BYPASS_EMAIL,
            email: env.DEV_LOGIN_BYPASS_EMAIL,
            accessToken: "dev-bypass",
            refreshToken: "dev-bypass",
          };
        }

        let loginRes: Response;
        try {
          loginRes = await fetch(`${AUTH_SERVER_URL}/api/v1/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: credentials.email,
              password: credentials.password,
            }),
          });
        } catch {
          return null;
        }

        if (!loginRes.ok) return null;

        const loginData = (await loginRes.json()) as {
          access_token?: string;
          refresh_token?: string;
          mfa_required?: boolean;
        };

        if (loginData.mfa_required) throw new MfaRequiredError();
        if (!loginData.access_token) return null;

        let profileRes: Response;
        try {
          profileRes = await fetch(`${AUTH_SERVER_URL}/api/v1/admin/`, {
            headers: { Authorization: `Bearer ${loginData.access_token}` },
          });
        } catch {
          return null;
        }

        if (!profileRes.ok) return null;

        const profile = (await profileRes.json()) as {
          admin?: AdminProfile;
        } & AdminProfile;

        const admin: AdminProfile = profile.admin ?? profile;

        return {
          id: admin.id ?? admin.email ?? "unknown",
          name: admin.display_name ?? admin.name ?? admin.email ?? "",
          email: admin.email ?? String(credentials.email),
          role: admin.role,
          accessToken: loginData.access_token,
          refreshToken: loginData.refresh_token ?? "",
        };
      },
    }),
    ...(oidcEnabled ? [interactorOidcProvider] : []),
  ],
  // Auth.js configures no logger by default, so a failure on the callback leg
  // left an operator nothing to grep. These lines reach
  // `journalctl -u interactor-cms`.
  //
  // Deliberately NOT paired with `debug: true`: Auth.js's debug logger prints
  // the callback request's `query` and `body`, and on this leg that query
  // carries the OAuth authorization code. The `[cms-auth]` line below gives an
  // operator the provider, type, redirect code and root cause without putting
  // a live credential into journald.
  logger: authLogger,
  callbacks: {
    // Runs before jwt() and is the ONLY callback Auth.js lets answer a failure
    // with a redirect URL, so every database touch at sign-in happens here.
    // See the header of src/lib/auth-callbacks.ts for why that matters.
    async signIn({ user, account }) {
      return authorizeSignIn({
        user: user as SignInUser,
        provider: account?.provider,
      });
    },

    async jwt({ token, user, account }) {
      // Initial sign-in: pick up the local user row signIn() already linked
      // and, for the credentials provider only, store the Account-Server
      // access/refresh token pair (the OIDC flow doesn't hand those back in a
      // form we refresh ourselves — see the refresh guard below).
      if (user) {
        const identity = (user as SignInUser).cmsIdentity;
        if (!identity) {
          // Unreachable through the callback route, where signIn() always runs
          // first and redirects on failure. Fail closed with a labelled line
          // rather than provisioning here: a throw on THIS callback is exactly
          // what collapses to ?error=Configuration.
          logAuthFailure({
            stage: "jwt",
            provider: account?.provider,
            type: "MissingIdentity",
            reason:
              "reached the jwt callback without a provisioned local user; no session issued",
          });
          return null;
        }
        const { localUserId, currentOrganizationId } = identity;

        if (account?.provider === "credentials") {
          const u = user as AuthorizeUser;
          return {
            ...token,
            provider: "credentials",
            accessToken: u.accessToken,
            refreshToken: u.refreshToken,
            accessTokenExpiry: Date.now() + ACCESS_TOKEN_TTL_MS,
            role: u.role,
            localUserId,
            currentOrganizationId,
          };
        }

        return {
          ...token,
          provider: account?.provider,
          accessToken: undefined,
          refreshToken: undefined,
          accessTokenExpiry: undefined,
          role: undefined,
          localUserId,
          currentOrganizationId,
        };
      }

      // Only the credentials provider's Account-Server tokens get refreshed
      // here — an OIDC-issued token has no refreshToken to redeem against
      // this endpoint, and would otherwise force a spurious sign-out.
      if (token.provider !== "credentials" || !token.refreshToken) {
        return token;
      }

      // Token still valid — return as-is.
      const expiry = token.accessTokenExpiry as number | undefined;
      if (expiry && Date.now() < expiry - REFRESH_BUFFER_MS) {
        return token;
      }

      // Token expired (or about to) — refresh using OAuth grant with client credentials.
      const refreshed = await refreshAccessToken(token.refreshToken as string);
      if (!refreshed) {
        // Signal to the client that the session is dead.
        return { ...token, error: "RefreshAccessTokenError" };
      }

      return {
        ...token,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? token.refreshToken,
        accessTokenExpiry: Date.now() + ACCESS_TOKEN_TTL_MS,
        error: undefined,
      };
    },

    async session({ session, token }) {
      if (token.accessToken) {
        session.accessToken = token.accessToken as string;
      }
      session.user.role = token.role as string | undefined;
      // Prefer the local user id; older sessions predate provisioning and
      // carry the auth-server id, which loadActor resolves by email fallback.
      if (token.localUserId) {
        session.user.id = token.localUserId as string;
      }
      session.user.currentOrganizationId =
        (token.currentOrganizationId as string | undefined) ?? null;
      if (token.error) {
        session.error = token.error as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 24 * 60 * 60,
  },
});

declare module "next-auth" {
  interface Session {
    accessToken?: string;
    error?: string;
    user: {
      id: string;
      name: string;
      email: string;
      role?: string;
      currentOrganizationId?: string | null;
    };
  }

  interface JWT {
    provider?: string;
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiry?: number;
    role?: string;
    localUserId?: string;
    currentOrganizationId?: string | null;
    error?: string;
  }
}
