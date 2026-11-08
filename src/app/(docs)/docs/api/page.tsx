import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "../_components/code-block";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ENDPOINTS,
  type DocEndpoint,
  type DocParam,
  type DocResponse,
} from "@/lib/api-docs/spec";

export const metadata: Metadata = {
  title: { absolute: "REST API Reference | Interactor CMS Docs" },
  description:
    "The full REST API reference for the Interactor CMS — every documented endpoint, grouped by resource, rendered from the same source as the OpenAPI document.",
};

const METHOD_VARIANT: Record<DocEndpoint["method"], "info" | "success" | "warning" | "destructive"> = {
  GET: "info",
  POST: "success",
  PUT: "warning",
  PATCH: "warning",
  DELETE: "destructive",
};

const AUTH_LABEL: Record<DocEndpoint["auth"], string> = {
  public: "No credential required",
  "pat-or-session": "Personal access token or session",
  "session-only": "Session only — no bearer token accepted",
};

// Groups endpoints by their `group` field, preserving first-appearance order
// in ENDPOINTS — never re-sorted or re-labeled here, so this can't drift from
// how spec.ts itself organizes the surface.
function groupEndpoints(endpoints: DocEndpoint[]): { group: string; endpoints: DocEndpoint[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, DocEndpoint[]>();
  for (const endpoint of endpoints) {
    if (!byGroup.has(endpoint.group)) {
      byGroup.set(endpoint.group, []);
      order.push(endpoint.group);
    }
    byGroup.get(endpoint.group)!.push(endpoint);
  }
  return order.map((group) => ({ group, endpoints: byGroup.get(group)! }));
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function groupAnchor(group: string): string {
  return slugify(group);
}

// Normalizes the METHOD+PATH pair as a single string before slugifying — doing
// it in two separate slugify() calls and concatenating (the original bug)
// left a raw "-" at the join whenever the path starts with "/", plus a
// trailing "-" whenever it ends in a "{param}", since each half was trimmed
// independently and the boundary between them never was.
export function endpointAnchor(endpoint: DocEndpoint): string {
  return slugify(`${endpoint.method}-${endpoint.path}`);
}

function statusVariant(status: number): "success" | "warning" | "destructive" {
  if (status < 300) return "success";
  if (status < 500) return "warning";
  return "destructive";
}

function ParamsTable({ title, params }: { title: string; params: DocParam[] }) {
  if (params.length === 0) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {params.map((p) => (
              <TableRow key={p.name}>
                <TableCell className="align-top font-mono text-xs text-foreground">
                  {p.name}
                  {p.required && <span className="text-destructive">*</span>}
                </TableCell>
                <TableCell className="align-top text-xs text-muted-foreground">{p.type}</TableCell>
                <TableCell className="align-top text-xs text-muted-foreground">{p.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ResponseItem({ response }: { response: DocResponse }) {
  return (
    <li className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge variant={statusVariant(response.status)}>{response.status}</Badge>
        <span className="text-sm text-muted-foreground">{response.description}</span>
      </div>
      {response.example !== undefined && (
        <CodeBlock>{JSON.stringify(response.example, null, 2)}</CodeBlock>
      )}
      {response.example === undefined && response.schema !== undefined && (
        <CodeBlock>{JSON.stringify(response.schema, null, 2)}</CodeBlock>
      )}
    </li>
  );
}

function EndpointCard({ endpoint }: { endpoint: DocEndpoint }) {
  return (
    <details id={endpointAnchor(endpoint)} className="scroll-mt-20 rounded-lg border p-4 open:pb-5">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3">
        <Badge variant={METHOD_VARIANT[endpoint.method]}>{endpoint.method}</Badge>
        <span className="font-mono text-sm text-foreground">{endpoint.path}</span>
        <span className="text-sm text-muted-foreground">{endpoint.summary}</span>
      </summary>
      <div className="mt-4 space-y-4">
        {endpoint.description && (
          <p className="text-sm text-muted-foreground">{endpoint.description}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{AUTH_LABEL[endpoint.auth]}</Badge>
          {endpoint.permission && <Badge variant="outline">Requires {endpoint.permission}</Badge>}
        </div>

        <ParamsTable title="Path parameters" params={endpoint.pathParams ?? []} />
        <ParamsTable title="Query parameters" params={endpoint.queryParams ?? []} />

        {endpoint.body && (
          <div className="space-y-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Request body schema{endpoint.bodyContentType ? ` (${endpoint.bodyContentType})` : ""}
            </h4>
            <p className="text-xs text-muted-foreground">
              JSON Schema, not a literal payload — see the examples below for a real request body.
            </p>
            <CodeBlock>{JSON.stringify(endpoint.body, null, 2)}</CodeBlock>
          </div>
        )}

        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Responses</h4>
          <ul className="space-y-3">
            {endpoint.responses.map((r, i) => (
              <ResponseItem key={`${r.status}-${i}`} response={r} />
            ))}
          </ul>
        </div>

        {endpoint.examples.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Examples</h4>
            {endpoint.examples.map((ex) => (
              <div key={ex.title} className="space-y-1.5">
                <p className="text-sm text-foreground">{ex.title}</p>
                <CodeBlock>{ex.curl}</CodeBlock>
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(ex.response.status)}>{ex.response.status}</Badge>
                </div>
                {ex.response.body !== undefined && (
                  <CodeBlock>
                    {typeof ex.response.body === "string"
                      ? ex.response.body
                      : JSON.stringify(ex.response.body, null, 2)}
                  </CodeBlock>
                )}
                {ex.response.note && <p className="text-xs text-muted-foreground">{ex.response.note}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

export default function DocsApiPage() {
  const groups = groupEndpoints(ENDPOINTS);

  return (
    <article className="space-y-10">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold text-foreground">REST API reference</h1>
        <p className="text-muted-foreground">
          Every documented endpoint, grouped by resource. Each entry below is rendered directly
          from the same source that generates the machine-readable version — nothing here is
          typed twice.
        </p>
        <p className="text-sm text-muted-foreground">
          Prefer a machine-readable format?{" "}
          <a href="/api/public/openapi.json" className="underline">
            GET /api/public/openapi.json
          </a>{" "}
          is the OpenAPI 3.1 document generated from this same reference. See{" "}
          <Link href="/docs/auth" className="underline">
            Authentication & permissions
          </Link>{" "}
          for how to get a token.
        </p>
      </div>

      <nav className="space-y-2 rounded-lg border p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Resources
        </h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {groups.map(({ group }) => (
            <a key={group} href={`#${groupAnchor(group)}`} className="underline">
              {group}
            </a>
          ))}
        </div>
      </nav>

      {groups.map(({ group, endpoints }) => (
        <section key={group} id={groupAnchor(group)} className="scroll-mt-20 space-y-4">
          <h2 className="text-xl font-semibold text-foreground border-b pb-2">{group}</h2>
          <div className="space-y-3">
            {endpoints.map((endpoint) => (
              <EndpointCard key={`${endpoint.method}-${endpoint.path}`} endpoint={endpoint} />
            ))}
          </div>
        </section>
      ))}
    </article>
  );
}
