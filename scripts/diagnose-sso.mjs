#!/usr/bin/env node
// Checks every leg of the Interactor SSO (OIDC) sign-in chain for cms.interactor.com
// and says, for each one, whether it passes — and if not, the exact env var to set
// and the exact file to set it in.
//
//   npm run diagnose:sso                       # reads .env then .env.local
//   npm run diagnose:sso -- --origin http://localhost:4021
//   node --env-file=/opt/interactor-cms/content-management/.env \
//     scripts/diagnose-sso.mjs                 # on the production box
//
// Deliberately dependency-free so it can be scp'd to the box on its own: the
// deploy workflow only rsyncs prisma/ and .next/standalone/, so scripts/ is not
// there, and the box has no node_modules for this repo outside the standalone
// bundle.
//
// WHY THIS EXISTS. `?error=Configuration` is Auth.js's catch-all for ANY
// non-client-safe throw anywhere in the flow, so it does not mean "the OIDC
// provider is misconfigured" — and `GET /api/auth/signin/interactor` returns
// `302 -> /login?error=Configuration` on a perfectly healthy Auth.js v5 app
// (renderPage.signin() throws UnknownAction when a provider id is present on a
// GET; sign-in with a provider is POST-only). That false positive cost this
// goal its first diagnosis. The checks below probe the things that can actually
// be wrong, one at a time. See DEPLOYMENT.md § "Diagnosing SSO".
//
// A check only passes when it actually proved something. Anything it could not
// establish — an unreachable account server, an answer it cannot interpret, a
// control request that does not discriminate — is a FAIL with a plain-language
// reason, never a quiet warning under an "all checks passed" summary. A tool
// built to stop an operator concluding "the config is fine" must not be the
// thing that tells them so.
import process from "node:process";
import { pathToFileURL } from "node:url";

/** systemd `EnvironmentFile=` on the production box (deploy-production.yml). */
export const PROD_ENV_FILE = "/opt/interactor-cms/content-management/.env";
/** Where the same value goes for local dev (gitignored). */
export const LOCAL_ENV_FILE = ".env.local";

/** The origin the CMS is actually served on in production. */
export const DEFAULT_ORIGIN = "https://cms.interactor.com";
/** Provider id in src/lib/auth.ts — it decides the callback path Auth.js uses. */
export const PROVIDER_ID = "interactor";
export const CALLBACK_PATH = `/api/auth/callback/${PROVIDER_ID}`;
const DEFAULT_ACCOUNT_SERVER = "https://auth.interactor.com";

/**
 * The control redirect_uri: a well-formed URL on the reserved `.invalid` TLD
 * (RFC 2606), so it can never be registered for any client by accident. The
 * account server only string-matches redirect_uris against its registration
 * list, so it never resolves this host.
 */
export const CONTROL_REDIRECT_URI = `https://redirect-uri-not-registered.invalid${CALLBACK_PATH}`;

// RFC 7636 §4.6 example verifier/challenge pair. Public test vector, not a
// secret: the authorize endpoint only needs a well-formed S256 challenge to
// answer the whitelist question we are asking it.
const PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const PROBE_NAME = "redirect_uri whitelisted";

function isLocalOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Which file a missing value must be added to. NODE_ENV alone is the wrong
 * signal: the documented on-box invocation is
 * `node --env-file=/opt/.../.env scripts/diagnose-sso.mjs`, and that .env need
 * not set NODE_ENV — naming `.env.local` there would send the operator to edit
 * a file that does not exist on the box. So the origin under test decides when
 * NODE_ENV does not, and when neither settles it we name both.
 */
export function envFileFor(nodeEnv, origin) {
  if (nodeEnv === "production") return PROD_ENV_FILE;
  if (origin && isLocalOrigin(origin)) return LOCAL_ENV_FILE;
  return `${PROD_ENV_FILE} on the box (or ${LOCAL_ENV_FILE} in a local checkout)`;
}

function value(env, name) {
  const raw = env[name];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function trimSlash(url) {
  return url.replace(/\/+$/, "");
}

const pass = (name, detail, extra) => ({ name, status: "pass", detail, ...extra });
const fail = (name, detail, fix, extra) => ({ name, status: "fail", detail, fix, ...extra });
const warn = (name, detail, fix, extra) => ({ name, status: "warn", detail, fix, ...extra });

/**
 * next-auth v5 reads `AUTH_SECRET ?? NEXTAUTH_SECRET` (next-auth/lib/env.js),
 * so either name works and AUTH_SECRET wins when both are set. Without one,
 * Auth.js cannot sign the state/PKCE cookies the callback leg verifies.
 */
export function checkSecret(env, envFile) {
  const authSecret = value(env, "AUTH_SECRET");
  const nextAuthSecret = value(env, "NEXTAUTH_SECRET");
  if (!authSecret && !nextAuthSecret) {
    return fail(
      "session secret",
      "neither AUTH_SECRET nor NEXTAUTH_SECRET is set — Auth.js cannot sign the state/PKCE cookies, so every callback fails",
      `set NEXTAUTH_SECRET (\`openssl rand -base64 32\`) in ${envFile}`
    );
  }
  const inEffect = authSecret ? "AUTH_SECRET" : "NEXTAUTH_SECRET";
  const shadowed =
    authSecret && nextAuthSecret && authSecret !== nextAuthSecret
      ? " (NEXTAUTH_SECRET is also set to a different value and is ignored)"
      : "";
  return pass("session secret", `${inEffect} is set${shadowed}`);
}

/**
 * `oidcEnabled` in src/lib/auth.ts requires BOTH values; with either missing
 * the `interactor` provider is never registered, so /auth/sso has nothing to
 * hand off to and the SSO button is hidden.
 */
export function checkOidcClient(env, envFile) {
  const id = value(env, "INTERACTOR_AUTH_CLIENT_ID");
  const secret = value(env, "INTERACTOR_AUTH_CLIENT_SECRET");
  if (id && secret) {
    return pass("OIDC client", `client_id ${id} configured, client secret present`, {
      clientId: id,
    });
  }
  const missing = [
    !id && "INTERACTOR_AUTH_CLIENT_ID",
    !secret && "INTERACTOR_AUTH_CLIENT_SECRET",
  ].filter(Boolean);
  return fail(
    "OIDC client",
    `${missing.join(" and ")} missing — src/lib/auth.ts gates the "${PROVIDER_ID}" provider on both, so it is not registered at all`,
    `set ${missing.join(" and ")} in ${envFile} (values come from the Interactor auth dashboard)`,
    { clientId: id }
  );
}

/**
 * next-auth's `reqWithEnvURL()` REWRITES the incoming request origin to
 * `AUTH_URL ?? NEXTAUTH_URL`, so a stale value silently rewrites the
 * redirect_uri Auth.js sends to the account server — the authorize URL still
 * builds, and the callback then lands on the wrong host. `env.NEXTAUTH_URL`
 * also builds the Interactor Core OAuth return URLs (src/app/api/social/...).
 */
export function checkPublicUrl(env, expectedOrigin, envFile) {
  const raw = value(env, "AUTH_URL") ?? value(env, "NEXTAUTH_URL");
  if (!raw) {
    return warn(
      "public URL",
      "neither AUTH_URL nor NEXTAUTH_URL is set — Auth.js falls back to the forwarded host (trustHost is on), which works only while the proxy sends the right Host/X-Forwarded-Host",
      `set NEXTAUTH_URL=${expectedOrigin} in ${envFile} to pin it`
    );
  }
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return fail(
      "public URL",
      `NEXTAUTH_URL is not a valid URL (${raw})`,
      `set NEXTAUTH_URL=${expectedOrigin} in ${envFile}`
    );
  }
  if (origin !== expectedOrigin) {
    return fail(
      "public URL",
      `points at ${origin} but the app is served on ${expectedOrigin} — Auth.js rewrites the request origin to it, so it sends redirect_uri=${origin}${CALLBACK_PATH}`,
      `set NEXTAUTH_URL=${expectedOrigin} in ${envFile}`
    );
  }
  return pass("public URL", `${origin} matches the served origin`);
}

/**
 * The redirect_uri to probe is the one Auth.js would actually send, which is
 * built from `AUTH_URL ?? NEXTAUTH_URL` — NOT from `--origin`. That is the
 * point: a stale NEXTAUTH_URL then self-demonstrates here as a redirect_uri
 * the account server rejects, instead of only showing up as a mismatch two
 * legs earlier. `--origin` is the fallback for when neither is set (Auth.js
 * would fall back to the forwarded host, which is the served origin).
 */
export function resolveProbeRedirectUri(env, expectedOrigin) {
  const raw = value(env, "AUTH_URL") ?? value(env, "NEXTAUTH_URL");
  if (raw) {
    try {
      const origin = new URL(raw).origin;
      return {
        redirectUri: `${origin}${CALLBACK_PATH}`,
        source: value(env, "AUTH_URL") ? "AUTH_URL" : "NEXTAUTH_URL",
      };
    } catch {
      // Unparsable — checkPublicUrl already failed on it; probe the served
      // origin so this leg still reports something useful.
    }
  }
  return { redirectUri: `${expectedOrigin}${CALLBACK_PATH}`, source: "--origin" };
}

/**
 * Auth.js discovers the token/userinfo endpoints from the provider's
 * `issuer`, and rejects a document whose own `issuer` disagrees with it.
 */
export function describeDiscovery(issuer, result, envFile) {
  const url = `${trimSlash(issuer)}/.well-known/openid-configuration`;
  if (result.error) {
    return fail(
      "issuer discovery",
      `${url} could not be fetched (${result.error})`,
      `check ACCOUNT_SERVER_URL in ${envFile} and that the box can reach ${trimSlash(issuer)}`
    );
  }
  if (result.status !== 200) {
    return fail(
      "issuer discovery",
      `${url} answered ${result.status}, so Auth.js cannot discover the token endpoint`,
      `check ACCOUNT_SERVER_URL in ${envFile} — it must be the issuer origin, e.g. ${DEFAULT_ACCOUNT_SERVER}`
    );
  }
  const doc = result.doc;
  if (!doc || typeof doc.issuer !== "string") {
    return fail(
      "issuer discovery",
      `${url} did not return an OpenID configuration document`,
      `check ACCOUNT_SERVER_URL in ${envFile}`
    );
  }
  if (trimSlash(doc.issuer) !== trimSlash(issuer)) {
    return fail(
      "issuer discovery",
      `the document declares issuer ${doc.issuer}, but the provider is configured with ${trimSlash(issuer)} — Auth.js rejects the mismatch`,
      `set ACCOUNT_SERVER_URL=${trimSlash(doc.issuer)} in ${envFile}`,
      { authorizationEndpoint: doc.authorization_endpoint }
    );
  }
  return pass(
    "issuer discovery",
    `${doc.issuer} — authorize ${doc.authorization_endpoint}, token ${doc.token_endpoint}`,
    { authorizationEndpoint: doc.authorization_endpoint }
  );
}

const accepted = (status) => status >= 300 && status < 400;
const rejected = (status) => status >= 400 && status < 500;

/**
 * Reads the authorize endpoint's answer for our own redirect_uri — but only
 * once a CONTROL request, the identical call carrying a deliberately
 * unregistered redirect_uri, has proved the endpoint distinguishes the two at
 * all. Verified 2026-08-28 against auth.interactor.com: registered answers
 * `302 -> /oauth/login`, unregistered answers `400`.
 *
 * Without that control the leg is not a test. An OAuth server that
 * authenticates first and validates redirect_uri after login — or an edge
 * login wall in front of one — answers 302 for everything, and reading that
 * as "registered" is exactly the false PASS this whole diagnostic exists to
 * stop. When the control does not discriminate we report the leg as failed
 * (unproven), not passed.
 */
export function describeAuthorizeProbe(redirectUri, clientId, result, control) {
  const unproven = (detail, fix) =>
    fail(PROBE_NAME, `unproven — ${detail}`, fix, { unproven: true });
  const dashboard = `check the redirect_uris registered for client ${clientId} directly in the Interactor auth dashboard`;

  if (result.error) {
    return fail(
      PROBE_NAME,
      `could not reach the authorize endpoint (${result.error}), so the registration of ${redirectUri} is unchecked`,
      "re-run from a host that can reach the account server — if the account server itself is down, that alone explains the failed sign-ins",
      { unproven: true }
    );
  }
  if (control.error) {
    return unproven(
      `the control request (the same call with the unregistered ${CONTROL_REDIRECT_URI}) could not be reached (${control.error}), so the ${result.status} for ${redirectUri} cannot be interpreted`,
      `re-run when the account server is reachable, or ${dashboard}`
    );
  }
  if (accepted(control.status)) {
    return unproven(
      `the account server answered the control request — the same call with the unregistered ${CONTROL_REDIRECT_URI} — with ${control.status}, the same way it answers a registered one, so it does not reject unknown redirect_uris up front (some validate only after login, and an edge login wall does the same). The ${result.status} for ${redirectUri} therefore proves nothing`,
      dashboard
    );
  }
  if (!rejected(control.status)) {
    return unproven(
      `the control request answered ${control.status}, which is neither the redirect that means "accepted" nor the 4xx that means "rejected" — the account server is not answering as expected, so this leg cannot be read`,
      `check the account server's health and its logs for client ${clientId}`
    );
  }
  // The control discriminates: a rejection really does mean "not registered".
  if (accepted(result.status)) {
    return pass(
      PROBE_NAME,
      `${redirectUri} accepted for client ${clientId} (${result.status} to ${result.location || "the hosted login"}; the control ${CONTROL_REDIRECT_URI} was rejected ${control.status}, so that redirect is meaningful)`
    );
  }
  if (rejected(result.status)) {
    return fail(
      PROBE_NAME,
      `the account server rejected ${redirectUri} for client ${clientId} (${result.status}) — the same way it rejected the deliberately unregistered control, so this redirect_uri is not registered`,
      `if that URI is wrong, fix the origin it came from (see the public URL check above); if it is right, register ${redirectUri} as an allowed redirect_uri for client ${clientId} in the Interactor auth dashboard — an account-server change, not a CMS one`
    );
  }
  return unproven(
    `the authorize endpoint answered ${result.status} for ${redirectUri}, which is neither the redirect that means "registered" nor the 4xx that means "not registered", even though the control was rejected ${control.status}`,
    `check the account server logs for client ${clientId}`
  );
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    let doc;
    try {
      doc = await res.json();
    } catch {
      doc = undefined;
    }
    return { status: res.status, doc };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function probeAuthorize(endpoint, clientId, redirectUri) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { error: `${endpoint} is not a usable authorize endpoint` };
  }
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email",
    state: "cms-sso-diagnostic",
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: "S256",
  }).toString();
  try {
    const res = await fetch(url, { redirect: "manual" });
    return { status: res.status, location: res.headers.get("location") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseArgs(argv) {
  const options = { origin: DEFAULT_ORIGIN, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--origin") options.origin = argv[++i];
    else if (arg.startsWith("--origin=")) options.origin = arg.slice("--origin=".length);
  }
  return options;
}

const LABEL = { pass: "PASS", fail: "FAIL", warn: "WARN" };

function print(result) {
  console.log(`${LABEL[result.status]}  ${result.name.padEnd(24)} ${result.detail}`);
  if (result.fix) console.log(`      -> ${result.fix}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        "Usage: node scripts/diagnose-sso.mjs [--origin <url>]",
        "",
        `  --origin  the origin the CMS is actually served on (default ${DEFAULT_ORIGIN})`,
        "",
        "Reads the environment it is started with; npm run diagnose:sso loads",
        `.env then .env.local. On the box, point --env-file at ${PROD_ENV_FILE}.`,
      ].join("\n")
    );
    return 0;
  }

  let expectedOrigin;
  try {
    expectedOrigin = new URL(options.origin).origin;
  } catch {
    console.error(`--origin must be a URL, got: ${options.origin}`);
    return 2;
  }

  const env = process.env;
  const envFile = envFileFor(env.NODE_ENV, expectedOrigin);
  const issuer = value(env, "ACCOUNT_SERVER_URL") ?? DEFAULT_ACCOUNT_SERVER;
  const { redirectUri, source } = resolveProbeRedirectUri(env, expectedOrigin);

  console.log(`Interactor SSO diagnostic — origin ${expectedOrigin}, issuer ${trimSlash(issuer)}`);
  console.log(`Probing redirect_uri ${redirectUri} (built from ${source}, as Auth.js builds it).`);
  console.log(`Env values are read from the running environment; missing ones belong in ${envFile}.`);
  console.log("");

  const results = [];
  results.push(checkSecret(env, envFile));
  const client = checkOidcClient(env, envFile);
  results.push(client);
  results.push(checkPublicUrl(env, expectedOrigin, envFile));

  const discovery = describeDiscovery(
    issuer,
    await fetchJson(`${trimSlash(issuer)}/.well-known/openid-configuration`),
    envFile
  );
  results.push(discovery);

  const authorizeEndpoint =
    discovery.authorizationEndpoint ?? `${trimSlash(issuer)}/oauth/authorize`;
  if (!client.clientId) {
    results.push(
      warn(
        PROBE_NAME,
        "skipped — there is no client_id to probe the authorize endpoint with",
        "fix the OIDC client check above, then re-run"
      )
    );
  } else {
    // Real first, then the control — the control's answer is what decides
    // whether the real one can be read at all.
    const real = await probeAuthorize(authorizeEndpoint, client.clientId, redirectUri);
    const control = await probeAuthorize(
      authorizeEndpoint,
      client.clientId,
      CONTROL_REDIRECT_URI
    );
    results.push(describeAuthorizeProbe(redirectUri, client.clientId, real, control));
  }

  for (const result of results) print(result);

  const failed = results.filter((r) => r.status === "fail");
  const warned = results.filter((r) => r.status === "warn");
  console.log("");
  if (failed.length === 0) {
    const caveat = warned.length ? ` ${warned.length} warning(s) above are worth reading.` : "";
    console.log(`All checks passed.${caveat} Start a real sign-in at ${expectedOrigin}/auth/sso.`);
    console.log(
      `Do NOT test with GET ${expectedOrigin}/api/auth/signin/${PROVIDER_ID} — it answers ` +
        "302 -> /login?error=Configuration even when everything is healthy (sign-in with a " +
        "provider is POST-only). See DEPLOYMENT.md § Diagnosing SSO."
    );
    return 0;
  }
  console.log(`${failed.length} check(s) failed: ${failed.map((r) => r.name).join(", ")}.`);
  if (failed.some((r) => r.unproven)) {
    console.log(
      "A leg the script could not prove either way counts as failed on purpose — it has not " +
        "told you the configuration is fine, only that it could not check."
    );
  }
  console.log(
    `On the production box the env file is ${PROD_ENV_FILE} (systemd EnvironmentFile= for ` +
      "interactor-cms); apply changes with `systemctl restart interactor-cms`."
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main();
}
