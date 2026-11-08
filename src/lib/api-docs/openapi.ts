// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Generates the OpenAPI 3.1 document served at `GET /api/public/openapi.json`
 * (G#22 D2) from `ENDPOINTS` in `spec.ts` — never hand-maintained. Every
 * endpoint fact lives in `spec.ts`; this module is a pure, mechanical
 * translation of that shape into the OpenAPI shape.
 */

import { ENDPOINTS, type DocEndpoint, type DocParam, type DocResponse, type DocSchema } from "./spec";

const OPENAPI_VERSION = "3.1.0";
const API_VERSION = "1.0.0";

function paramObject(param: DocParam, location: "query" | "path") {
  return {
    name: param.name,
    in: location,
    required: location === "path" ? true : param.required ?? false,
    description: param.description,
    schema: { type: param.type },
    ...(param.example !== undefined && { example: param.example }),
  };
}

/**
 * Two `DocResponse` entries can legitimately share one HTTP status (e.g. a
 * 409 for a slug collision AND a separate 409 for a stale optimistic-
 * concurrency token) — merge them into one OpenAPI response object instead
 * of letting the second silently overwrite the first. A single scenario
 * keeps the plain `example` field; multiple scenarios move to OpenAPI's
 * `examples` (plural, named) so none of them are lost.
 */
interface ExampleEntry {
  key: string;
  description: string;
  value: unknown;
}

function mergedResponseObject(status: number, group: DocResponse[]) {
  const description = group.map((r) => r.description).join(" — OR — ");
  const schema = group.find((r) => r.schema)?.schema;
  const examples = group
    .map((r, i): ExampleEntry | null =>
      r.example !== undefined ? { key: `scenario${i + 1}`, description: r.description, value: r.example } : null
    )
    .filter((e): e is ExampleEntry => e !== null);

  const exampleField =
    examples.length === 1
      ? { example: examples[0].value }
      : examples.length > 1
        ? { examples: Object.fromEntries(examples.map((e) => [e.key, { summary: e.description, value: e.value }])) }
        : {};

  return {
    description,
    ...(schema || examples.length > 0
      ? { content: { "application/json": { ...(schema && { schema }), ...exampleField } } }
      : {}),
  };
}

function operationObject(endpoint: DocEndpoint) {
  const parameters = [
    ...(endpoint.pathParams ?? []).map((p) => paramObject(p, "path")),
    ...(endpoint.queryParams ?? []).map((p) => paramObject(p, "query")),
  ];

  const byStatus = new Map<number, DocResponse[]>();
  for (const response of endpoint.responses) {
    const group = byStatus.get(response.status) ?? [];
    group.push(response);
    byStatus.set(response.status, group);
  }
  const responses: Record<string, unknown> = {};
  for (const [status, group] of byStatus) {
    responses[String(status)] = mergedResponseObject(status, group);
  }

  return {
    summary: endpoint.summary,
    description: endpoint.description,
    tags: [endpoint.group],
    ...(parameters.length > 0 && { parameters }),
    ...(endpoint.body && {
      requestBody: {
        required: true,
        content: { [endpoint.bodyContentType ?? "application/json"]: { schema: endpoint.body as DocSchema } },
      },
    }),
    responses,
    // "public" needs no credential. "session-only" refuses a bearer PAT
    // outright (see each such endpoint's own description), so — since D2
    // declares exactly two schemes (bearer PAT, or none) — offering
    // bearerAuth here would be a false claim that a valid token works;
    // leaving security empty is the less-wrong of the two options this
    // model can express. Everything else accepts the bearer PAT.
    security: endpoint.auth === "public" || endpoint.auth === "session-only" ? [] : [{ bearerAuth: [] }],
  };
}

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of ENDPOINTS) {
    paths[endpoint.path] ??= {};
    paths[endpoint.path][endpoint.method.toLowerCase()] = operationObject(endpoint);
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "Interactor CMS API",
      version: API_VERSION,
      description:
        "The public read API, the authenticated content-management API, the automation intake API, identity, and the MCP server for the Interactor CMS. See CLAUDE.md in the content-manager repo for the full auth model.",
    },
    servers: [{ url: "https://cms.interactor.com" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "cms_pat",
          description: "A personal access token from /settings/tokens, sent as `Authorization: Bearer cms_pat_...`.",
        },
      },
    },
  };
}
