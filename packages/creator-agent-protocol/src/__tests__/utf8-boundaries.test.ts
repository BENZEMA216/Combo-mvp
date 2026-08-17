import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import {
  AgentVersionManifestSchema,
  BehaviorContractSchema,
  ModelPolicySchema,
  RuntimePolicySchema,
} from '../agent-version.js';
import {
  BrokerEventSchema,
  BrokerHandshakeUnsignedSchema,
  ExecutionCapabilityUnsignedSchema,
} from '../broker.js';
import {
  AgentViewSchema,
  ConsumerEventSchema,
  ConsumerMessageSchema,
  CreateAgentRequestSchema,
  SendConversationMessageRequestSchema,
  SnapshotArchiveSignedPutTargetSchema,
  SnapshotManifestSignedPutTargetSchema,
  SnapshotUploadCreateResponseSchema,
} from '../http.js';
import {
  UNICODE_SCALAR_NO_CONTROL_PATTERN,
  UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE,
  UTF8_TEXT_PORTABLE_PATTERN,
  UTF8_TEXT_PORTABLE_PATTERN_SOURCE,
  Utf8TextSchema,
} from '../primitives.js';
import { SandboxAttestationUnsignedSchema, SandboxSpecSchema } from '../sandbox.js';
import { SnapshotManifestSchema } from '../snapshot.js';
import { ProtocolUtf8BoundaryCorpusSchema } from '../utf8-boundaries.js';

type CheckedArtifactName = 'contract-schemas' | 'broker-contract' | 'openapi';

const fixtureUrl = new URL('../../fixtures/protocol-utf8-boundaries.v1.json', import.meta.url);
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const artifactUrls = {
  'contract-schemas': new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  'broker-contract': new URL('../../schemas/broker-contract.v1.json', import.meta.url),
  openapi: new URL('../../openapi/creator-agent-v1.openapi.json', import.meta.url),
} as const satisfies Record<CheckedArtifactName, URL>;
const UTF8_BYTE_BOUNDARY_CANARY = 'UTF8_BYTE_BOUNDARY_CANARY_';

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function exactUtf8Bytes(targetBytes: number, generator: 'ascii' | 'cjk' | 'emoji'): string {
  const symbol = generator === 'ascii' ? 'a' : generator === 'cjk' ? '界' : '😀';
  const symbolBytes = Buffer.byteLength(symbol, 'utf8');
  const repeats = Math.floor(targetBytes / symbolBytes);
  return symbol.repeat(repeats) + 'a'.repeat(targetBytes - repeats * symbolBytes);
}

function exactUtf8BytesWithCanary(
  targetBytes: number,
  generator: 'ascii' | 'cjk' | 'emoji',
): string {
  const canaryBytes = Buffer.byteLength(UTF8_BYTE_BOUNDARY_CANARY, 'utf8');
  if (targetBytes < canaryBytes) {
    throw new Error(`UTF8_BYTE_BOUNDARY_TARGET_TOO_SMALL:${targetBytes}`);
  }
  return UTF8_BYTE_BOUNDARY_CANARY + exactUtf8Bytes(targetBytes - canaryBytes, generator);
}

function pointerIssuePath(pointer: string): string {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('/');
}

function hasRuntimeByteBoundaryIssue(
  issues: readonly unknown[],
  pointer: string,
  maxBytes: number,
): boolean {
  return issues.some((issue) => {
    if (issue === null || typeof issue !== 'object') return false;
    const candidate = issue as { code?: unknown; message?: unknown; path?: unknown };
    return (
      candidate.code === 'custom' &&
      candidate.message === `UTF-8 内容不得超过 ${maxBytes} bytes` &&
      Array.isArray(candidate.path) &&
      candidate.path.map(String).join('/') === pointerIssuePath(pointer)
    );
  });
}

function signedPutTarget(kind: 'archive' | 'manifest', putUrl: string): unknown {
  const cipherDigest = 'a'.repeat(64);
  const cipherBytes = 73;
  return {
    method: 'PUT',
    putUrl,
    cipherBytes,
    cipherDigest,
    requiredHeaders: {
      'cache-control': 'no-store',
      'content-length': String(cipherBytes),
      'content-type': 'application/octet-stream',
      'if-none-match': '*',
      'x-amz-checksum-sha256': Buffer.from(cipherDigest, 'hex').toString('base64'),
      'x-amz-meta-archive-digest': 'b'.repeat(64),
      'x-amz-meta-cipher-bytes': String(cipherBytes),
      'x-amz-meta-cipher-digest': cipherDigest,
      'x-amz-meta-object-kind': kind,
      'x-amz-meta-object-state': 'upload',
      'x-amz-meta-protocol': 'combo.snapshot-object-storage/1',
      'x-amz-meta-snapshot-digest': 'c'.repeat(64),
    },
  };
}

function signedPutResponse(): unknown {
  return {
    protocol: 'combo.creator-agent-http/1',
    uploadId: '0198f00d-8000-7000-8000-000000000011',
    state: 'CREATED',
    uploads: {
      archive: signedPutTarget('archive', 'https://uploads.example.invalid/archive'),
      manifest: signedPutTarget('manifest', 'https://uploads.example.invalid/manifest'),
    },
    expiresAt: '2026-08-13T08:15:00.000Z',
  };
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function collectUtf8Pointers(
  artifact: CheckedArtifactName,
  value: unknown,
  path: readonly string[] = [],
  output: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectUtf8Pointers(artifact, item, [...path, String(index)], output),
    );
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'x-combo-maxUtf8Bytes')) {
    output.push(`${artifact}:/${path.map(escapePointerSegment).join('/')}`);
  }
  for (const [key, item] of Object.entries(record)) {
    collectUtf8Pointers(artifact, item, [...path, key], output);
  }
  return output;
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  let current = document;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`UTF8_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`UTF8_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
}

function replacePointer(document: unknown, pointer: string, value: string): unknown {
  const clone = structuredClone(document) as unknown;
  const segments = pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current = clone;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`UTF8_RUNTIME_OWNER_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  const final = segments.at(-1);
  if (final === undefined || current === null || typeof current !== 'object') {
    throw new Error(`UTF8_RUNTIME_OWNER_POINTER_INVALID:${pointer}`);
  }
  (current as Record<string, unknown>)[final] = value;
  return clone;
}

type RuntimeSchema = Readonly<{
  safeParse(
    value: unknown,
  ): { success: true; data: unknown } | { success: false; error: { issues: readonly unknown[] } };
}>;

type RuntimeOwnerCase = Readonly<{
  runtimeParser: string;
  schema: RuntimeSchema;
  base: unknown;
}>;

async function runtimeOwnerCases(): Promise<Record<string, RuntimeOwnerCase>> {
  const [agentVersion, sandboxSpec, signedAttestation, signedHandshake, prepareEnvelope] =
    (await Promise.all(
      [
        'agent-version-manifest.v1.json',
        'sandbox-spec.v1.json',
        'sandbox-attestation.v1.json',
        'broker-handshake.v1.json',
        'broker-invocation-prepare.v1.json',
      ].map(async (path) => JSON.parse(await readFile(new URL(path, fixtureDirectoryUrl), 'utf8'))),
    )) as [
      {
        behaviorContract: unknown;
        runtimePolicy: unknown;
        modelPolicy: unknown;
        codexRuntime: unknown;
      },
      unknown,
      Record<string, unknown>,
      Record<string, unknown>,
      { body: { executionCapability: Record<string, unknown> } },
    ];
  const unsignedAttestation = { ...signedAttestation };
  delete unsignedAttestation.supervisorSignature;
  const unsignedHandshake = { ...signedHandshake };
  delete unsignedHandshake.challengeSignature;
  const unsignedCapability = { ...prepareEnvelope.body.executionCapability };
  delete unsignedCapability.signature;
  const uuid = '0198f00d-6000-7000-8000-000000000001';
  const timestamp = '2026-08-13T08:00:00.000Z';

  return {
    'behavior-role': {
      runtimeParser: 'BehaviorContractSchema',
      schema: BehaviorContractSchema,
      base: agentVersion.behaviorContract,
    },
    'behavior-objective': {
      runtimeParser: 'BehaviorContractSchema',
      schema: BehaviorContractSchema,
      base: agentVersion.behaviorContract,
    },
    'behavior-developer-instruction': {
      runtimeParser: 'BehaviorContractSchema',
      schema: BehaviorContractSchema,
      base: agentVersion.behaviorContract,
    },
    'runtime-resolved-model': {
      runtimeParser: 'RuntimePolicySchema',
      schema: RuntimePolicySchema,
      base: agentVersion.runtimePolicy,
    },
    'model-policy-model': {
      runtimeParser: 'ModelPolicySchema',
      schema: ModelPolicySchema,
      base: agentVersion.modelPolicy,
    },
    'codex-runtime-version': {
      runtimeParser: 'AgentVersionManifestSchema',
      schema: AgentVersionManifestSchema,
      base: agentVersion,
    },
    'sandbox-spec-adapter-version': {
      runtimeParser: 'SandboxSpecSchema',
      schema: SandboxSpecSchema,
      base: sandboxSpec,
    },
    'sandbox-attestation-adapter-version': {
      runtimeParser: 'SandboxAttestationUnsignedSchema',
      schema: SandboxAttestationUnsignedSchema,
      base: unsignedAttestation,
    },
    'sandbox-attestation-codex-version': {
      runtimeParser: 'SandboxAttestationUnsignedSchema',
      schema: SandboxAttestationUnsignedSchema,
      base: unsignedAttestation,
    },
    'create-agent-name': {
      runtimeParser: 'CreateAgentRequestSchema',
      schema: CreateAgentRequestSchema,
      base: { name: 'Safe agent', description: 'Safe description' },
    },
    'create-agent-description': {
      runtimeParser: 'CreateAgentRequestSchema',
      schema: CreateAgentRequestSchema,
      base: { name: 'Safe agent', description: 'Safe description' },
    },
    'agent-view-name': {
      runtimeParser: 'AgentViewSchema',
      schema: AgentViewSchema,
      base: {
        protocol: 'combo.creator-agent-http/1',
        agentId: uuid,
        publicSlug: 'safe-agent',
        name: 'Safe agent',
        description: 'Safe description',
        lifecycle: 'ACTIVE',
        createdAt: timestamp,
      },
    },
    'agent-view-description': {
      runtimeParser: 'AgentViewSchema',
      schema: AgentViewSchema,
      base: {
        protocol: 'combo.creator-agent-http/1',
        agentId: uuid,
        publicSlug: 'safe-agent',
        name: 'Safe agent',
        description: 'Safe description',
        lifecycle: 'ACTIVE',
        createdAt: timestamp,
      },
    },
    'send-conversation-message-text': {
      runtimeParser: 'SendConversationMessageRequestSchema',
      schema: SendConversationMessageRequestSchema,
      base: { clientMessageId: uuid, text: 'Safe message' },
    },
    'consumer-message-text': {
      runtimeParser: 'ConsumerMessageSchema',
      schema: ConsumerMessageSchema,
      base: {
        messageId: uuid,
        invocationId: null,
        turnNo: 1,
        role: 'USER',
        text: 'Safe message',
        createdAt: timestamp,
      },
    },
    'consumer-delta-text': {
      runtimeParser: 'ConsumerEventSchema',
      schema: ConsumerEventSchema,
      base: {
        id: '1',
        type: 'invocation.delta',
        invocationId: uuid,
        text: 'Safe delta',
        occurredAt: timestamp,
      },
    },
    'broker-handshake-worker-version': {
      runtimeParser: 'BrokerHandshakeUnsignedSchema',
      schema: BrokerHandshakeUnsignedSchema,
      base: unsignedHandshake,
    },
    'execution-capability-model': {
      runtimeParser: 'ExecutionCapabilityUnsignedSchema',
      schema: ExecutionCapabilityUnsignedSchema,
      base: unsignedCapability,
    },
    'version-rejected-error-code': {
      runtimeParser: 'BrokerEventSchema',
      schema: BrokerEventSchema,
      base: {
        protocol: 'combo.creator-broker/1',
        schemaVersion: 1,
        kind: 'event',
        messageId: '0198f00d-4000-7000-8000-000000000031',
        type: 'version.rejected',
        correlationId: '0198f00d-3000-7000-8000-000000000032',
        connectionId: '0198f00d-3000-7000-8000-000000000033',
        sequence: '1',
        sentAt: '2026-08-13T08:00:01.000Z',
        expiresAt: '2026-08-13T08:00:31.000Z',
        lease: {
          deploymentId: '0198f00d-3000-7000-8000-000000000034',
          leaseId: '0198f00d-3000-7000-8000-000000000035',
          workerSessionId: '0198f00d-1111-7111-8111-111111111112',
          fence: '42',
        },
        body: { generation: '1', errorCode: 'SAFE_ERROR' },
      },
    },
  };
}

describe('digest-bound public UTF-8 byte boundaries', () => {
  it('pins every advertised UTF-8 keyword in all three checked artifacts', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    expect(fixture.scope).toBe('utf8-byte-limits-only');
    const documents = Object.fromEntries(
      await Promise.all(
        Object.entries(artifactUrls).map(async ([name, url]) => [
          name,
          JSON.parse(await readFile(url, 'utf8')),
        ]),
      ),
    ) as Record<CheckedArtifactName, unknown>;
    const artifactBytes = {
      contractSchemas: await readFile(artifactUrls['contract-schemas']),
      brokerContract: await readFile(artifactUrls['broker-contract']),
      openApi: await readFile(artifactUrls.openapi),
    };
    expect(fixture.checkedArtifactDigests).toEqual({
      contractSchemas: sha256(artifactBytes.contractSchemas),
      brokerContract: sha256(artifactBytes.brokerContract),
      openApi: sha256(artifactBytes.openApi),
    });

    const expectedPointers = fixture.boundaries
      .flatMap(({ artifactPointers }) =>
        artifactPointers.map(({ artifact, pointer }) => `${artifact}:${pointer}`),
      )
      .sort();
    const actualPointers = (Object.entries(documents) as [CheckedArtifactName, unknown][])
      .flatMap(([artifact, document]) => collectUtf8Pointers(artifact, document))
      .sort();
    expect(actualPointers).toEqual(expectedPointers);

    for (const boundary of fixture.boundaries) {
      for (const { artifact, pointer } of boundary.artifactPointers) {
        const node = lookupPointer(documents[artifact], pointer);
        expect(node.maxLength, `${artifact}:${pointer}`).toBe(boundary.maxBytes);
        expect(node['x-combo-maxUtf8Bytes'], `${artifact}:${pointer}`).toBe(boundary.maxBytes);
        expect(node.description, `${artifact}:${pointer}`).toBe(
          `UTF-8 text with a maximum of ${boundary.maxBytes} bytes`,
        );
      }
    }
  });

  it('keeps the portable scalar-control probes aligned at every advertised UTF-8 node', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const documents = Object.fromEntries(
      await Promise.all(
        Object.entries(artifactUrls).map(async ([name, url]) => [
          name,
          JSON.parse(await readFile(url, 'utf8')),
        ]),
      ),
    ) as Record<CheckedArtifactName, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    ajv.addKeyword({
      keyword: 'x-combo-maxUtf8Bytes',
      type: 'string',
      schemaType: 'number',
      errors: false,
      validate(maximumBytes: number, value: string): boolean {
        return Buffer.byteLength(value, 'utf8') <= maximumBytes;
      },
    });
    expect(fixture.scalarControlParity.portablePatternSource).toBe(
      UTF8_TEXT_PORTABLE_PATTERN_SOURCE,
    );
    expect(UTF8_TEXT_PORTABLE_PATTERN.source).toBe(UTF8_TEXT_PORTABLE_PATTERN_SOURCE);
    const excludedPointers = new Set(
      fixture.scalarControlParity.artifactCoverage.excludedPointers.map(
        ({ artifact, pointer }) => `${artifact}:${pointer}`,
      ),
    );
    const publicOwners = fixture.boundaries
      .flatMap(({ artifactPointers }) => artifactPointers)
      .filter(({ artifact, pointer }) => !excludedPointers.has(`${artifact}:${pointer}`));
    const coverage = publicOwners.reduce(
      (counts, { artifact }) => {
        if (artifact === 'contract-schemas') counts.contractSchemas += 1;
        if (artifact === 'broker-contract') counts.brokerContract += 1;
        if (artifact === 'openapi') counts.openApi += 1;
        return counts;
      },
      { contractSchemas: 0, brokerContract: 0, openApi: 0 },
    );
    expect({ ...coverage, total: publicOwners.length }).toEqual(
      fixture.scalarControlParity.artifactCoverage.expectedCounts,
    );

    const runtimeCases = await runtimeOwnerCases();
    expect(Object.keys(runtimeCases).sort()).toEqual(
      fixture.scalarControlParity.runtimeOwners.map(({ id }) => id).sort(),
    );
    let outcomes = 0;
    for (const owner of fixture.scalarControlParity.runtimeOwners) {
      const runtime = runtimeCases[owner.id];
      if (runtime === undefined) throw new Error(`UTF8_RUNTIME_OWNER_MISSING:${owner.id}`);
      expect(runtime.runtimeParser, owner.id).toBe(owner.runtimeParser);
      expect(runtime.schema.safeParse(runtime.base).success, `base:${owner.id}`).toBe(true);
      for (const probe of fixture.scalarControlParity.probes) {
        const value =
          fixture.scalarControlParity.canaryPrefix + String.fromCharCode(...probe.codeUnits);
        const expected = probe.expected === 'accepted';
        const result = runtime.schema.safeParse(
          replacePointer(runtime.base, owner.instancePointer, value),
        );
        expect(result.success, `runtime:${owner.id}:${probe.id}`).toBe(expected);
        if (!expected && !result.success) {
          expect(JSON.stringify(result.error.issues)).not.toContain(
            fixture.scalarControlParity.canaryPrefix,
          );
        }
        outcomes += 1;
      }
    }

    const advertisedValidators = publicOwners.map(({ artifact, pointer }) => {
      const node = lookupPointer(documents[artifact], pointer);
      expect(node.pattern, `${artifact}:${pointer}`).toBe(
        fixture.scalarControlParity.portablePatternSource,
      );
      return { artifact, pointer, validate: ajv.compile(node as AnySchema) };
    });
    for (const { artifact, pointer, validate } of advertisedValidators) {
      for (const probe of fixture.scalarControlParity.probes) {
        const value =
          fixture.scalarControlParity.canaryPrefix + String.fromCharCode(...probe.codeUnits);
        const expected = probe.expected === 'accepted';
        expect(validate(value), `${artifact}:${pointer}:${probe.id}`).toBe(expected);
        if (!expected) {
          expect(JSON.stringify(validate.errors)).not.toContain(
            fixture.scalarControlParity.canaryPrefix,
          );
        }
        outcomes += 1;
      }
    }
    expect(outcomes).toBe(660);
  });

  it('drives exact UTF-8 byte boundaries through all actual runtime owners', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const runtimeCases = await runtimeOwnerCases();
    expect(Object.keys(runtimeCases).sort()).toEqual(
      fixture.scalarControlParity.runtimeOwners.map(({ id }) => id).sort(),
    );

    let outcomes = 0;
    let accepted = 0;
    let rejected = 0;
    let targetIssues = 0;
    let noCanaryChecks = 0;
    for (const owner of fixture.scalarControlParity.runtimeOwners) {
      const runtime = runtimeCases[owner.id];
      if (runtime === undefined) throw new Error(`UTF8_RUNTIME_OWNER_MISSING:${owner.id}`);
      expect(runtime.runtimeParser, owner.id).toBe(owner.runtimeParser);
      expect(runtime.schema.safeParse(runtime.base).success, `base:${owner.id}`).toBe(true);
      const boundary = fixture.boundaries.find(({ maxBytes }) => maxBytes === owner.maxBytes);
      if (boundary === undefined) {
        throw new Error(`UTF8_RUNTIME_OWNER_BOUNDARY_MISSING:${owner.id}:${owner.maxBytes}`);
      }

      for (const generator of boundary.generators) {
        for (const delta of [-1, 0, 1] as const) {
          const targetBytes = owner.maxBytes + delta;
          const value = exactUtf8BytesWithCanary(targetBytes, generator);
          expect(Buffer.byteLength(value, 'utf8'), `${owner.id}:${generator}:${delta}:bytes`).toBe(
            targetBytes,
          );
          const result = runtime.schema.safeParse(
            replacePointer(runtime.base, owner.instancePointer, value),
          );
          const expected = delta <= 0;
          expect(result.success, `${owner.id}:${generator}:${delta}`).toBe(expected);
          if (result.success) accepted += 1;
          else rejected += 1;

          if (!expected) {
            if (result.success) {
              throw new Error(`UTF8_RUNTIME_OWNER_N_PLUS_ONE_ACCEPTED:${owner.id}:${generator}`);
            }
            const targetIssue = hasRuntimeByteBoundaryIssue(
              result.error.issues,
              owner.instancePointer,
              owner.maxBytes,
            );
            expect(targetIssue, `${owner.id}:${generator}:target-issue`).toBe(true);
            if (targetIssue) targetIssues += 1;
            const noCanary = !JSON.stringify(result.error.issues).includes(
              UTF8_BYTE_BOUNDARY_CANARY,
            );
            expect(noCanary, `${owner.id}:${generator}:no-canary`).toBe(true);
            if (noCanary) noCanaryChecks += 1;
          }
          outcomes += 1;
        }
      }
    }

    expect({ outcomes, accepted, rejected, targetIssues, noCanaryChecks }).toEqual({
      outcomes: 171,
      accepted: 114,
      rejected: 57,
      targetIssues: 57,
      noCanaryChecks: 57,
    });
  });

  it('drives exact UTF-8 byte boundaries through all advertised public nodes', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const artifactBytes = {
      contractSchemas: await readFile(artifactUrls['contract-schemas']),
      brokerContract: await readFile(artifactUrls['broker-contract']),
      openApi: await readFile(artifactUrls.openapi),
    };
    expect(fixture.checkedArtifactDigests).toEqual({
      contractSchemas: sha256(artifactBytes.contractSchemas),
      brokerContract: sha256(artifactBytes.brokerContract),
      openApi: sha256(artifactBytes.openApi),
    });
    const documents = {
      'contract-schemas': JSON.parse(artifactBytes.contractSchemas.toString('utf8')),
      'broker-contract': JSON.parse(artifactBytes.brokerContract.toString('utf8')),
      openapi: JSON.parse(artifactBytes.openApi.toString('utf8')),
    } as const satisfies Record<CheckedArtifactName, unknown>;
    const excludedPointers = new Set(
      fixture.scalarControlParity.artifactCoverage.excludedPointers.map(
        ({ artifact, pointer }) => `${artifact}:${pointer}`,
      ),
    );
    const publicOwners = fixture.boundaries.flatMap((boundary) =>
      boundary.artifactPointers
        .filter(({ artifact, pointer }) => !excludedPointers.has(`${artifact}:${pointer}`))
        .map(({ artifact, pointer }) => ({
          artifact,
          pointer,
          maxBytes: boundary.maxBytes,
          generators: boundary.generators,
        })),
    );
    const coverage = publicOwners.reduce(
      (counts, { artifact }) => {
        if (artifact === 'contract-schemas') counts.contractSchemas += 1;
        if (artifact === 'broker-contract') counts.brokerContract += 1;
        if (artifact === 'openapi') counts.openApi += 1;
        return counts;
      },
      { contractSchemas: 0, brokerContract: 0, openApi: 0 },
    );
    expect({ ...coverage, total: publicOwners.length }).toEqual(
      fixture.scalarControlParity.artifactCoverage.expectedCounts,
    );

    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    ajv.addKeyword({
      keyword: 'x-combo-maxUtf8Bytes',
      type: 'string',
      schemaType: 'number',
      errors: false,
      validate(maximumBytes: number, value: string): boolean {
        return Buffer.byteLength(value, 'utf8') <= maximumBytes;
      },
    });
    let outcomes = 0;
    let accepted = 0;
    let rejected = 0;
    let targetIssues = 0;
    let noCanaryChecks = 0;
    for (const owner of publicOwners) {
      const validate = ajv.compile(
        lookupPointer(documents[owner.artifact], owner.pointer) as AnySchema,
      );
      for (const generator of owner.generators) {
        for (const delta of [-1, 0, 1] as const) {
          const targetBytes = owner.maxBytes + delta;
          const value = exactUtf8BytesWithCanary(targetBytes, generator);
          expect(
            Buffer.byteLength(value, 'utf8'),
            `${owner.artifact}:${owner.pointer}:${generator}:${delta}:bytes`,
          ).toBe(targetBytes);
          const expected = delta <= 0;
          const result = validate(value);
          expect(
            result,
            `${owner.artifact}:${owner.pointer}:${generator}:${delta}:${JSON.stringify(validate.errors)}`,
          ).toBe(expected);
          if (result) accepted += 1;
          else rejected += 1;

          if (!expected) {
            const targetIssue =
              validate.errors?.some(
                ({ keyword, instancePath }) =>
                  keyword === 'x-combo-maxUtf8Bytes' && instancePath === '',
              ) === true;
            expect(
              targetIssue,
              `${owner.artifact}:${owner.pointer}:${generator}:target-issue`,
            ).toBe(true);
            if (targetIssue) targetIssues += 1;
            const noCanary = !JSON.stringify(validate.errors).includes(UTF8_BYTE_BOUNDARY_CANARY);
            expect(noCanary, `${owner.artifact}:${owner.pointer}:${generator}:no-canary`).toBe(
              true,
            );
            if (noCanary) noCanaryChecks += 1;
          }
          outcomes += 1;
        }
      }
    }

    expect({ outcomes, accepted, rejected, targetIssues, noCanaryChecks }).toEqual({
      outcomes: 423,
      accepted: 282,
      rejected: 141,
      targetIssues: 141,
      noCanaryChecks: 141,
    });
  });

  it('keeps Signed PUT URL scalar/control parity before URL normalization', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const parity = fixture.strictStructuralParity;
    expect(parity.patternSource).toBe(UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE);
    expect(UNICODE_SCALAR_NO_CONTROL_PATTERN.source).toBe(UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE);
    const runtimeOwners = {
      'archive-signed-put-target': SnapshotArchiveSignedPutTargetSchema,
      'manifest-signed-put-target': SnapshotManifestSignedPutTargetSchema,
    } as const;

    const documents = {
      'contract-schemas': JSON.parse(await readFile(artifactUrls['contract-schemas'], 'utf8')),
      openapi: JSON.parse(await readFile(artifactUrls.openapi, 'utf8')),
    } as const;
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const physicalValidators = parity.physicalPublicNodes.map((node) => {
      const schema = lookupPointer(documents[node.artifact], node.pointer);
      expect(schema.pattern, `${node.artifact}:${node.pointer}`).toBe(parity.patternSource);
      expect(schema.maxLength, `${node.artifact}:${node.pointer}`).toBeUndefined();
      return { ...node, validate: ajv.compile(schema as AnySchema) };
    });
    const fullResponseValidators = {
      'contract-schemas': ajv.compile(
        lookupPointer(
          documents['contract-schemas'],
          '/schemas/SnapshotUploadCreateResponse',
        ) as AnySchema,
      ),
      openapi: ajv.compile(
        lookupPointer(
          documents.openapi,
          '/components/schemas/SnapshotUploadCreateResponse',
        ) as AnySchema,
      ),
    } as const;
    const baseResponse = signedPutResponse();
    expect(SnapshotUploadCreateResponseSchema.safeParse(baseResponse).success).toBe(true);
    expect(fullResponseValidators['contract-schemas'](baseResponse)).toBe(true);
    expect(fullResponseValidators.openapi(baseResponse)).toBe(true);
    let outcomes = 0;

    for (const probe of parity.probes) {
      const value = `https://uploads.example.invalid/${parity.canaryPrefix}${String.fromCharCode(
        ...probe.codeUnits,
      )}/object`;
      const expected = probe.expected === 'accepted';
      for (const owner of parity.runtimeTargetOwners) {
        const result = runtimeOwners[owner.id].safeParse(
          signedPutTarget(owner.id === 'archive-signed-put-target' ? 'archive' : 'manifest', value),
        );
        expect(result.success, `runtime:${owner.id}:${probe.id}`).toBe(expected);
        if (!expected && !result.success) {
          expect(JSON.stringify(result.error.issues)).not.toContain(parity.canaryPrefix);
        }
        outcomes += 1;
      }
      for (const node of physicalValidators) {
        expect(node.validate(value), `${node.artifact}:${node.pointer}:${probe.id}`).toBe(expected);
        if (!expected) {
          expect(JSON.stringify(node.validate.errors)).not.toContain(parity.canaryPrefix);
        }
        outcomes += 1;
      }
      for (const owner of parity.runtimeTargetOwners) {
        const result = SnapshotUploadCreateResponseSchema.safeParse(
          replacePointer(baseResponse, owner.responseInstancePointer, value),
        );
        expect(result.success, `runtime-response:${owner.id}:${probe.id}`).toBe(expected);
        if (!expected && !result.success) {
          expect(JSON.stringify(result.error.issues)).not.toContain(parity.canaryPrefix);
        }
        outcomes += 1;
      }
      for (const owner of parity.semanticResponseOwners) {
        const response = replacePointer(baseResponse, owner.responseInstancePointer, value);
        const validate = fullResponseValidators[owner.artifact];
        expect(validate(response), `response:${owner.id}:${probe.id}`).toBe(expected);
        if (!expected) {
          expect(JSON.stringify(validate.errors)).not.toContain(parity.canaryPrefix);
        }
        outcomes += 1;
      }
    }
    expect(outcomes).toBe(132);
  });

  it('enforces max minus one, max, and max plus one for ASCII CJK and emoji', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    for (const boundary of fixture.boundaries) {
      const schema = Utf8TextSchema(boundary.maxBytes);
      for (const generator of boundary.generators) {
        const below = exactUtf8Bytes(boundary.maxBytes - 1, generator);
        const exact = exactUtf8Bytes(boundary.maxBytes, generator);
        const above = exactUtf8Bytes(boundary.maxBytes + 1, generator);
        expect(Buffer.byteLength(below, 'utf8')).toBe(boundary.maxBytes - 1);
        expect(Buffer.byteLength(exact, 'utf8')).toBe(boundary.maxBytes);
        expect(Buffer.byteLength(above, 'utf8')).toBe(boundary.maxBytes + 1);
        expect(schema.safeParse(below).success, `${boundary.maxBytes}:${generator}:N-1`).toBe(true);
        expect(schema.safeParse(exact).success, `${boundary.maxBytes}:${generator}:N`).toBe(true);
        expect(schema.safeParse(above).success, `${boundary.maxBytes}:${generator}:N+1`).toBe(
          false,
        );
      }
    }
  });

  it('registers the custom byte keyword where standard maxLength still accepts multibyte N plus one', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const contractSchemas = JSON.parse(
      await readFile(artifactUrls['contract-schemas'], 'utf8'),
    ) as unknown;
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    ajv.addKeyword({
      keyword: 'x-combo-maxUtf8Bytes',
      type: 'string',
      schemaType: 'number',
      errors: false,
      validate(maximumBytes: number, value: string): boolean {
        return Buffer.byteLength(value, 'utf8') <= maximumBytes;
      },
    });
    for (const boundary of fixture.boundaries) {
      const pointer = boundary.artifactPointers.find(
        ({ artifact }) => artifact === 'contract-schemas',
      );
      if (pointer === undefined) throw new Error('UTF8_CONTRACT_SCHEMA_POINTER_MISSING');
      const node = lookupPointer(contractSchemas, pointer.pointer);
      const validate = ajv.compile(node as AnySchema);
      for (const generator of ['cjk', 'emoji'] as const) {
        const above = exactUtf8Bytes(boundary.maxBytes + 1, generator);
        expect([...above].length).toBeLessThanOrEqual(boundary.maxBytes);
        expect(validate(above), `${boundary.maxBytes}:${generator}:N+1`).toBe(false);
        expect(validate(exactUtf8Bytes(boundary.maxBytes, generator))).toBe(true);
      }
    }
  });

  it('drives the actual Snapshot manifest path parser and advertised schema with one fixture', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const owner = fixture.ownerCases[0];
    const ownerFixtureUrl = new URL(`../../fixtures/${owner.fixturePath}`, import.meta.url);
    const ownerFixtureBytes = await readFile(ownerFixtureUrl);
    expect(sha256(ownerFixtureBytes)).toBe(owner.fixtureDigest);
    const manifest = JSON.parse(ownerFixtureBytes.toString('utf8')) as {
      files: Array<{ path: string; size: number }>;
      totals: { fileCount: number; expandedBytes: number };
    };
    const contractSchemas = JSON.parse(
      await readFile(artifactUrls['contract-schemas'], 'utf8'),
    ) as unknown;
    const node = lookupPointer(contractSchemas, owner.artifactPointer);
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    ajv.addKeyword({
      keyword: 'x-combo-maxUtf8Bytes',
      type: 'string',
      schemaType: 'number',
      errors: false,
      validate(maximumBytes: number, value: string): boolean {
        return Buffer.byteLength(value, 'utf8') <= maximumBytes;
      },
    });
    const validateAdvertisedPath = ajv.compile(node as AnySchema);

    for (const generator of owner.generators) {
      for (const delta of [-1, 0, 1] as const) {
        const path = exactUtf8Bytes(owner.maxBytes + delta, generator);
        const singleFile = { ...manifest.files[0]!, path };
        const candidate = {
          ...manifest,
          files: [singleFile],
          totals: { fileCount: 1, expandedBytes: singleFile.size },
        };
        const expected = delta <= 0;
        expect(
          SnapshotManifestSchema.safeParse(candidate).success,
          `${owner.runtimeParser}:${generator}:${delta}`,
        ).toBe(expected);
        expect(
          validateAdvertisedPath(path),
          `advertised:${generator}:${delta}:${JSON.stringify(validateAdvertisedPath.errors)}`,
        ).toBe(expected);
      }
    }
  });
});
