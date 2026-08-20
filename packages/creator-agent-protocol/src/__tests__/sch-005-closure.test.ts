import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import {
  createBrokerContractArtifact,
  createJsonSchemaBundle,
  createOpenApiDocument,
} from '../artifacts.js';
import {
  PublicHttpRequestRootNameSchema,
  PublicHttpRequestValidationError,
  SnapshotUploadCreateRequestSchema,
  parsePublicHttpRequestRoot,
  type PublicHttpRequestRootName,
} from '../http.js';
import {
  MODEL_ID_PATTERN_SOURCE,
  UNICODE_SCALAR_NO_CONTROL_OPTIONAL_PATTERN_SOURCE,
  UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE,
  UTF8_TEXT_OPTIONAL_PORTABLE_PATTERN_SOURCE,
  UTF8_TEXT_PORTABLE_PATTERN_SOURCE,
  containsForbiddenControl,
  containsLoneSurrogate,
} from '../primitives.js';
import {
  SnapshotArchiveEnvelopeSchema,
  SnapshotManifestEnvelopeSchema,
  snapshotManifestEnvelopeAadDigest,
  snapshotManifestObjectKey,
} from '../snapshot.js';
import { ProtocolStructuralBoundaryCorpusSchema } from '../structural-boundaries.js';
import { ProtocolUtf8BoundaryCorpusSchema } from '../utf8-boundaries.js';
import { readFixture } from './fixture-helpers.js';

type ArtifactName = 'contract-schemas' | 'broker-contract' | 'openapi';
type PathSegment = string | number;

const utf8CorpusUrl = new URL('../../fixtures/protocol-utf8-boundaries.v1.json', import.meta.url);
const structuralCorpusUrl = new URL(
  '../../fixtures/protocol-structural-boundaries.v1.json',
  import.meta.url,
);
const CANARY = 'SCH005_PUBLIC_STRING_CANARY_';

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function collectStringNodes(
  artifact: ArtifactName,
  value: unknown,
  path: readonly string[] = [],
  output: Array<{ artifact: ArtifactName; pointer: string; node: Record<string, unknown> }> = [],
): typeof output {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectStringNodes(artifact, item, [...path, String(index)], output),
    );
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  const node = value as Record<string, unknown>;
  if (node.type === 'string') {
    output.push({
      artifact,
      pointer: `/${path.map(escapePointerSegment).join('/')}`,
      node,
    });
  }
  for (const [key, item] of Object.entries(node)) {
    collectStringNodes(artifact, item, [...path, key], output);
  }
  return output;
}

function markerPointers(
  artifact: ArtifactName,
  value: unknown,
  marker: 'x-combo-maxUtf8Bytes' | 'x-combo-unicodeCodePoints',
  path: readonly string[] = [],
  output: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      markerPointers(artifact, item, marker, [...path, String(index)], output),
    );
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  const node = value as Record<string, unknown>;
  if (Object.hasOwn(node, marker)) {
    output.push(`${artifact}:/${path.map(escapePointerSegment).join('/')}`);
  }
  for (const [key, item] of Object.entries(node)) {
    markerPointers(artifact, item, marker, [...path, key], output);
  }
  return output;
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  const root = document;
  let current = document;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`SCH005_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`SCH005_POINTER_NOT_OBJECT:${pointer}`);
  }
  const record = current as Record<string, unknown>;
  const reference = record.$ref;
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return record;
  const referencedPointer = reference.startsWith('#/components/')
    ? `/${reference.slice(2)}`
    : `/${[
        ...pointer
          .slice(1)
          .split('/')
          .slice(0, pointer.startsWith('/components/schemas/') ? 3 : 2),
        ...reference.slice(2).split('/'),
      ].join('/')}`;
  const referenced = lookupPointer(root, referencedPointer);
  const { $ref: _reference, ...siblings } = record;
  return { ...referenced, ...siblings };
}

function patternSources(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => patternSources(item, output));
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  const node = value as Record<string, unknown>;
  if (typeof node.pattern === 'string') output.push(node.pattern);
  Object.values(node).forEach((item) => patternSources(item, output));
  return output;
}

function hostileScalarProbes(): Array<{ id: string; value: string; whitespace: boolean }> {
  const controls = [
    ...Array.from({ length: 0x20 }, (_, codeUnit) => codeUnit),
    ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
  ].map((codeUnit) => ({
    id: `control-${codeUnit.toString(16).padStart(2, '0')}`,
    value: `${CANARY}${String.fromCharCode(codeUnit)}`,
    whitespace: codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0d,
  }));
  return [
    ...controls,
    { id: 'high-surrogate', value: `${CANARY}${String.fromCharCode(0xd800)}`, whitespace: false },
    { id: 'low-surrogate', value: `${CANARY}${String.fromCharCode(0xdc00)}`, whitespace: false },
  ];
}

function tokenPatternIsClosed(pattern: string): boolean {
  if (
    !pattern.startsWith('^') ||
    !pattern.endsWith('$') ||
    pattern.includes('\\s') ||
    pattern.includes('[^')
  ) {
    return false;
  }
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '.' && !inClass) return false;
  }
  return !inClass;
}

function replaceAtPath(input: unknown, path: readonly PathSegment[], replacement: string): unknown {
  const clone = structuredClone(input);
  let current = clone;
  for (const segment of path.slice(0, -1)) {
    if (current === null || typeof current !== 'object') throw new Error('SCH005_PATH_INVALID');
    current = (current as Record<PathSegment, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') throw new Error('SCH005_PATH_INVALID');
  (current as Record<PathSegment, unknown>)[path.at(-1)!] = replacement;
  return clone;
}

function withHostileUnknownKey(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('SCH005_ROOT_NOT_OBJECT');
  }
  return { ...(input as Record<string, unknown>), [key]: true };
}

async function snapshotUploadRequest(): Promise<unknown> {
  const archive = SnapshotArchiveEnvelopeSchema.parse(
    await readFixture('snapshot-envelope.v1.json'),
  );
  const manifestFixture = SnapshotManifestEnvelopeSchema.parse(
    await readFixture('snapshot-manifest-envelope.v1.json'),
  );
  const aad = {
    ...manifestFixture.aad,
    creatorId: archive.aad.creatorId,
    snapshotDigest: archive.aad.snapshotDigest,
    objectKey: snapshotManifestObjectKey(archive.aad.creatorId, archive.aad.snapshotDigest),
    keyId: archive.aad.keyId,
  };
  const manifest = SnapshotManifestEnvelopeSchema.parse({
    ...manifestFixture,
    aad,
    aadDigest: snapshotManifestEnvelopeAadDigest(aad),
    wrappedDek: archive.wrappedDek,
  });
  return SnapshotUploadCreateRequestSchema.parse({
    archive: {
      envelope: archive,
      checksumSha256: Buffer.from(archive.cipherDigest, 'hex').toString('base64'),
    },
    manifest: {
      envelope: manifest,
      checksumSha256: Buffer.from(manifest.cipherDigest, 'hex').toString('base64'),
    },
    expandedBytes: 1,
    fileCount: 1,
  });
}

async function publicRequestRoots(): Promise<
  Record<PublicHttpRequestRootName, { base: unknown; strictPath?: readonly PathSegment[] }>
> {
  return {
    SnapshotUploadCreateRequest: {
      base: await snapshotUploadRequest(),
      strictPath: ['archive', 'envelope', 'aad', 'keyId'],
    },
    SnapshotUploadCompleteRequest: { base: {} },
    CreateAgentRequest: {
      base: { name: '研究助手', description: '安全描述。' },
      strictPath: ['name'],
    },
    CreateAgentVersionRequest: {
      base: {
        verifiedSnapshotId: '0198f00d-8000-7000-8000-000000000001',
        manifest: await readFixture('agent-version-manifest.v1.json'),
      },
      strictPath: ['manifest', 'runtimePolicy', 'resolvedModel'],
    },
    DeploymentMutation: {
      base: { desiredState: 'OFFLINE', mode: 'DRAIN' },
      strictPath: ['desiredState'],
    },
    CreateConversationRequest: { base: {} },
    SendConversationMessageRequest: {
      base: {
        clientMessageId: '550e8400-e29b-41d4-a716-446655440000',
        text: '安全消息',
      },
      strictPath: ['clientMessageId'],
    },
    CancelInvocationRequest: { base: {} },
    RetryInvocationRequest: {
      base: { clientMessageId: '550e8400-e29b-41d4-a716-446655440000' },
      strictPath: ['clientMessageId'],
    },
  };
}

describe('SCH-005 public Unicode and sanitized request closure', () => {
  it('classifies every generated public string node and closes helper artifact inventories', async () => {
    const documents = {
      'contract-schemas': createJsonSchemaBundle(),
      'broker-contract': createBrokerContractArtifact(),
      openapi: createOpenApiDocument(),
    } as const satisfies Record<ArtifactName, unknown>;
    const utf8 = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(utf8CorpusUrl, 'utf8')),
    );
    const structural = ProtocolStructuralBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(structuralCorpusUrl, 'utf8')),
    );
    const expectedUtf8Pointers = utf8.boundaries
      .flatMap(({ artifactPointers }) =>
        artifactPointers.map(({ artifact, pointer }) => `${artifact}:${pointer}`),
      )
      .sort();
    const actualUtf8Pointers = Object.entries(documents)
      .flatMap(([artifact, document]) =>
        markerPointers(artifact as ArtifactName, document, 'x-combo-maxUtf8Bytes'),
      )
      .sort();
    expect(actualUtf8Pointers).toEqual(expectedUtf8Pointers);
    const allStringNodes = Object.entries(documents).flatMap(([artifact, document]) =>
      collectStringNodes(artifact as ArtifactName, document),
    );
    const strictUtf8Pointers = new Set(
      utf8.scalarControlParity.strictArtifactPointers.map(
        ({ artifact, pointer }) => `${artifact}:${pointer}`,
      ),
    );
    for (const pointer of actualUtf8Pointers) {
      const separator = pointer.indexOf(':');
      const artifact = pointer.slice(0, separator) as ArtifactName;
      const node = lookupPointer(documents[artifact], pointer.slice(separator + 1));
      const snapshotPath = pointer.endsWith(
        '/SnapshotManifest/properties/files/items/properties/path',
      );
      const snapshotMediaType = pointer.endsWith(
        '/SnapshotManifest/properties/files/items/properties/mediaType',
      );
      const modelId = node.pattern === MODEL_ID_PATTERN_SOURCE;
      if (snapshotMediaType || modelId) {
        expect(tokenPatternIsClosed(String(node.pattern)), pointer).toBe(true);
        if (modelId) expect(node.pattern, pointer).toBe(MODEL_ID_PATTERN_SOURCE);
      } else {
        expect(node.pattern, pointer).toBe(
          strictUtf8Pointers.has(pointer) || snapshotPath
            ? UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE
            : UTF8_TEXT_PORTABLE_PATTERN_SOURCE,
        );
      }
    }

    const expectedStructuralPointers = structural.unicodeBoundaries
      .flatMap(({ artifactPointers }) =>
        artifactPointers.map(({ artifact, pointer }) => {
          const artifactName =
            artifact === 'contractSchemas'
              ? 'contract-schemas'
              : artifact === 'brokerContract'
                ? 'broker-contract'
                : 'openapi';
          return `${artifactName}:${pointer}`;
        }),
      )
      .sort();
    const actualStructuralPointers = Object.entries(documents)
      .flatMap(([artifact, document]) =>
        markerPointers(artifact as ArtifactName, document, 'x-combo-unicodeCodePoints'),
      )
      .sort();
    expect(actualStructuralPointers).toEqual(expectedStructuralPointers);
    const strictStructuralPointers = new Set(
      structural.unicodeScalarParity.strictArtifactPointers.map(({ artifact, pointer }) => {
        const artifactName =
          artifact === 'contractSchemas'
            ? 'contract-schemas'
            : artifact === 'brokerContract'
              ? 'broker-contract'
              : 'openapi';
        return `${artifactName}:${pointer}`;
      }),
    );
    for (const pointer of actualStructuralPointers) {
      const separator = pointer.indexOf(':');
      const artifact = pointer.slice(0, separator) as ArtifactName;
      const localPointer = pointer.slice(separator + 1);
      const node = lookupPointer(documents[artifact], localPointer);
      const minimum = (node['x-combo-unicodeCodePoints'] as { minimum: number }).minimum;
      expect([...new Set(patternSources(node))], pointer).toEqual([
        strictStructuralPointers.has(pointer)
          ? minimum === 0
            ? UNICODE_SCALAR_NO_CONTROL_OPTIONAL_PATTERN_SOURCE
            : UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE
          : minimum === 0
            ? UTF8_TEXT_OPTIONAL_PORTABLE_PATTERN_SOURCE
            : UTF8_TEXT_PORTABLE_PATTERN_SOURCE,
      ]);
    }

    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const probes = hostileScalarProbes();
    expect(probes).toHaveLength(67);
    let classified = 0;
    for (const { artifact, pointer, node } of allStringNodes) {
      const pattern = typeof node.pattern === 'string' ? node.pattern : undefined;
      const enumValues = Array.isArray(node.enum) ? node.enum : undefined;
      const constValue = typeof node.const === 'string' ? node.const : undefined;
      const literalValues = enumValues ?? (constValue === undefined ? undefined : [constValue]);
      const multiline =
        pattern === UTF8_TEXT_PORTABLE_PATTERN_SOURCE ||
        pattern === UTF8_TEXT_OPTIONAL_PORTABLE_PATTERN_SOURCE;
      const strict =
        pattern === UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE ||
        pattern === UNICODE_SCALAR_NO_CONTROL_OPTIONAL_PATTERN_SOURCE;
      if (literalValues !== undefined) {
        expect(literalValues.every((value) => typeof value === 'string')).toBe(true);
        for (const value of literalValues as string[]) {
          expect(containsForbiddenControl(value)).toBe(false);
          expect(containsLoneSurrogate(value)).toBe(false);
        }
      } else {
        expect(pattern, `${artifact}:${pointer}:missing-pattern`).toBeDefined();
        if (!multiline && !strict) {
          expect(tokenPatternIsClosed(pattern!), `${artifact}:${pointer}:${pattern}`).toBe(true);
        }
      }
      const validate = ajv.compile(node as AnySchema);
      for (const probe of probes) {
        const expected = literalValues === undefined && multiline && probe.whitespace;
        expect(validate(probe.value), `${artifact}:${pointer}:${probe.id}`).toBe(expected);
        if (!expected) expect(JSON.stringify(validate.errors)).not.toContain(CANARY);
      }
      classified += 1;
    }
    expect(classified).toBeGreaterThan(0);
  }, 30_000);

  it('sanitizes the complete 9-root public HTTP schema matrix without claiming route effects', async () => {
    const roots = await publicRequestRoots();
    expect(Object.keys(roots)).toEqual(PublicHttpRequestRootNameSchema.options);
    const probes = hostileScalarProbes();
    let outcomes = 0;

    for (const root of PublicHttpRequestRootNameSchema.options) {
      const owner = roots[root];
      expect(() => parsePublicHttpRequestRoot(root, owner.base), `baseline:${root}`).not.toThrow();
      for (const probe of probes) {
        const canary = `${root}_${probe.id}_${probe.value}`;
        const candidate =
          owner.strictPath === undefined
            ? withHostileUnknownKey(owner.base, canary)
            : replaceAtPath(owner.base, owner.strictPath, canary);
        let error: unknown;
        try {
          parsePublicHttpRequestRoot(root, candidate);
        } catch (caught) {
          error = caught;
        }
        expect(error, `${root}:${probe.id}`).toBeInstanceOf(PublicHttpRequestValidationError);
        expect(error, `${root}:${probe.id}`).toMatchObject({
          name: 'PublicHttpRequestValidationError',
          code: 'PUBLIC_HTTP_REQUEST_INVALID',
          message: 'PUBLIC_HTTP_REQUEST_INVALID',
        });
        expect(error, `${root}:${probe.id}`).not.toHaveProperty('cause');
        expect(error, `${root}:${probe.id}`).not.toHaveProperty('issues');
        expect(error, `${root}:${probe.id}`).not.toHaveProperty('input');
        expect(`${String(error)} ${JSON.stringify(error)}`, `${root}:${probe.id}`).not.toContain(
          CANARY,
        );
        outcomes += 1;
      }
    }

    expect(outcomes).toBe(9 * 67);
  }, 30_000);
});
