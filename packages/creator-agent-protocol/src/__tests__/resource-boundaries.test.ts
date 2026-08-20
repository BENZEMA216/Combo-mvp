import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import { AgentVersionManifestSchema } from '../agent-version.js';
import { CreateAgentVersionRequestSchema } from '../http.js';
import { AgentVersionResourceBoundaryCorpusSchema } from '../resource-boundaries.js';

const corpusUrl = new URL(
  '../../fixtures/agent-version-resource-boundaries.v1.json',
  import.meta.url,
);
const corpusFixturePath = 'agent-version-resource-boundaries.v1.json';
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const fixtureIndexUrl = new URL('../../fixtures/index.json', import.meta.url);
const artifactUrls = {
  contractSchemas: new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  openApi: new URL('../../openapi/creator-agent-v1.openapi.json', import.meta.url),
} as const;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  let current = document;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`AGENT_VERSION_RESOURCE_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`AGENT_VERSION_RESOURCE_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
}

function replacePointer(document: unknown, pointer: string, replacement: unknown): unknown {
  const clone = structuredClone(document);
  const segments = pointerSegments(pointer);
  let current = clone;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`AGENT_VERSION_RESOURCE_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`AGENT_VERSION_RESOURCE_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  (current as Record<string, unknown>)[segments.at(-1)!] = replacement;
  return clone;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function collectVariableResourcePointers(
  document: unknown,
  rootPointer: string,
  excludedRelativePointers: ReadonlySet<string>,
): string[] {
  const root = lookupPointer(document, rootPointer);
  const output: string[] = [];
  const visit = (value: unknown, relativePath: readonly string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...relativePath, String(index)]));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const relativePointer = `/${relativePath
      .filter((segment) => segment !== 'properties')
      .map(escapePointerSegment)
      .join('/')}`;
    if (
      (Object.hasOwn(record, 'maxItems') || Object.hasOwn(record, 'maximum')) &&
      !excludedRelativePointers.has(relativePointer)
    ) {
      output.push(
        `${rootPointer}/${relativePath.map(escapePointerSegment).join('/')}`.replace(/\/$/u, ''),
      );
    }
    for (const [key, item] of Object.entries(record)) {
      visit(item, [...relativePath, key]);
    }
  };
  visit(root, []);
  return output;
}

describe('digest-bound AgentVersion resource boundaries', () => {
  it('pins one real base fixture and every advertised keyword path for exactly four cases', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = AgentVersionResourceBoundaryCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')),
    );
    expect(corpus.cases).toHaveLength(4);
    expect(corpus.cases.map(({ id }) => id)).toEqual([
      'behavior-contract-developer-instructions',
      'runtime-policy-max-turn-seconds',
      'runtime-policy-max-conversation-turns',
      'runtime-policy-max-visible-history-bytes',
    ]);
    expect(corpus.excludedLiteralFields).toEqual([
      '/runtimePolicy/contextTools',
      '/runtimePolicy/maxActiveTurns',
      '/ioContract/input/maxUtf8Bytes',
      '/ioContract/output/maxUtf8Bytes',
    ]);

    const baseBytes = await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl));
    expect(sha256(baseBytes)).toBe(corpus.baseFixture.digest);
    expect(
      AgentVersionManifestSchema.safeParse(JSON.parse(baseBytes.toString('utf8'))).success,
    ).toBe(true);
    const fixtureIndex = JSON.parse(await readFile(fixtureIndexUrl, 'utf8')) as {
      fixtures: Array<{ path: string; bytes: number; digest: string }>;
    };
    expect(fixtureIndex.fixtures.find(({ path }) => path === corpusFixturePath)).toEqual({
      path: corpusFixturePath,
      bytes: corpusBytes.byteLength,
      digest: sha256(corpusBytes),
    });
    expect(fixtureIndex.fixtures.find(({ path }) => path === corpus.baseFixture.path)).toEqual({
      path: corpus.baseFixture.path,
      bytes: baseBytes.byteLength,
      digest: corpus.baseFixture.digest,
    });

    const documents = {
      contractSchemas: JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as unknown,
      openApi: JSON.parse(await readFile(artifactUrls.openApi, 'utf8')) as unknown,
    };
    expect(corpus.checkedArtifactDigests).toEqual({
      contractSchemas: sha256(await readFile(artifactUrls.contractSchemas)),
      openApi: sha256(await readFile(artifactUrls.openApi)),
    });

    for (const boundary of corpus.cases) {
      const nodes = [
        lookupPointer(
          documents.contractSchemas,
          boundary.artifactPointers.contractAgentVersionManifest,
        ),
        lookupPointer(
          documents.contractSchemas,
          boundary.artifactPointers.contractCreateAgentVersionRequest,
        ),
        lookupPointer(
          documents.openApi,
          boundary.artifactPointers.openApiCreateAgentVersionRequest,
        ),
      ];
      for (const node of nodes) {
        expect(node[boundary.jsonSchemaKeyword], boundary.id).toBe(boundary.maximum);
      }
    }

    const expectedPointers = corpus.cases
      .flatMap(({ artifactPointers }) => Object.values(artifactPointers))
      .sort();
    const excluded = new Set(corpus.excludedLiteralFields);
    const actualPointers = [
      ...collectVariableResourcePointers(
        documents.contractSchemas,
        '/schemas/AgentVersionManifest/definitions/AgentVersionManifest',
        excluded,
      ),
      ...collectVariableResourcePointers(
        documents.contractSchemas,
        '/schemas/CreateAgentVersionRequest/definitions/CreateAgentVersionRequest/properties/manifest',
        excluded,
      ),
      ...collectVariableResourcePointers(
        documents.openApi,
        '/components/schemas/CreateAgentVersionRequest/properties/manifest',
        excluded,
      ),
    ].sort();
    expect(actualPointers).toEqual(expectedPointers);
  });

  it('runs each N-1/N/N+1 clone through both runtime owners and all advertised schemas', async () => {
    const corpus = AgentVersionResourceBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const baseBytes = await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl));
    expect(sha256(baseBytes)).toBe(corpus.baseFixture.digest);
    const baseManifest = AgentVersionManifestSchema.parse(JSON.parse(baseBytes.toString('utf8')));
    const contractSchemas = JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const openApi = JSON.parse(await readFile(artifactUrls.openApi, 'utf8')) as {
      components: { schemas: Record<string, AnySchema> };
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validateContractManifest = ajv.compile(contractSchemas.schemas.AgentVersionManifest!);
    const validateContractRequest = ajv.compile(contractSchemas.schemas.CreateAgentVersionRequest!);
    const validateOpenApiRequest = ajv.compile(
      openApi.components.schemas.CreateAgentVersionRequest!,
    );

    for (const boundary of corpus.cases) {
      for (const delta of [-1, 0, 1] as const) {
        const size = boundary.maximum + delta;
        const replacement =
          boundary.valueKind === 'array-cardinality'
            ? Array.from({ length: size }, (_, index) => `instruction-${index + 1}`)
            : size;
        const manifest = replacePointer(baseManifest, boundary.manifestInstancePath, replacement);
        const request = {
          verifiedSnapshotId: corpus.verifiedSnapshotId,
          manifest,
        };
        const expected = delta <= 0;
        const label = `${boundary.id}:${delta}`;

        const manifestRuntime = AgentVersionManifestSchema.safeParse(manifest);
        const requestRuntime = CreateAgentVersionRequestSchema.safeParse(request);
        expect(manifestRuntime.success, `runtime-manifest:${label}`).toBe(expected);
        expect(requestRuntime.success, `runtime-request:${label}`).toBe(expected);

        const advertised = [
          {
            name: 'contract-manifest',
            validate: validateContractManifest,
            value: manifest,
            instancePath: boundary.manifestInstancePath,
          },
          {
            name: 'contract-request',
            validate: validateContractRequest,
            value: request,
            instancePath: boundary.requestInstancePath,
          },
          {
            name: 'openapi-request',
            validate: validateOpenApiRequest,
            value: request,
            instancePath: boundary.requestInstancePath,
          },
        ];
        for (const validator of advertised) {
          expect(validator.validate(validator.value), `${validator.name}:${label}`).toBe(expected);
          if (!expected) {
            expect(validator.validate.errors, `${validator.name}:${label}`).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  instancePath: validator.instancePath,
                  keyword: boundary.jsonSchemaKeyword,
                }),
              ]),
            );
          }
        }

        if (!expected) {
          const manifestPath = pointerSegments(boundary.manifestInstancePath);
          const requestPath = pointerSegments(boundary.requestInstancePath);
          if (manifestRuntime.success || requestRuntime.success) {
            throw new Error(`AGENT_VERSION_RESOURCE_BOUNDARY_RUNTIME_ACCEPTED:${label}`);
          }
          expect(manifestRuntime.error.issues, `runtime-manifest:${label}`).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: 'too_big',
                maximum: boundary.maximum,
                path: manifestPath,
              }),
            ]),
          );
          expect(requestRuntime.error.issues, `runtime-request:${label}`).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: 'too_big',
                maximum: boundary.maximum,
                path: requestPath,
              }),
            ]),
          );
        }
      }
    }
  });
});
