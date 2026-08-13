import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';
// VNext registry case: SCH-006
import { createJsonSchemaBundle, createOpenApiDocument } from '../artifacts.js';
import { readFixture } from './fixture-helpers.js';

describe('生成的 JSON Schema 与 OpenAPI', () => {
  it('schema bundle 包含六份共享协议和 Gate 0 registries', () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    for (const required of [
      'AgentVersionManifest',
      'SnapshotManifest',
      'SnapshotArchiveEnvelopeAad',
      'SnapshotArchiveEnvelope',
      'SnapshotManifestEnvelopeAad',
      'SnapshotManifestEnvelope',
      'BrokerHandshake',
      'BrokerEnvelope',
      'InvocationTransition',
      'VnextErrorResponse',
      'SandboxSpec',
      'SandboxAttestation',
      'TestCaseRegistry',
      'EvidenceBundleManifest',
      'EvidenceEnvironments',
      'EvidencePrivacyScan',
      'EvidenceReleaseTuple',
      'ConsumerTerminalEventPayload',
      'ConsumerEventOutboxRecord',
      'ConsumerEventStream',
    ]) {
      expect(bundle.schemas[required], required).toBeDefined();
    }
  });

  it('publishes Snapshot archive Envelope semantic bindings beside structural JSON Schema', () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    expect(bundle.schemas.SnapshotArchiveEnvelope).toMatchObject({
      'x-combo-runtime-constraints': expect.arrayContaining([
        'cipherBytes == aad.plaintextBytes + 36',
        'cipherDigest == sha256(exact whole cipher object)',
        'envelope nonce/authTag MUST equal the cipher object segments byte-for-byte',
        'all cipher object consumers MUST pass parseSnapshotArchiveCipherObject(envelope,objectBytes) before unwrap or decrypt',
      ]),
    });
  });

  it('publishes encrypted manifest Envelope and upload pair semantic bindings', () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    expect(bundle.schemas.SnapshotManifestEnvelope).toMatchObject({
      'x-combo-runtime-constraints': expect.arrayContaining([
        'cipherBytes == aad.plaintextBytes + 36',
        'archive and manifest envelopes MUST bind the same creatorId/snapshotDigest/keyId/wrappedDek and distinct nonces',
        'all manifest cipher object consumers MUST pass parseSnapshotManifestCipherObject(envelope,objectBytes) before unwrap, decrypt, or JSON parse',
      ]),
    });
    expect(bundle.schemas.SnapshotUploadCreateRequest).toMatchObject({
      'x-combo-runtime-constraints': expect.arrayContaining([
        'archive and manifest envelopes MUST bind the same creatorId/snapshotDigest/keyId/wrappedDek and distinct nonces',
        'the Worker MUST finish both cipher objects before constructing this request',
      ]),
    });
    expect(bundle.schemas.SnapshotUploadCreateResponse).toMatchObject({
      'x-combo-runtime-constraints': expect.arrayContaining([
        'each target requiredHeaders MUST bind exact cipherBytes/cipherDigest/checksum/object-kind and include no unknown header',
        'public Authoring responses MUST use HTTPS; insecure loopback is only an explicit disposable component-test authority',
      ]),
    });
  });

  it('standard JSON Schema validates the Snapshot archive Envelope structure before runtime bindings', async () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validateEnvelope = ajv.compile(bundle.schemas.SnapshotArchiveEnvelope as AnySchema);
    const envelope = (await readFixture('snapshot-envelope.v1.json')) as Record<string, unknown>;

    expect(validateEnvelope(envelope)).toBe(true);
    expect(validateEnvelope({ ...envelope, nonce: 'short' })).toBe(false);
    expect(
      validateEnvelope({ ...envelope, wrappedDek: Buffer.alloc(39).toString('base64url') }),
    ).toBe(false);
    expect(validateEnvelope({ ...envelope, cipherBytes: '68' })).toBe(false);
    expect(validateEnvelope({ ...envelope, unexpected: true })).toBe(false);
  });

  it('generated Consumer terminal schema physically advertises only the five terminal states', () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    const states = collectPropertyConsts(
      bundle.schemas.ConsumerTerminalEventPayload,
      'terminalState',
    );
    expect([...states].sort()).toEqual(
      ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED'].sort(),
    );
    expect(states.has('RUNNING')).toBe(false);
  });

  it('a standard JSON Schema validator rejects structurally invalid terminal and outbox states', async () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validateTerminal = ajv.compile(bundle.schemas.ConsumerTerminalEventPayload as AnySchema);
    const validateOutbox = ajv.compile(bundle.schemas.ConsumerEventOutboxRecord as AnySchema);
    const outbox = (await readFixture('consumer-terminal-event-outbox.v1.json')) as Record<
      string,
      unknown
    >;
    const payload = outbox.payload as Record<string, unknown>;

    expect(validateTerminal(payload)).toBe(true);
    expect(validateTerminal({ ...payload, assistantMessageId: null })).toBe(false);
    expect(
      validateTerminal({
        ...payload,
        terminalState: 'FAILED',
        assistantMessageId: null,
        resultDigest: null,
        errorCode: null,
      }),
    ).toBe(false);

    expect(validateOutbox(outbox)).toBe(true);
    expect(validateOutbox({ ...outbox, nextAttemptAt: null })).toBe(false);
    expect(
      validateOutbox({
        ...outbox,
        state: 'PUBLISHED',
        nextAttemptAt: outbox.nextAttemptAt,
        publishedAt: '2026-08-13T08:00:11.000Z',
      }),
    ).toBe(false);

    expect(bundle.schemas.ConsumerEventOutboxRecord).toMatchObject({
      'x-combo-runtime-constraints': expect.arrayContaining([
        'payloadDigest == sha256(JCS(payload))',
        'retainedUntil == createdAt + 7 days',
      ]),
    });
  });

  it('marks Broker AEAD semantic bindings as mandatory authoritative runtime validation', () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    expect(bundle.schemas.BrokerEnvelope).toMatchObject({
      'x-combo-runtime-constraints': expect.arrayContaining([
        'sensitive.aad.conversationId == body.conversationId',
        'sensitive.aad.workerSessionId == lease.workerSessionId',
        'all Broker frames MUST pass the authoritative runtime BrokerEnvelopeSchema parser after structural JSON Schema validation',
      ]),
    });
  });

  it('OpenAPI 3.1 暴露 Creator/Consumer 核心路径与共享组件', () => {
    const openapi = createOpenApiDocument() as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(openapi.openapi).toBe('3.1.0');
    for (const path of [
      '/v1/creator/snapshot-uploads',
      '/v1/creator/agents/{agentId}/versions',
      '/v1/creator/agents/{agentId}/versions/{versionId}',
      '/v1/public/agents/{slug}/conversations',
      '/v1/conversations/{conversationId}/messages',
      '/v1/conversations/{conversationId}/events',
      '/v1/invocations/{invocationId}:cancel',
      '/v1/invocations/{invocationId}:retry',
    ]) {
      expect(openapi.paths[path], path).toBeDefined();
    }
    expect(openapi.components.schemas.VnextErrorResponse).toBeDefined();
  });
});

function collectPropertyConsts(value: unknown, propertyName: string): Set<string> {
  const found = new Set<string>();
  visit(value);
  return found;

  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    const properties = record.properties;
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      const property = (properties as Record<string, unknown>)[propertyName];
      if (property !== null && typeof property === 'object' && !Array.isArray(property)) {
        const literal = (property as Record<string, unknown>).const;
        if (typeof literal === 'string') found.add(literal);
      }
    }
    for (const nested of Object.values(record)) visit(nested);
  }
}
