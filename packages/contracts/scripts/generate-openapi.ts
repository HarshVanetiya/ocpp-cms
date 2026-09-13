/**
 * Generates `openapi.json` from the endpoint registry.
 *
 * Run: npm run contracts:openapi
 *
 * Why bother: paste the output into Swagger UI, Postman, Insomnia or Bruno
 * and you get a clickable version of the whole API to test your backend
 * against. It is also the artefact you show an interviewer when they ask
 * "how did you keep frontend and backend in sync?".
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { allEndpoints, endpointPath, type EndpointDef } from '../src/endpoints';
import { ApiErrorSchema } from '../src/common';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, '../openapi.json');

type JsonSchema = Record<string, unknown>;

const components: Record<string, JsonSchema> = {};

function toJson(schema: z.ZodTypeAny): JsonSchema {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
  }) as JsonSchema;
}

function pathParams(def: EndpointDef) {
  const matches = endpointPath(def).match(/:([A-Za-z0-9_]+)/g) ?? [];
  return matches.map((m) => ({
    name: m.slice(1),
    in: 'path' as const,
    required: true,
    schema: { type: 'string' },
  }));
}

function queryParams(def: EndpointDef) {
  if (!def.query) return [];
  const json = toJson(def.query);
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = (json.required ?? []) as string[];
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: 'query' as const,
    required: required.includes(name),
    schema,
    description: (schema.description as string | undefined) ?? undefined,
  }));
}

const paths: Record<string, Record<string, unknown>> = {};

for (const def of allEndpoints) {
  // OpenAPI wants {id}, our registry uses :id.
  const openapiPath = endpointPath(def).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  paths[openapiPath] ??= {};

  const operation: Record<string, unknown> = {
    operationId: def.id,
    tags: [def.group],
    summary: def.summary,
    description: [
      def.description,
      `**Milestone ${def.milestone}** in the build guide.`,
      def.usedBy.length ? `Used by: ${def.usedBy.join(', ')}.` : undefined,
    ]
      .filter(Boolean)
      .join('\n\n'),
    parameters: [...pathParams(def), ...queryParams(def)],
    responses: {
      [def.method === 'POST' ? '201' : '200']: {
        description: 'Success',
        content: { 'application/json': { schema: toJson(def.response) } },
      },
      '400': {
        description: 'Validation failed',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      ...(def.auth
        ? {
            '401': {
              description: 'Missing or invalid credentials',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
              },
            },
          }
        : {}),
      '404': {
        description: 'Not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
    },
    ...(def.auth ? { security: [{ bearerAuth: [] }] } : { security: [] }),
  };

  if (def.body) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: toJson(def.body) } },
    };
  }

  paths[openapiPath][def.method.toLowerCase()] = operation;
}

components.ApiError = toJson(ApiErrorSchema);

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'OCPP CPMS API',
    version: '1.0.0',
    description:
      'The API your CPMS backend must implement. Every endpoint is tagged with the ' +
      'milestone in `docs/` that introduces it. Implement `GET /api/v1/health` first — ' +
      'the frontend probes it to decide whether to use your backend or its own mocks.',
    license: { name: 'MIT' },
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Core service (you build this)' },
    { url: 'http://localhost:3100', description: 'Simulator service (you build this too)' },
  ],
  tags: [...new Set(allEndpoints.map((d) => d.group))].map((name) => ({ name })),
  paths,
  components: {
    schemas: components,
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(spec, null, 2));

const byMilestone = new Map<number, number>();
for (const d of allEndpoints) byMilestone.set(d.milestone, (byMilestone.get(d.milestone) ?? 0) + 1);

console.log(`Wrote ${outFile}`);
console.log(`${allEndpoints.length} endpoints across ${Object.keys(paths).length} paths`);
console.log('Endpoints per milestone:');
for (const [m, count] of [...byMilestone].sort((a, b) => a[0] - b[0])) {
  console.log(`  M${String(m).padStart(2, '0')}  ${count}`);
}
