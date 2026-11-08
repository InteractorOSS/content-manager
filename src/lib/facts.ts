import { readFile } from "node:fs/promises";
import path from "node:path";

// Resolves {{facts.<key>}} tokens in FAQ answers against a shared source of
// product constants, so an answer never hand-types a number that can drift
// out of sync (a price, a memory limit, ...).
//
// TODO(public-facts-endpoint): the real source is
// https://build.interactor.com/api/public/facts, contract documented at
// product-manager's docs/engine/public-facts.md. Neither the endpoint nor
// that doc exists yet as of this writing (tracked as its own product-manager
// goal) — until it ships, this reads the flat key/value map in `_facts.json`
// at the repo root instead. Once the endpoint is live, this file is the only
// place that needs to change: swap FACTS_ENDPOINT's fetch for the real one,
// or simply let the fetch-first logic below start succeeding.
const FACTS_ENDPOINT = "https://build.interactor.com/api/public/facts";
const FACTS_FIXTURE_PATH = path.join(process.cwd(), "_facts.json");
const CACHE_TTL_MS = 5 * 60 * 1000;

export type FactsMap = Record<string, string | number>;

/**
 * Which source answered a facts load. `"fixture"` means the repo-root
 * `_facts.json` stand-in, whose values are explicitly placeholders — callers
 * that are about to make a resolved value PUBLIC (the FAQ seeder's publish
 * guard, src/lib/faq-seed.ts) need to know that, and `getFacts()` alone
 * cannot tell them.
 */
export type FactsSource = "endpoint" | "fixture";

export interface LoadedFacts {
  facts: FactsMap;
  source: FactsSource;
}

let cache: { facts: FactsMap; source: FactsSource; fetchedAtMs: number } | null = null;

/** Thrown by {@link substituteFacts} — "fails loudly" means throw, never blank. */
export class UnknownFactsKeyError extends Error {
  constructor(public readonly keys: string[]) {
    super(`Unknown facts key(s): ${keys.join(", ")}`);
    this.name = "UnknownFactsKeyError";
  }
}

async function fetchFacts(): Promise<FactsMap> {
  const res = await fetch(FACTS_ENDPOINT, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`facts endpoint returned ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) throw new Error("facts endpoint returned a non-object body");
  return body as FactsMap;
}

async function readFactsFixture(): Promise<FactsMap> {
  const raw = await readFile(FACTS_FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as FactsMap;
}

/**
 * Resolved product facts plus the source that answered, cached in-memory for
 * 5 minutes (per the goal's cache directive). Same fetch-first/fixture-fallback
 * behaviour as {@link getFacts}, which delegates here.
 */
export async function loadFacts(nowMs: number = Date.now()): Promise<LoadedFacts> {
  if (cache && nowMs - cache.fetchedAtMs < CACHE_TTL_MS) return { facts: cache.facts, source: cache.source };

  let loaded: LoadedFacts;
  try {
    loaded = { facts: await fetchFacts(), source: "endpoint" };
  } catch {
    loaded = { facts: await readFactsFixture(), source: "fixture" };
  }
  cache = { ...loaded, fetchedAtMs: nowMs };
  return loaded;
}

/** Resolved product facts, cached in-memory for 5 minutes (per the goal's cache directive). */
export async function getFacts(nowMs: number = Date.now()): Promise<FactsMap> {
  return (await loadFacts(nowMs)).facts;
}

/** Test-only: force the next {@link getFacts} call to refetch. */
export function clearFactsCache(): void {
  cache = null;
}

const FACTS_TOKEN = /\{\{\s*facts\.([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Every distinct `{{facts.<key>}}` key referenced by a piece of markdown, in
 * order of first appearance. Shares FACTS_TOKEN with {@link substituteFacts}
 * on purpose: a caller deciding "does this text depend on facts?" must not
 * carry its own copy of the token grammar.
 */
export function factsKeysIn(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(FACTS_TOKEN)].map((m) => m[1]))];
}

/**
 * Replace every {{facts.<key>}} token with its resolved value. Throws
 * UnknownFactsKeyError naming every unresolved key at once, rather than
 * failing on the first one — the caller (route handler / CMS flag) needs the
 * full list to report a useful error.
 */
export function substituteFacts(markdown: string, facts: FactsMap): string {
  const missing = new Set<string>();
  const resolved = markdown.replace(FACTS_TOKEN, (match, key: string) => {
    if (!(key in facts)) {
      missing.add(key);
      return match;
    }
    return String(facts[key]);
  });
  if (missing.size > 0) throw new UnknownFactsKeyError([...missing]);
  return resolved;
}

/**
 * Render a FAQ answer for display. Never returns a silently-blank string on
 * failure — the caller gets either the fully-resolved text or a thrown
 * UnknownFactsKeyError to surface loudly (an API error field, a CMS flag).
 */
export async function renderFaqAnswer(answer: string): Promise<string> {
  const facts = await getFacts();
  return substituteFacts(answer, facts);
}
