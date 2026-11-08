"use client";

import { useState } from "react";
import { ShieldCheck, UserPlus } from "lucide-react";
import type { AuthorizeParams } from "@/lib/oauth/authorize";

interface OrgOption {
  id: string;
  name: string;
  role: string;
  sites: { slug: string; name: string }[];
}

export function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500 mb-4 shadow-lg">
            <span className="text-white font-bold text-2xl">I</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Interactor CMS</h1>
        </div>
        <div className="rounded-2xl border border-slate-700 bg-slate-800/60 p-6 shadow-xl">
          {children}
        </div>
      </div>
    </div>
  );
}

const FIELD =
  "w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400";

export function ConsentForm({
  accounts,
  clientName,
  redirectHost,
  userEmail,
  organizations,
  defaultOrganizationId,
  params,
}: {
  /** Accounts on this connection so far; the last approved is `current`. */
  accounts: { email: string; current: boolean; kept?: boolean }[];
  clientName: string;
  redirectHost: string;
  userEmail: string;
  organizations: OrgOption[];
  defaultOrganizationId: string;
  params: AuthorizeParams;
}) {
  // "All my organizations" (a workspace connection: each request, or each
  // folder in the Interactor CMS plugin, names where it acts) or one.
  // With more than one account already added, only "all" makes sense.
  const [reach, setReach] = useState<"all" | "one">("all");
  const multiAccount = accounts.length > 1;
  const [orgId, setOrgId] = useState(defaultOrganizationId);
  const [limitSites, setLimitSites] = useState(false);
  const [sites, setSites] = useState<string[]>([]);
  const org = organizations.find((o) => o.id === orgId) ?? organizations[0];
  const noSiteChosen = limitSites && sites.length === 0;

  return (
    <form method="POST" action="/api/oauth/authorize" className="space-y-5">
      {Object.entries(params).map(([name, value]) =>
        value === null ? null : <input key={name} type="hidden" name={name} value={value} />
      )}
      <input type="hidden" name="reach" value={multiAccount ? "all" : reach} />
      <input type="hidden" name="organization_id" value={org.id} />
      {reach === "one" && limitSites && sites.map((s) => <input key={s} type="hidden" name="site" value={s} />)}

      <div className="flex gap-3">
        <ShieldCheck className="h-6 w-6 shrink-0 text-blue-400" aria-hidden />
        <div>
          <h2 className="text-lg font-semibold text-white">Connect {clientName}</h2>
          <p className="mt-1 text-sm text-slate-300">
            <span className="font-medium text-white">{clientName}</span> wants to manage content in
            Interactor CMS as <span className="font-medium text-white">{multiAccount ? accounts.map((a) => a.email).join(" and ") : userEmail}</span>. It will
            be able to do whatever your role allows: read, draft and edit posts and FAQs, upload
            media, and publish if your role permits it.
          </p>
        </div>
      </div>

      {!multiAccount && (
        <div className="space-y-2" role="radiogroup" aria-label="What it can reach">
          <label className="flex gap-2 text-sm text-slate-200">
            <input
              type="radio"
              name="reach_choice"
              checked={reach === "all"}
              onChange={() => setReach("all")}
              className="mt-0.5 h-4 w-4 accent-blue-500"
            />
            <span>
              <span className="font-medium text-white">All my organizations</span>
              <span className="block text-xs text-slate-400">
                Each folder (or each request) picks the organization and site it works in. Best for the Interactor
                Writing plugin.
              </span>
            </span>
          </label>
          <label className="flex gap-2 text-sm text-slate-200">
            <input
              type="radio"
              name="reach_choice"
              checked={reach === "one"}
              onChange={() => setReach("one")}
              className="mt-0.5 h-4 w-4 accent-blue-500"
            />
            <span>
              <span className="font-medium text-white">One organization</span>
              <span className="block text-xs text-slate-400">Fixed to the organization (and sites) you pick below.</span>
            </span>
          </label>
        </div>
      )}

      {(reach === "all" || multiAccount) && (
        <div className="space-y-2 rounded-lg border border-slate-700 p-3">
          <p className="text-sm font-medium text-slate-200">Accounts on this connection</p>
          <ul className="space-y-1 text-sm text-slate-300">
            {accounts.map((a) => (
              <li key={a.email}>
                {a.email}
                {a.current && <span className="text-slate-500"> (signed in now)</span>}
                {a.kept && <span className="text-slate-500"> (already connected, stays on)</span>}
              </li>
            ))}
          </ul>
          <button
            type="submit"
            name="decision"
            value="add_account"
            className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300"
          >
            <UserPlus className="h-4 w-4" aria-hidden /> Add another account
          </button>
          <p className="text-xs text-slate-400">
            You&apos;ll sign in as the other account, then come back here. The connection covers every organization
            each account belongs to.
          </p>
        </div>
      )}

      {reach === "one" && !multiAccount && (
        <>
      {organizations.length > 1 ? (
        <div className="space-y-1.5">
          <label htmlFor="org" className="text-sm font-medium text-slate-200">
            Organization
          </label>
          <select
            id="org"
            className={FIELD}
            value={org.id}
            onChange={(e) => {
              setOrgId(e.target.value);
              setSites([]);
            }}
          >
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.role})
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-400">
            This connection will act on this organization only.
          </p>
        </div>
      ) : (
        <p className="text-sm text-slate-300">
          Organization: <span className="font-medium text-white">{org.name}</span> ({org.role})
        </p>
      )}

      {org.sites.length > 1 && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={limitSites}
              onChange={(e) => setLimitSites(e.target.checked)}
              className="h-4 w-4 accent-blue-500"
            />
            Only allow some sites
          </label>
          {limitSites && (
            <div className="ml-6 space-y-1.5">
              {org.sites.map((s) => (
                <label key={s.slug} className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={sites.includes(s.slug)}
                    onChange={(e) =>
                      setSites((cur) =>
                        e.target.checked ? [...cur, s.slug] : cur.filter((x) => x !== s.slug)
                      )
                    }
                    className="h-4 w-4 accent-blue-500"
                  />
                  {s.name} <span className="text-slate-500">({s.slug})</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

        </>
      )}

      <p className="text-xs text-slate-400">
        You&apos;ll be sent back to <span className="font-mono text-slate-300">{redirectHost}</span>.
        You can disconnect it any time from the API Tokens page in the CMS.
      </p>

      <div className="flex gap-3">
        <button
          type="submit"
          name="decision"
          value="deny"
          className="flex-1 min-h-11 rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-700"
        >
          Cancel
        </button>
        <button
          type="submit"
          name="decision"
          value="allow"
          disabled={reach === "one" && noSiteChosen}
          className="flex-1 min-h-11 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Allow
        </button>
      </div>
    </form>
  );
}
