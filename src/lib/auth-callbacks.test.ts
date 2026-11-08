import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const provisionUser = vi.fn();
const getCurrentOrganizationId = vi.fn();

vi.mock("./rbac", () => ({
  provisionUser: (...args: unknown[]) => provisionUser(...args),
  getCurrentOrganizationId: (...args: unknown[]) =>
    getCurrentOrganizationId(...args),
}));

import {
  ACCOUNT_SETUP_ERROR_CODE,
  SSO_NO_EMAIL_ERROR_CODE,
  describeAuthError,
} from "./auth-errors";
import {
  AUTH_LOG_TAG,
  CLIENT_SAFE_ERROR_TYPES,
  authLogger,
  authorizeSignIn,
  clientErrorCode,
  mapInteractorProfile,
  type SignInUser,
} from "./auth-callbacks";

let errorLines: string[];
let warnLines: string[];

beforeEach(() => {
  provisionUser.mockReset();
  getCurrentOrganizationId.mockReset();
  errorLines = [];
  warnLines = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mapInteractorProfile", () => {
  it("maps a complete claim set", () => {
    expect(
      mapInteractorProfile({
        sub: "auth-123",
        name: "Ada Lovelace",
        email: "ada@interactor.com",
      })
    ).toEqual({
      id: "auth-123",
      name: "Ada Lovelace",
      email: "ada@interactor.com",
    });
  });

  it("falls back through preferred_username then the email local part", () => {
    expect(
      mapInteractorProfile({ sub: "s", preferred_username: "ada" }).name
    ).toBe("ada");
    expect(mapInteractorProfile({ sub: "s", email: "ada@x.com" }).name).toBe(
      "ada"
    );
  });

  it("prefers given_name + family_name over a username handle", () => {
    expect(
      mapInteractorProfile({
        sub: "s",
        given_name: "Peter",
        family_name: "Jung",
        preferred_username: "jsmith",
      }).name
    ).toBe("Peter Jung");
    expect(
      mapInteractorProfile({ sub: "s", given_name: "Peter", preferred_username: "jsmith" }).name
    ).toBe("Peter");
  });

  it("yields a null email — never undefined — when there is no email claim", () => {
    // The old `profile.email as string` cast let undefined reach
    // provisionUser(). Measured behaviour (src/lib/prisma-or-undefined.test.ts):
    // an undefined OR branch is DROPPED from the SQL, so the lookup silently
    // narrows to external_id alone — and an all-undefined `where` compiles to
    // `WHERE 1=0`. The empty string is the dangerous value, not undefined:
    // `{ email: "" }` compiles to a live `OR email = ''`, which matches the
    // blank-email row a previous blank-claim sign-in persisted.
    const mapped = mapInteractorProfile({ sub: "auth-123", name: "Ada" });
    expect(mapped.email).toBeNull();
    expect("email" in mapped).toBe(true);
  });

  it("treats a blank or non-string claim as absent", () => {
    expect(mapInteractorProfile({ sub: "s", email: "   " }).email).toBeNull();
    expect(mapInteractorProfile({ sub: "s", email: 42 }).email).toBeNull();
    expect(mapInteractorProfile({ email: "ada@x.com" }).id).toBe("");
  });
});

describe("authorizeSignIn", () => {
  it("provisions once and parks the result on the user for the jwt callback", async () => {
    provisionUser.mockResolvedValue("local-1");
    getCurrentOrganizationId.mockResolvedValue("org-1");
    const user: SignInUser = {
      id: "auth-123",
      email: "ada@interactor.com",
      name: "Ada",
    };

    await expect(
      authorizeSignIn({ user, provider: "interactor" })
    ).resolves.toBe(true);

    expect(provisionUser).toHaveBeenCalledWith({
      externalId: "auth-123",
      email: "ada@interactor.com",
      name: "Ada",
    });
    expect(user.cmsIdentity).toEqual({
      localUserId: "local-1",
      currentOrganizationId: "org-1",
    });
  });

  it("rejects an identity with no email before touching the database", async () => {
    const user: SignInUser = { id: "auth-123", email: null, name: "Ada" };

    const result = await authorizeSignIn({ user, provider: "interactor" });

    expect(result).toBe(`/login?error=${SSO_NO_EMAIL_ERROR_CODE}`);
    expect(provisionUser).not.toHaveBeenCalled();
    expect(user.cmsIdentity).toBeUndefined();
  });

  it("treats a blank email the same way", async () => {
    const result = await authorizeSignIn({
      user: { id: "auth-123", email: "   " },
      provider: "interactor",
    });
    expect(result).toBe(`/login?error=${SSO_NO_EMAIL_ERROR_CODE}`);
    expect(provisionUser).not.toHaveBeenCalled();
  });

  it("routes a provisioning failure to a code /login can explain, not Configuration", async () => {
    provisionUser.mockRejectedValue(
      new Error("Can't reach database server at localhost:5460")
    );

    const result = await authorizeSignIn({
      user: { id: "auth-123", email: "ada@interactor.com" },
      provider: "interactor",
    });

    expect(result).toBe(`/login?error=${ACCOUNT_SETUP_ERROR_CODE}`);
    expect(result).not.toContain("Configuration");
  });

  it("routes an org-resolution failure the same way", async () => {
    provisionUser.mockResolvedValue("local-1");
    getCurrentOrganizationId.mockRejectedValue(new Error("connection refused"));

    const user: SignInUser = { id: "auth-123", email: "ada@interactor.com" };
    const result = await authorizeSignIn({ user, provider: "interactor" });

    expect(result).toBe(`/login?error=${ACCOUNT_SETUP_ERROR_CODE}`);
    expect(user.cmsIdentity).toBeUndefined();
  });

  it("emits codes /login already has plain-language messages for", async () => {
    for (const code of [SSO_NO_EMAIL_ERROR_CODE, ACCOUNT_SETUP_ERROR_CODE]) {
      const message = describeAuthError(code);
      expect(message, code).not.toBeNull();
      // Not the generic fallback — these must say something specific.
      expect(message!.title, code).not.toBe("We couldn't sign you in");
    }
  });

  it("logs a greppable line naming the stage, provider and reason", async () => {
    provisionUser.mockRejectedValue(new Error("Can't reach database server"));

    await authorizeSignIn({
      user: { id: "auth-123", email: "ada@interactor.com" },
      provider: "interactor",
    });

    const line = errorLines.find((l) => l.startsWith(AUTH_LOG_TAG));
    expect(line).toBeDefined();
    expect(line).toContain("stage=provisionUser");
    expect(line).toContain("provider=interactor");
    expect(line).toContain(`type=${ACCOUNT_SETUP_ERROR_CODE}`);
    // On this path the redirect carries the same value, so both halves agree.
    expect(line).toContain(`code=${ACCOUNT_SETUP_ERROR_CODE}`);
    expect(line).toContain("Can't reach database server");
  });

  it("logs the no-email refusal with the code /login will receive", async () => {
    await authorizeSignIn({
      user: { id: "auth-123", email: null },
      provider: "interactor",
    });

    const line = errorLines.find((l) => l.startsWith(AUTH_LOG_TAG));
    expect(line).toContain("stage=signIn");
    expect(line).toContain(`code=${SSO_NO_EMAIL_ERROR_CODE}`);
  });
});

describe("clientErrorCode", () => {
  it("maps anything off the client-safe list to Configuration", () => {
    // This is the mapping the whole goal turns on: Auth.js wraps every throw
    // from our own callbacks in CallbackRouteError, which is NOT client-safe,
    // so the user lands on /login?error=Configuration.
    expect(clientErrorCode("CallbackRouteError")).toBe("Configuration");
    expect(clientErrorCode("OAuthProfileParseError")).toBe("Configuration");
    expect(clientErrorCode(undefined)).toBe("Configuration");
    expect(clientErrorCode("")).toBe("Configuration");
  });

  it("passes a client-safe type through unchanged", () => {
    for (const type of CLIENT_SAFE_ERROR_TYPES) {
      expect(clientErrorCode(type), type).toBe(type);
    }
  });

  it("mirrors the clientErrors set of the @auth/core copy next-auth actually loads", async () => {
    // Reads UPSTREAM, not a second copy of our own literal — otherwise this
    // test only proves the mirror equals itself and an Auth.js upgrade that
    // adds or drops a type slips through, leaving log lines that claim
    // Configuration while the URL says otherwise.
    //
    // `clientErrors` is module-private, so the set is reconstructed the only
    // way upstream exposes it: instantiate every exported AuthError subclass
    // and ask upstream's own `isClientError` about it. Resolving through
    // next-auth's entry point deliberately picks the NESTED @auth/core it
    // loads at runtime (0.41.2 here), not the older hoisted copy this repo
    // also has in package.json — the nested one is what throws in production.
    const upstreamErrors = createRequire(
      createRequire(import.meta.url).resolve("next-auth")
    ).resolve("@auth/core/errors");
    const upstream = (await import(pathToFileURL(upstreamErrors).href)) as {
      AuthError: new (message?: string) => Error & { type: string };
      isClientError: (error: unknown) => boolean;
    };

    const clientSafe = new Set<string>();
    for (const exported of Object.values(upstream)) {
      if (typeof exported !== "function") continue;
      if (!(exported.prototype instanceof upstream.AuthError)) continue;
      const instance = new (exported as new (message?: string) => Error & {
        type: string;
      })("probe");
      if (upstream.isClientError(instance)) clientSafe.add(instance.type);
    }

    // Guard against the reflection above quietly finding nothing (a bundling
    // or export-shape change upstream) and the comparison passing vacuously.
    expect(clientSafe.size).toBeGreaterThan(0);
    expect([...CLIENT_SAFE_ERROR_TYPES].sort()).toEqual([...clientSafe].sort());
  });

  it("every client-safe code has a plain-language message on /login", () => {
    for (const type of CLIENT_SAFE_ERROR_TYPES) {
      expect(describeAuthError(type), type).not.toBeNull();
    }
    // The ones this app's providers can actually raise get a message of their
    // own, not the generic fallback. (AccountNotLinked and
    // WebAuthnVerificationError need an Adapter / a WebAuthn provider, neither
    // of which this app configures, so the fallback is the right treatment.)
    for (const type of [
      "CredentialsSignin",
      "OAuthCallbackError",
      "AccessDenied",
      "MissingCSRF",
      "Configuration",
    ]) {
      expect(describeAuthError(type)!.title, type).not.toBe(
        "We couldn't sign you in"
      );
    }
  });
});

describe("authLogger", () => {
  it("unwraps the Auth.js cause so the real reason reaches the process log", () => {
    // Shape Auth.js's CallbackRouteError uses: the original throw under
    // cause.err, the provider id alongside it.
    const inner = new Error("PrismaClientInitializationError");
    const wrapped = Object.assign(new Error("Read more at https://errors.authjs.dev"), {
      type: "CallbackRouteError",
      cause: { provider: "interactor", err: inner },
    });

    authLogger.error(wrapped);

    const line = errorLines.find((l) => l.startsWith(AUTH_LOG_TAG));
    expect(line).toContain("stage=authjs");
    expect(line).toContain("provider=interactor");
    expect(line).toContain("type=CallbackRouteError");
    // The half that matches what the user sees: Auth.js flattens a
    // CallbackRouteError to /login?error=Configuration, so an operator can
    // grep the code straight out of a support report's URL.
    expect(line).toContain("code=Configuration");
    expect(line).toContain("PrismaClientInitializationError");
    // And the stack of the ORIGINAL throw, on its own continuation line.
    expect(errorLines.some((l) => l.startsWith(`${AUTH_LOG_TAG} cause:`))).toBe(
      true
    );
  });

  it("reports a client-safe type as its own code", () => {
    authLogger.error(
      Object.assign(new Error("no access"), {
        type: "AccessDenied",
        cause: { provider: "interactor" },
      })
    );
    const line = errorLines.find((l) => l.startsWith(AUTH_LOG_TAG));
    expect(line).toContain("type=AccessDenied");
    expect(line).toContain("code=AccessDenied");
  });

  it("still logs an error with no cause attached", () => {
    authLogger.error(Object.assign(new Error("boom"), { type: "Configuration" }));
    const line = errorLines.find((l) => l.startsWith(AUTH_LOG_TAG));
    expect(line).toContain("type=Configuration");
    expect(line).toContain("code=Configuration");
    expect(line).toContain("provider=-");
    expect(line).toContain("boom");
  });

  it("tags warnings with the same grep token", () => {
    authLogger.warn("debug-enabled");
    expect(warnLines[0]).toBe(`${AUTH_LOG_TAG} warn code=debug-enabled`);
  });
});
