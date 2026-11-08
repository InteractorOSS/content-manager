import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Core `/execute` responses for adapter tests, one file per
 * `<service_id>.<capability>` (see README.md for where each came from).
 * Read straight off disk so a fixture is the JSON Core answers with, not a
 * TypeScript literal that drifts into whatever shape the test wanted.
 */
export function coreFixture(name: string): {
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(path.join(__dirname, `${name}.json`), "utf8"));
}
