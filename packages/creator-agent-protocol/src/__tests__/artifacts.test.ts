import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';
// VNext registry case: SCH-006
import {
  createBrokerContractArtifact,
  createJsonSchemaBundle,
  createOpenApiDocument,
  currentBrokerContractDigest,
} from '../artifacts.js';
import {
  BROKER_MAX_FRAME_BYTES,
  BROKER_WORKER_CONNECT_PATH,
  CREATOR_BROKER_PROTOCOL,
  BrokerCloseCode,
  BrokerCloseReason,
  brokerSensitiveMessageCipherDigest,
} from '../broker.js';
import { CANONICAL_JSON_IMPLEMENTATION, canonicalSha256, canonicalizeJson } from '../canonical.js';
import { ServerIdSchema } from '../primitives.js';
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
      'SnapshotPublicationPreparationMarker',
      'SnapshotPublicationCommitMarker',
      'BrokerRegistrationCapabilities',
      'BrokerHandshake',
      'BrokerEnvelope',
      'BrokerConversationOpenAuthority',
      'BrokerConversationOpenCommand',
      'BrokerConversationOpenLogicalCommand',
      'InvocationTransition',
      'VnextErrorResponse',
      'PublicAgentSlug',
      'DeploymentGenerationEtag',
      'LastEventId',
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
      'WorkerInvocationFact',
      'WorkerConversationReadyFact',
    ]) {
      expect(bundle.schemas[required], required).toBeDefined();
    }
  });

  it('publishes Unicode code-point limits and bounded HTTP path/header schemas', () => {
    const bundle = createJsonSchemaBundle() as {
      schemas: Record<string, Record<string, unknown>>;
    };
    const openapi = createOpenApiDocument() as {
      components: { schemas: Record<string, Record<string, unknown>> };
      paths: Record<string, Record<string, unknown>>;
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

    const errorSchema = bundle.schemas.VnextErrorResponse! as {
      definitions: { VnextErrorResponse: { properties: Record<string, Record<string, unknown>> } };
    };
    const message = errorSchema.definitions.VnextErrorResponse.properties.message!;
    const requestId = errorSchema.definitions.VnextErrorResponse.properties.requestId!;
    expect(message).toMatchObject({
      minLength: 1,
      maxLength: 512,
      'x-combo-unicodeCodePoints': { minimum: 1, maximum: 512 },
    });
    expect(requestId).toMatchObject({
      minLength: 8,
      maxLength: 128,
      'x-combo-unicodeCodePoints': { minimum: 8, maximum: 128 },
    });
    const validateMessage = ajv.compile(message as AnySchema);
    const validateRequestId = ajv.compile(requestId as AnySchema);
    expect(validateMessage('😀'.repeat(512))).toBe(true);
    expect(validateMessage('😀'.repeat(513))).toBe(false);
    expect(validateRequestId('😀'.repeat(7))).toBe(false);
    expect(validateRequestId('😀'.repeat(8))).toBe(true);
    expect(validateRequestId('😀'.repeat(128))).toBe(true);
    expect(validateRequestId('😀'.repeat(129))).toBe(false);

    const slugSchema = openapi.components.schemas.PublicAgentSlug!;
    const ifMatchSchema = openapi.components.schemas.DeploymentGenerationEtag!;
    const lastEventIdSchema = openapi.components.schemas.LastEventId!;
    expect(slugSchema).toMatchObject({ minLength: 1, maxLength: 64 });
    expect(ifMatchSchema).toMatchObject({ minLength: 14, maxLength: 32 });
    expect(lastEventIdSchema).toMatchObject({ minLength: 1, maxLength: 19 });
    const validateSlug = ajv.compile(slugSchema as AnySchema);
    const validateIfMatch = ajv.compile(ifMatchSchema as AnySchema);
    const validateLastEventId = ajv.compile(lastEventIdSchema as AnySchema);
    expect(validateSlug(`a${'b'.repeat(62)}c`)).toBe(true);
    expect(validateSlug(`a${'b'.repeat(64)}`)).toBe(false);
    expect(validateIfMatch('"generation-9223372036854775807"')).toBe(true);
    expect(validateIfMatch('"generation-9223372036854775808"')).toBe(false);
    expect(validateLastEventId('9223372036854775807')).toBe(true);
    expect(validateLastEventId('9223372036854775808')).toBe(false);

    const deploymentParameters = (
      openapi.paths['/v1/creator/agents/{agentId}/deployment']!.put as {
        parameters: Array<{ name: string; schema: Record<string, unknown> }>;
      }
    ).parameters;
    const conversationParameters = (
      openapi.paths['/v1/public/agents/{slug}/conversations']!.post as {
        parameters: Array<{ name: string; schema: Record<string, unknown> }>;
      }
    ).parameters;
    const eventParameters = (
      openapi.paths['/v1/conversations/{conversationId}/events']!.get as {
        parameters: Array<{ name: string; schema: Record<string, unknown> }>;
      }
    ).parameters;
    expect(deploymentParameters.find(({ name }) => name === 'If-Match')?.schema).toEqual({
      $ref: '#/components/schemas/DeploymentGenerationEtag',
    });
    expect(conversationParameters.find(({ name }) => name === 'slug')?.schema).toEqual({
      $ref: '#/components/schemas/PublicAgentSlug',
    });
    expect(eventParameters.find(({ name }) => name === 'Last-Event-ID')?.schema).toEqual({
      $ref: '#/components/schemas/LastEventId',
    });
  });

  it('publishes one exact UUIDv7 server-ID schema for all 11 path parameters only', () => {
    const bundle = createJsonSchemaBundle() as {
      schemas: Record<string, Record<string, unknown>>;
    };
    const openapi = createOpenApiDocument() as {
      components: { schemas: Record<string, Record<string, unknown>> };
      paths: Record<
        string,
        Record<string, { parameters?: Array<{ name: string; in: string; schema: unknown }> }>
      >;
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const contractServerId = ajv.compile(bundle.schemas.ServerId as AnySchema);
    const openApiServerId = ajv.compile(openapi.components.schemas.ServerId as AnySchema);
    const values = {
      nMinusOne: '0198f00d-6000-7000-8000-00000000001',
      n: '0198f00d-6000-7000-8000-000000000001',
      nPlusOne: '0198f00d-6000-7000-8000-0000000000010',
      uuidV4: '550e8400-e29b-41d4-a716-446655440000',
      uuidV8: '0198f00d-6000-8000-8000-000000000001',
      uppercase: '0198F00D-6000-7000-8000-000000000001',
    } as const;

    for (const [name, value] of Object.entries(values)) {
      const expected = name === 'n';
      expect(ServerIdSchema.safeParse(value).success, `runtime:${name}`).toBe(expected);
      expect(contractServerId(value), `contract:${name}`).toBe(expected);
      expect(openApiServerId(value), `openapi:${name}`).toBe(expected);
    }
    expect(bundle.schemas.ServerId).toMatchObject({
      definitions: {
        ServerId: {
          type: 'string',
          minLength: 36,
          maxLength: 36,
          format: 'uuid',
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        },
      },
    });
    expect(openapi.components.schemas.ServerId).toMatchObject({
      type: 'string',
      minLength: 36,
      maxLength: 36,
      format: 'uuid',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    });

    const pathParameters = Object.values(openapi.paths).flatMap((pathItem) =>
      Object.values(pathItem).flatMap((operation) => operation.parameters ?? []),
    );
    const serverIdParameters = pathParameters.filter(
      ({ in: location, name }) => location === 'path' && name !== 'slug',
    );
    expect(serverIdParameters).toHaveLength(11);
    expect(serverIdParameters.map(({ schema }) => schema)).toEqual(
      Array.from({ length: 11 }, () => ({ $ref: '#/components/schemas/ServerId' })),
    );

    const idempotencyParameters = pathParameters.filter(
      ({ in: location, name }) => location === 'header' && name === 'Idempotency-Key',
    );
    expect(idempotencyParameters).toHaveLength(9);
    expect(idempotencyParameters.map(({ schema }) => schema)).toEqual(
      Array.from({ length: 9 }, () => ({ $ref: '#/components/schemas/IdempotencyKey' })),
    );
  });

  it('advertises the frozen nine-gate cardinality and uniqueness constraints', () => {
    const bundle = createJsonSchemaBundle() as {
      schemas: Record<
        string,
        { definitions: Record<string, { properties: Record<string, unknown> }> }
      >;
    };
    const signoffGates =
      bundle.schemas.EvidenceReviewerSignoff!.definitions.EvidenceReviewerSignoff!.properties
        .reviewedGates;
    const invariantGates = (
      bundle.schemas.InvariantRegistry!.definitions.InvariantRegistry!.properties.invariants as {
        items: { properties: Record<string, unknown> };
      }
    ).items.properties.gates;

    expect(signoffGates).toMatchObject({ minItems: 1, maxItems: 9, uniqueItems: true });
    expect(invariantGates).toMatchObject({ minItems: 1, maxItems: 9, uniqueItems: true });
  });

  it('publishes one non-self-referential Broker contract artifact and stable JCS digest', () => {
    const artifact = createBrokerContractArtifact() as {
      protocol: string;
      wireProtocol: string;
      canonicalization: string;
      connectPath: string;
      maxFrameBytes: number;
      closeCodes: Record<string, number>;
      closeReasons: Record<string, string>;
      schemas: Record<string, unknown>;
      runtimeConstraints: Record<string, string[]>;
    };
    const digest = currentBrokerContractDigest();

    expect(artifact.protocol).toBe('combo.creator-broker-contract/1');
    expect(artifact.wireProtocol).toBe('combo.creator-broker/1');
    expect(Object.keys(artifact).sort()).toEqual(
      [
        'protocol',
        'schemaVersion',
        'wireProtocol',
        'canonicalization',
        'connectPath',
        'maxFrameBytes',
        'closeCodes',
        'closeReasons',
        'schemas',
        'runtimeConstraints',
      ].sort(),
    );
    expect(artifact.canonicalization).toBe(CANONICAL_JSON_IMPLEMENTATION);
    expect(artifact.connectPath).toBe(BROKER_WORKER_CONNECT_PATH);
    expect(artifact.maxFrameBytes).toBe(BROKER_MAX_FRAME_BYTES);
    expect(artifact.closeCodes).toEqual(BrokerCloseCode);
    expect(artifact.closeReasons).toEqual(BrokerCloseReason);
    expect(Object.keys(artifact.schemas).sort()).toEqual(
      [
        'BrokerRegistrationCapabilities',
        'BrokerHandshake',
        'BrokerEnvelope',
        'BrokerConversationOpenAuthority',
        'BrokerConversationOpenCommand',
        'BrokerConversationOpenLogicalCommand',
      ].sort(),
    );
    expect(artifact.runtimeConstraints.BrokerHandshake).toContain(
      'brokerContractDigest is part of brokerHandshakeSigningBytes and MUST equal currentBrokerContractDigest()',
    );
    expect(artifact.runtimeConstraints.BrokerConversationOpenCommand).toContain(
      'outer connectionId/sequence/sentAt/expiresAt/leaseId/workerSessionId/fence MAY change after authorized re-enveloping',
    );
    expect(digest).toBe(`sha256:${canonicalSha256(artifact)}`);
    expect(canonicalizeJson(artifact)).not.toContain(digest);
  });

  it('publishes the exact five-field Broker cipher digest preimage used by runtime', async () => {
    const artifact = createBrokerContractArtifact() as {
      runtimeConstraints: Record<string, string[]>;
    };
    const prepare = (await readFixture('broker-invocation-prepare.v1.json')) as {
      body: {
        userMessageCiphertext: {
          nonce: string;
          ciphertext: string;
          authTag: string;
          cipherDigest: string;
        };
      };
    };
    const cipher = prepare.body.userMessageCiphertext;
    const runtimeDigest = brokerSensitiveMessageCipherDigest(
      cipher.nonce,
      cipher.ciphertext,
      cipher.authTag,
    );
    const advertisedDigest = canonicalSha256({
      protocol: CREATOR_BROKER_PROTOCOL,
      schemaVersion: 1,
      nonce: cipher.nonce,
      ciphertext: cipher.ciphertext,
      authTag: cipher.authTag,
    });
    const obsoleteThreeFieldDigest = canonicalSha256({
      nonce: cipher.nonce,
      ciphertext: cipher.ciphertext,
      authTag: cipher.authTag,
    });

    expect(artifact.runtimeConstraints.BrokerEnvelope).toContain(
      'sensitive.cipherDigest == sha256(JCS({protocol:"combo.creator-broker/1",schemaVersion:1,nonce,ciphertext,authTag}))',
    );
    expect(advertisedDigest).toBe(runtimeDigest);
    expect(cipher.cipherDigest).toBe(runtimeDigest);
    expect(obsoleteThreeFieldDigest).not.toBe(runtimeDigest);
  });

  it('generated Broker schemas require registration/handshake digest and open authority', async () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validateRegistration = ajv.compile(
      bundle.schemas.BrokerRegistrationCapabilities as AnySchema,
    );
    const validateHandshake = ajv.compile(bundle.schemas.BrokerHandshake as AnySchema);
    const validateOpen = ajv.compile(bundle.schemas.BrokerConversationOpenCommand as AnySchema);
    const handshake = (await readFixture('broker-handshake.v1.json')) as Record<string, unknown>;
    const open = (await readFixture('broker-conversation-open.v1.json')) as Record<string, unknown>;
    const registration = {
      codexRuntimeArtifacts: handshake.codexRuntimeArtifacts,
      codexProtocolSchemaDigests: handshake.codexProtocolSchemaDigests,
      isolationModes: handshake.isolationModes,
      brokerContractDigest: handshake.brokerContractDigest,
    };

    expect(validateRegistration(registration)).toBe(true);
    expect(validateRegistration({ ...registration, brokerContractDigest: undefined })).toBe(false);
    expect(validateRegistration({ ...registration, unknown: true })).toBe(false);
    expect(validateHandshake(handshake)).toBe(true);
    const missingDigest = { ...handshake };
    delete missingDigest.brokerContractDigest;
    expect(validateHandshake(missingDigest)).toBe(false);
    expect(validateOpen(open)).toBe(true);
    const body = { ...(open.body as Record<string, unknown>) };
    delete body.openAuthority;
    expect(validateOpen({ ...open, body })).toBe(false);
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
      definitions: {
        SnapshotUploadCreateResponse: {
          properties: {
            uploads: {
              properties: {
                archive: {
                  properties: {
                    cipherBytes: { maximum: 50 * 1024 * 1024 + 36 },
                    requiredHeaders: {
                      properties: { 'x-amz-meta-object-kind': { const: 'archive' } },
                    },
                  },
                },
                manifest: {
                  properties: {
                    cipherBytes: { maximum: 4 * 1024 * 1024 + 36 },
                    requiredHeaders: {
                      properties: { 'x-amz-meta-object-kind': { const: 'manifest' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      'x-combo-runtime-constraints': expect.arrayContaining([
        'each target requiredHeaders MUST bind exact cipherBytes/cipherDigest/checksum/object-kind and include no unknown header',
        'public Authoring responses MUST use HTTPS; insecure loopback is only an explicit disposable component-test authority',
      ]),
    });
  });

  it('publishes the two-phase Snapshot publication authority and visibility rule', () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    expect(bundle.schemas.SnapshotPublicationPreparationMarker).toMatchObject({
      'x-combo-runtime-constraints': expect.arrayContaining([
        'the marker MUST be exact bounded RFC 8785 JCS bytes and written only after full dual-object AEAD and plaintext verification',
        'wrappedDek/keyId are private verifier/recovery control metadata and MUST NOT enter S3 user metadata, URLs, logs, browser, Gateway, or model input',
      ]),
    });
    expect(bundle.schemas.SnapshotPublicationCommitMarker).toMatchObject({
      'x-combo-runtime-constraints': expect.arrayContaining([
        'preparationDigest == sha256(exact canonical preparation marker bytes)',
        'readers MUST treat absence of this marker as unpublished even when preparation or final objects exist',
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
        'conversation.ready body.factDigest == sha256(JCS(exact combo.worker-conversation-ready-fact/1 fields))',
        'conversation.ready sourceEventId == openCommandId, sourceEventId != re-envelope messageId, and correlationId == conversationId',
        'conversation.ready fact installationId/workerSessionId/leaseId/fence bind original open authority and MAY differ from the current outer transport authority after authorized re-enveloping',
        'conversation.open correlationId == body.conversationId and messageId != correlationId',
        'conversation.open lease.deploymentId == body.openAuthority.deploymentId',
        'conversation.open body.openAuthority is immutable while outer connection/sequence/time/session/lease/fence MAY change after authorized re-enveloping',
        'Worker invocation event body.factDigest == sha256(JCS(exact combo.worker-invocation-fact/1 fields))',
        'Worker invocation fact leaseId/fence bind original execution authority and MAY differ from the current outer transport lease after authorized re-enveloping',
        'prepared/started commandId == correlationId; delta and terminal correlationId == invocationId',
        'all Broker frames MUST pass the authoritative runtime BrokerEnvelopeSchema parser after structural JSON Schema validation',
      ]),
    });
    expect(bundle.schemas.WorkerInvocationFact).toMatchObject({
      'x-combo-runtime-constraints': expect.arrayContaining([
        'sourceEventId == prepareCommandId for prepared, startCommandId for started, and invocationId for succeeded/failed/cancelled/uncertain',
        'started stores exact runtimeThreadId/runtimeTurnId query handles; succeeded repeats both handles and binds startedFactDigest',
        'fence MUST be a canonical decimal string in the exact uint63 range 0..9223372036854775807',
        'all Worker Invocation facts MUST pass the authoritative runtime WorkerInvocationFactSchema parser after structural JSON Schema validation',
      ]),
    });
    expect(bundle.schemas.WorkerConversationReadyFact).toMatchObject({
      'x-combo-runtime-constraints': expect.arrayContaining([
        'sourceEventId == openCommandId and remains stable across Broker reconnection/re-enveloping',
        'installationId/workerSessionId/leaseId/fence bind the original conversation.open authority and remain immutable',
        'fence MUST be a canonical decimal string in the exact uint63 range 0..9223372036854775807',
        'all Worker Conversation Ready facts MUST pass the authoritative runtime WorkerConversationReadyFactSchema parser after structural JSON Schema validation',
      ]),
    });
  });

  it('standard JSON Schema rejects Worker fact uint63 overflow before mandatory runtime parsing', async () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validateFact = ajv.compile(bundle.schemas.WorkerInvocationFact as AnySchema);
    const envelope = (await readFixture('broker-invocation-prepared.v1.json')) as {
      body: Record<string, unknown>;
    };
    const { factDigest: _factDigest, ...fact } = envelope.body;

    expect(validateFact(fact)).toBe(true);
    expect(validateFact({ ...fact, fence: '9223372036854775808' })).toBe(false);
  });

  it('AJV and runtime enforce the ready fact uint63/source boundary at their respective layers', async () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validateFact = ajv.compile(bundle.schemas.WorkerConversationReadyFact as AnySchema);
    const envelope = (await readFixture('broker-conversation-ready.v1.json')) as {
      body: Record<string, unknown>;
    };
    const { factDigest: _factDigest, ...fact } = envelope.body;

    expect(validateFact(fact)).toBe(true);
    expect(validateFact({ ...fact, fence: '9223372036854775808' })).toBe(false);
    const wrongSource = {
      ...fact,
      sourceEventId: '0198f00d-5000-7000-8000-000000000099',
    };
    expect(validateFact(wrongSource)).toBe(true);
    expect(
      (await import('../conversation-ready-facts.js')).WorkerConversationReadyFactSchema.safeParse(
        wrongSource,
      ).success,
    ).toBe(false);
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
    expect(openapi.components.schemas.SnapshotUploadCreateResponse).toMatchObject({
      properties: {
        uploads: {
          properties: {
            archive: {
              properties: {
                cipherBytes: { maximum: 50 * 1024 * 1024 + 36 },
                requiredHeaders: {
                  properties: { 'x-amz-meta-object-kind': { enum: ['archive'] } },
                },
              },
            },
            manifest: {
              properties: {
                cipherBytes: { maximum: 4 * 1024 * 1024 + 36 },
                requiredHeaders: {
                  properties: { 'x-amz-meta-object-kind': { enum: ['manifest'] } },
                },
              },
            },
          },
        },
      },
    });
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
