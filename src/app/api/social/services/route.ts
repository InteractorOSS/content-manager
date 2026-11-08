import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { serviceExists } from "@/lib/interactor";
import {
  SERVICE_ADAPTERS,
  needsAccountIdUpfront,
  networkRules,
} from "@/lib/social/capabilities";

/** Connectable social services: our publish adapters cross-checked against
 * live Service Knowledge Base availability. Also IS the network-rules
 * listing (char_limit / requires_account_id / requires_media / media_limits)
 * that get_social_network_rules (MCP, G#26) reports — built from
 * `networkRules()` so this route and that function can't report different
 * rules. */
export async function GET(req: NextRequest) {
  const { error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const adapters = Object.values(SERVICE_ADAPTERS);
  const rules = new Map(networkRules().map((r) => [r.service_id, r]));

  // One exact-slug lookup per adapter. A lookup that fails for any reason
  // other than "not found" leaves that service marked available: Core being
  // unreachable must not empty the connect dialog.
  const available = await Promise.all(
    adapters.map((a) => serviceExists(a.serviceId).catch(() => true))
  );

  const services = adapters.map((a, i) => ({
    ...rules.get(a.serviceId),
    // The id is filled in after connecting (a Page picked from the account's
    // own list) rather than typed beforehand.
    account_id_upfront: needsAccountIdUpfront(a),
    // What to do when the connection can reach no account at all.
    no_accounts_help: a.noAccountsHelp ?? null,
    available: available[i],
  }));

  return NextResponse.json({ data: services });
}
