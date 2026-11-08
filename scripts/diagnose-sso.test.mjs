// Unit tests for the pure verdict helpers behind `npm run diagnose:sso`. The
// network legs are exercised by passing the fetch result in, so these run
// offline — the script itself is what talks to the account server.
import { describe, expect, it } from "vitest";
import {
  CALLBACK_PATH,
  CONTROL_REDIRECT_URI,
  LOCAL_ENV_FILE,
  PROD_ENV_FILE,
  checkOidcClient,
  checkPublicUrl,
  checkSecret,
  describeAuthorizeProbe,
  describeDiscovery,
  envFileFor,
  parseArgs,
  resolveProbeRedirectUri,
} from "./diagnose-sso.mjs";

const ORIGIN = "https://cms.interactor.com";
const ISSUER = "https://auth.interactor.com";
const FILE = PROD_ENV_FILE;

describe("envFileFor", () => {
  it("names the systemd EnvironmentFile in production", () => {
    expect(envFileFor("production", ORIGIN)).toBe(PROD_ENV_FILE);
  });

  it("names the gitignored local file when the origin is localhost", () => {
    expect(envFileFor("development", "http://localhost:4021")).toBe(LOCAL_ENV_FILE);
    expect(envFileFor(undefined, "http://127.0.0.1:4021")).toBe(LOCAL_ENV_FILE);
  });

  it("names both when NODE_ENV is unset on a remote origin — the on-box case", () => {
    // `node --env-file=/opt/.../.env scripts/diagnose-sso.mjs` need not set
    // NODE_ENV, and sending that operator to edit .env.local would be wrong.
    const hint = envFileFor(undefined, ORIGIN);
    expect(hint).toContain(PROD_ENV_FILE);
    expect(hint).toContain(LOCAL_ENV_FILE);
  });
});

describe("resolveProbeRedirectUri", () => {
  it("builds the redirect_uri from NEXTAUTH_URL, as Auth.js does", () => {
    const result = resolveProbeRedirectUri({ NEXTAUTH_URL: `${ORIGIN}/` }, ORIGIN);
    expect(result.redirectUri).toBe(`${ORIGIN}${CALLBACK_PATH}`);
    expect(result.source).toBe("NEXTAUTH_URL");
  });

  it("probes the STALE origin so a stale NEXTAUTH_URL self-demonstrates", () => {
    const result = resolveProbeRedirectUri(
      { NEXTAUTH_URL: "https://pm.interactor.com" },
      ORIGIN
    );
    expect(result.redirectUri).toBe(`https://pm.interactor.com${CALLBACK_PATH}`);
  });

  it("prefers AUTH_URL, which next-auth reads first", () => {
    const result = resolveProbeRedirectUri(
      { AUTH_URL: ORIGIN, NEXTAUTH_URL: "https://pm.interactor.com" },
      ORIGIN
    );
    expect(result.redirectUri).toBe(`${ORIGIN}${CALLBACK_PATH}`);
    expect(result.source).toBe("AUTH_URL");
  });

  it("falls back to the served origin when neither is set or parses", () => {
    expect(resolveProbeRedirectUri({}, ORIGIN)).toEqual({
      redirectUri: `${ORIGIN}${CALLBACK_PATH}`,
      source: "--origin",
    });
    expect(
      resolveProbeRedirectUri({ NEXTAUTH_URL: "cms.interactor.com" }, ORIGIN).source
    ).toBe("--origin");
  });
});

describe("checkSecret", () => {
  it("fails and names the var when neither spelling is set", () => {
    const result = checkSecret({}, FILE);
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("NEXTAUTH_SECRET");
    expect(result.fix).toContain(FILE);
  });

  it("treats a blank value as missing", () => {
    expect(checkSecret({ NEXTAUTH_SECRET: "   " }, FILE).status).toBe("fail");
  });

  it("accepts either spelling", () => {
    expect(checkSecret({ NEXTAUTH_SECRET: "s" }, FILE).status).toBe("pass");
    expect(checkSecret({ AUTH_SECRET: "s" }, FILE).status).toBe("pass");
  });

  it("says which one wins when the two disagree", () => {
    const result = checkSecret({ AUTH_SECRET: "a", NEXTAUTH_SECRET: "b" }, FILE);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("AUTH_SECRET is set");
    expect(result.detail).toContain("ignored");
  });
});

describe("checkOidcClient", () => {
  it("passes when both halves are present and carries the id forward", () => {
    const result = checkOidcClient(
      { INTERACTOR_AUTH_CLIENT_ID: "app_x", INTERACTOR_AUTH_CLIENT_SECRET: "shh" },
      FILE
    );
    expect(result.status).toBe("pass");
    expect(result.clientId).toBe("app_x");
  });

  it("names only the half that is missing", () => {
    const result = checkOidcClient({ INTERACTOR_AUTH_CLIENT_ID: "app_x" }, FILE);
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("INTERACTOR_AUTH_CLIENT_SECRET");
    expect(result.fix).not.toContain("INTERACTOR_AUTH_CLIENT_ID and");
  });
});

describe("checkPublicUrl", () => {
  it("passes when the origin matches the served host", () => {
    expect(
      checkPublicUrl({ NEXTAUTH_URL: `${ORIGIN}/` }, ORIGIN, FILE).status
    ).toBe("pass");
  });

  it("fails on a stale origin and shows the redirect_uri it would send", () => {
    const result = checkPublicUrl(
      { NEXTAUTH_URL: "https://pm.interactor.com" },
      ORIGIN,
      FILE
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain(`https://pm.interactor.com${CALLBACK_PATH}`);
    expect(result.fix).toContain(`NEXTAUTH_URL=${ORIGIN}`);
  });

  it("prefers AUTH_URL, which next-auth reads first", () => {
    const result = checkPublicUrl(
      { AUTH_URL: ORIGIN, NEXTAUTH_URL: "https://pm.interactor.com" },
      ORIGIN,
      FILE
    );
    expect(result.status).toBe("pass");
  });

  it("warns rather than fails when neither is set", () => {
    expect(checkPublicUrl({}, ORIGIN, FILE).status).toBe("warn");
  });

  it("fails on an unparsable value", () => {
    expect(checkPublicUrl({ NEXTAUTH_URL: "cms.interactor.com" }, ORIGIN, FILE).status).toBe(
      "fail"
    );
  });
});

describe("describeDiscovery", () => {
  const doc = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
  };

  it("passes on a matching issuer and hands the authorize endpoint on", () => {
    const result = describeDiscovery(ISSUER, { status: 200, doc }, FILE);
    expect(result.status).toBe("pass");
    expect(result.authorizationEndpoint).toBe(`${ISSUER}/oauth/authorize`);
  });

  it("ignores a trailing slash on the configured issuer", () => {
    expect(describeDiscovery(`${ISSUER}/`, { status: 200, doc }, FILE).status).toBe("pass");
  });

  it("fails when the document declares a different issuer", () => {
    const result = describeDiscovery(
      "https://auth.staging.interactor.com",
      { status: 200, doc },
      FILE
    );
    expect(result.status).toBe("fail");
    expect(result.fix).toContain(`ACCOUNT_SERVER_URL=${ISSUER}`);
  });

  it("fails on a non-200 and on a network error", () => {
    expect(describeDiscovery(ISSUER, { status: 404 }, FILE).status).toBe("fail");
    expect(describeDiscovery(ISSUER, { error: "ENOTFOUND" }, FILE).status).toBe("fail");
  });
});

describe("describeAuthorizeProbe", () => {
  const uri = `${ORIGIN}${CALLBACK_PATH}`;
  // The control pair verified against auth.interactor.com on 2026-08-28:
  // a registered redirect_uri answers 302 to the hosted login, an unregistered
  // one answers 400.
  const rejectingControl = { status: 400 };

  it("reads a 302 as registered once the control proves 400 means rejected", () => {
    const result = describeAuthorizeProbe(
      uri,
      "app_x",
      { status: 302, location: `${ISSUER}/oauth/login` },
      rejectingControl
    );
    expect(result.status).toBe("pass");
    expect(result.detail).toContain(CONTROL_REDIRECT_URI);
  });

  it("reads a 400 as not registered and points at the account server", () => {
    const result = describeAuthorizeProbe(uri, "app_x", { status: 400 }, rejectingControl);
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("account-server change");
  });

  it("refuses to pass when the control gets the SAME 302 as the real request", () => {
    // A server that authenticates first and validates redirect_uri after login
    // — or an edge login wall in front of one — answers 302 to anything.
    // Calling that a PASS is the false positive this leg exists to prevent.
    const result = describeAuthorizeProbe(
      uri,
      "app_x",
      { status: 302, location: `${ISSUER}/oauth/login` },
      { status: 302, location: `${ISSUER}/oauth/login` }
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("unproven");
    expect(result.detail).toContain("proves nothing");
  });

  it("refuses to pass when the control cannot be reached or is unreadable", () => {
    expect(
      describeAuthorizeProbe(uri, "app_x", { status: 302 }, { error: "ETIMEDOUT" }).status
    ).toBe("fail");
    expect(describeAuthorizeProbe(uri, "app_x", { status: 302 }, { status: 500 }).status).toBe(
      "fail"
    );
  });

  it("fails, rather than warns, when the authorize endpoint is unreachable", () => {
    const result = describeAuthorizeProbe(
      uri,
      "app_x",
      { error: "ETIMEDOUT" },
      rejectingControl
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("could not reach");
  });

  it("fails on any answer it cannot interpret", () => {
    const result = describeAuthorizeProbe(uri, "app_x", { status: 500 }, rejectingControl);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("unproven");
  });

  it("names the stale redirect_uri it actually probed", () => {
    const stale = `https://pm.interactor.com${CALLBACK_PATH}`;
    const result = describeAuthorizeProbe(stale, "app_x", { status: 400 }, rejectingControl);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain(stale);
  });
});

describe("parseArgs", () => {
  it("defaults to the production origin", () => {
    expect(parseArgs([]).origin).toBe(ORIGIN);
  });

  it("accepts both --origin spellings", () => {
    expect(parseArgs(["--origin", "http://localhost:4021"]).origin).toBe(
      "http://localhost:4021"
    );
    expect(parseArgs(["--origin=http://localhost:4021"]).origin).toBe(
      "http://localhost:4021"
    );
  });
});
