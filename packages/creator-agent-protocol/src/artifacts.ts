import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentVersionManifestSchema } from './agent-version.js';
import {
  BROKER_MAX_FRAME_BYTES,
  BROKER_WORKER_CONNECT_PATH,
  CREATOR_BROKER_PROTOCOL,
  BrokerCloseCode,
  BrokerCloseReason,
  BrokerConversationOpenAuthoritySchema,
  BrokerConversationOpenCommandSchema,
  BrokerConversationOpenLogicalCommandSchema,
  BrokerEnvelopeSchema,
  BrokerHandshakeSchema,
  BrokerRegistrationCapabilitiesSchema,
  ExecutionCapabilitySchema,
  ExecutionCapabilityUnsignedSchema,
  ExecutionCapabilityUseRecordSchema,
} from './broker.js';
import { CANONICAL_JSON_IMPLEMENTATION, canonicalSha256 } from './canonical.js';
import {
  EvidenceCaseResultSchema,
  EvidenceCaseResultsSchema,
  EvidenceBundleIndexSchema,
  EvidenceBundleManifestSchema,
  EvidenceEnvironmentSchema,
  EvidenceEnvironmentsSchema,
  EvidencePrivacyScanSchema,
  EvidenceReleaseTupleSchema,
  EvidenceReviewerSignoffSchema,
} from './evidence.js';
import {
  AgentVersionViewSchema,
  AgentViewSchema,
  CancelInvocationRequestSchema,
  ConsumerEventSchema,
  ConversationTranscriptSchema,
  ConversationViewSchema,
  CreateAgentRequestSchema,
  CreateAgentVersionRequestSchema,
  CreateConversationRequestSchema,
  DeploymentMutationSchema,
  DeploymentViewSchema,
  InvocationAcceptedResponseSchema,
  InvocationViewSchema,
  RetryInvocationRequestSchema,
  SendConversationMessageRequestSchema,
  SnapshotPublicationCommitMarkerSchema,
  SnapshotPublicationPreparationMarkerSchema,
  SnapshotUploadCompleteRequestSchema,
  SnapshotUploadCreateRequestSchema,
  SnapshotUploadCreateResponseSchema,
  SnapshotUploadViewSchema,
} from './http.js';
import { InvocationTransitionSchema, VnextErrorResponseSchema } from './invocation.js';
import { WorkerInvocationFactSchema } from './invocation-facts.js';
import { WorkerConversationReadyFactSchema } from './conversation-ready-facts.js';
import {
  ConsumerEventOutboxRecordSchema,
  ConsumerEventStreamSchema,
  ConsumerTerminalEventPayloadSchema,
} from './consumer-events.js';
import {
  BrokerContractRegistrySchema,
  DataFlowAllowlistSchema,
  DecisionRegistrySchema,
  InvariantRegistrySchema,
  TestCaseRegistrySchema,
} from './registry.js';
import {
  SandboxAttestationSchema,
  SandboxAttestationUnsignedSchema,
  SandboxSpecSchema,
} from './sandbox.js';
import {
  SnapshotArchiveEnvelopeAadSchema,
  SnapshotArchiveEnvelopeSchema,
  SnapshotManifestEnvelopeAadSchema,
  SnapshotManifestEnvelopeSchema,
  SnapshotManifestSchema,
} from './snapshot.js';

export const ContractSchemaDefinitions = {
  AgentVersionManifest: AgentVersionManifestSchema,
  SnapshotManifest: SnapshotManifestSchema,
  SnapshotArchiveEnvelopeAad: SnapshotArchiveEnvelopeAadSchema,
  SnapshotArchiveEnvelope: SnapshotArchiveEnvelopeSchema,
  SnapshotManifestEnvelopeAad: SnapshotManifestEnvelopeAadSchema,
  SnapshotManifestEnvelope: SnapshotManifestEnvelopeSchema,
  SnapshotPublicationPreparationMarker: SnapshotPublicationPreparationMarkerSchema,
  SnapshotPublicationCommitMarker: SnapshotPublicationCommitMarkerSchema,
  BrokerRegistrationCapabilities: BrokerRegistrationCapabilitiesSchema,
  BrokerHandshake: BrokerHandshakeSchema,
  BrokerEnvelope: BrokerEnvelopeSchema,
  BrokerConversationOpenAuthority: BrokerConversationOpenAuthoritySchema,
  BrokerConversationOpenCommand: BrokerConversationOpenCommandSchema,
  BrokerConversationOpenLogicalCommand: BrokerConversationOpenLogicalCommandSchema,
  ExecutionCapabilityUnsigned: ExecutionCapabilityUnsignedSchema,
  ExecutionCapability: ExecutionCapabilitySchema,
  ExecutionCapabilityUseRecord: ExecutionCapabilityUseRecordSchema,
  InvocationTransition: InvocationTransitionSchema,
  WorkerInvocationFact: WorkerInvocationFactSchema,
  WorkerConversationReadyFact: WorkerConversationReadyFactSchema,
  VnextErrorResponse: VnextErrorResponseSchema,
  SandboxSpec: SandboxSpecSchema,
  SandboxAttestationUnsigned: SandboxAttestationUnsignedSchema,
  SandboxAttestation: SandboxAttestationSchema,
  SnapshotUploadCreateRequest: SnapshotUploadCreateRequestSchema,
  SnapshotUploadCreateResponse: SnapshotUploadCreateResponseSchema,
  SnapshotUploadCompleteRequest: SnapshotUploadCompleteRequestSchema,
  SnapshotUploadView: SnapshotUploadViewSchema,
  CreateAgentRequest: CreateAgentRequestSchema,
  AgentView: AgentViewSchema,
  CreateAgentVersionRequest: CreateAgentVersionRequestSchema,
  AgentVersionView: AgentVersionViewSchema,
  DeploymentMutation: DeploymentMutationSchema,
  DeploymentView: DeploymentViewSchema,
  CreateConversationRequest: CreateConversationRequestSchema,
  ConversationView: ConversationViewSchema,
  SendConversationMessageRequest: SendConversationMessageRequestSchema,
  InvocationAcceptedResponse: InvocationAcceptedResponseSchema,
  InvocationView: InvocationViewSchema,
  CancelInvocationRequest: CancelInvocationRequestSchema,
  RetryInvocationRequest: RetryInvocationRequestSchema,
  ConversationTranscript: ConversationTranscriptSchema,
  ConsumerEvent: ConsumerEventSchema,
  ConsumerTerminalEventPayload: ConsumerTerminalEventPayloadSchema,
  ConsumerEventOutboxRecord: ConsumerEventOutboxRecordSchema,
  ConsumerEventStream: ConsumerEventStreamSchema,
  EvidenceBundleManifest: EvidenceBundleManifestSchema,
  EvidenceBundleIndex: EvidenceBundleIndexSchema,
  EvidenceEnvironment: EvidenceEnvironmentSchema,
  EvidenceEnvironments: EvidenceEnvironmentsSchema,
  EvidencePrivacyScan: EvidencePrivacyScanSchema,
  EvidenceReleaseTuple: EvidenceReleaseTupleSchema,
  EvidenceCaseResult: EvidenceCaseResultSchema,
  EvidenceCaseResults: EvidenceCaseResultsSchema,
  EvidenceReviewerSignoff: EvidenceReviewerSignoffSchema,
  BrokerContractRegistry: BrokerContractRegistrySchema,
  InvariantRegistry: InvariantRegistrySchema,
  TestCaseRegistry: TestCaseRegistrySchema,
  DecisionRegistry: DecisionRegistrySchema,
  DataFlowAllowlist: DataFlowAllowlistSchema,
} as const;

const RuntimeSemanticConstraints: Partial<
  Record<keyof typeof ContractSchemaDefinitions, readonly string[]>
> = {
  SnapshotArchiveEnvelopeAad: [
    'objectKey == snapshotArchiveObjectKey(creatorId,snapshotDigest)',
    'all consumers MUST pass the authoritative runtime SnapshotArchiveEnvelopeAadSchema parser after structural JSON Schema validation',
  ],
  SnapshotArchiveEnvelope: [
    'aadDigest == sha256(JCS(aad))',
    'cipherObjectFormat == aad.cipherObjectFormat',
    'cipherBytes == aad.plaintextBytes + 36',
    'cipher object == ASCII("CSNPENC1") || nonce[12] || ciphertext[aad.plaintextBytes] || authTag[16]',
    'cipherDigest == sha256(exact whole cipher object)',
    'envelope nonce/authTag MUST equal the cipher object segments byte-for-byte',
    'all consumers MUST pass the authoritative runtime SnapshotArchiveEnvelopeSchema parser after structural JSON Schema validation',
    'all cipher object consumers MUST pass parseSnapshotArchiveCipherObject(envelope,objectBytes) before unwrap or decrypt',
  ],
  SnapshotManifestEnvelopeAad: [
    'objectKey == snapshotManifestObjectKey(creatorId,snapshotDigest)',
    'all consumers MUST pass the authoritative runtime SnapshotManifestEnvelopeAadSchema parser after structural JSON Schema validation',
  ],
  SnapshotManifestEnvelope: [
    'aadDigest == sha256(JCS(aad))',
    'cipherObjectFormat == aad.cipherObjectFormat',
    'cipherBytes == aad.plaintextBytes + 36',
    'cipher object == ASCII("CSNPMAN1") || nonce[12] || ciphertext[aad.plaintextBytes] || authTag[16]',
    'cipherDigest == sha256(exact whole manifest cipher object)',
    'envelope nonce/authTag MUST equal the manifest cipher object segments byte-for-byte',
    'archive and manifest envelopes MUST bind the same creatorId/snapshotDigest/keyId/wrappedDek and distinct nonces',
    'all consumers MUST pass the authoritative runtime SnapshotManifestEnvelopeSchema parser after structural JSON Schema validation',
    'all manifest cipher object consumers MUST pass parseSnapshotManifestCipherObject(envelope,objectBytes) before unwrap, decrypt, or JSON parse',
  ],
  SnapshotUploadCreateRequest: [
    'archive.checksumSha256 == canonicalBase64(hexToBytes(archive.envelope.cipherDigest))',
    'manifest.checksumSha256 == canonicalBase64(hexToBytes(manifest.envelope.cipherDigest))',
    'archive and manifest envelopes MUST bind the same creatorId/snapshotDigest/keyId/wrappedDek and distinct nonces',
    'the Worker MUST finish both cipher objects before constructing this request',
    'all consumers MUST pass the authoritative runtime SnapshotUploadCreateRequestSchema parser after structural JSON Schema validation',
  ],
  SnapshotUploadCreateResponse: [
    'each target requiredHeaders MUST bind exact cipherBytes/cipherDigest/checksum/object-kind and include no unknown header',
    'archive and manifest targets MUST bind the same snapshotDigest/archiveDigest and distinct temp object locators',
    'archive cipherBytes <= SNAPSHOT_MAX_COMPRESSED_BYTES + 36 and manifest cipherBytes <= SNAPSHOT_MAX_MANIFEST_BYTES + 36',
    'public Authoring responses MUST use HTTPS; insecure loopback is only an explicit disposable component-test authority',
    'all consumers MUST pass the authoritative runtime SnapshotUploadCreateResponseSchema parser after structural JSON Schema validation',
  ],
  SnapshotPublicationPreparationMarker: [
    'creatorId/snapshotDigest MUST equal request archive and manifest Envelope identity',
    'selectedUploadId identifies only derived tenant temp keys and MUST NOT admit an arbitrary object key',
    'the marker MUST be exact bounded RFC 8785 JCS bytes and written only after full dual-object AEAD and plaintext verification',
    'wrappedDek/keyId are private verifier/recovery control metadata and MUST NOT enter S3 user metadata, URLs, logs, browser, Gateway, or model input',
  ],
  SnapshotPublicationCommitMarker: [
    'preparationKey == snapshotPublicationPreparationObjectKey(creatorId,snapshotDigest)',
    'preparationDigest == sha256(exact canonical preparation marker bytes)',
    'the commit marker MUST be written with If-None-Match only after both selected final objects read back and verify',
    'readers MUST treat absence of this marker as unpublished even when preparation or final objects exist',
  ],
  BrokerRegistrationCapabilities: [
    'brokerContractDigest is singular, required, and MUST equal currentBrokerContractDigest()',
    'registration capabilities MUST pass BrokerRegistrationCapabilitiesSchema with no unknown key',
  ],
  BrokerHandshake: [
    'brokerContractDigest is part of brokerHandshakeSigningBytes and MUST equal currentBrokerContractDigest()',
    'codexRuntimeArtifacts/codexProtocolSchemaDigests/isolationModes/brokerContractDigest MUST exactly match the registered BrokerRegistrationCapabilities',
    'all Broker handshakes MUST pass the authoritative runtime BrokerHandshakeSchema parser after structural JSON Schema validation',
  ],
  BrokerEnvelope: [
    `sensitive.cipherDigest == sha256(JCS({protocol:"${CREATOR_BROKER_PROTOCOL}",schemaVersion:1,nonce,ciphertext,authTag}))`,
    'sensitive.aadDigest == sha256(JCS(sensitive.aad))',
    'sensitive.keyId == sensitive.aad.keyId',
    'sensitive.aad.envelopeType == type',
    'sensitive.aad.messageId == messageId',
    'sensitive.aad.conversationId == body.conversationId',
    'sensitive.aad.invocationId == body.invocationId',
    'sensitive.aad.workerSessionId == lease.workerSessionId',
    'sensitive.aad.role == USER for invocation.prepare, ASSISTANT otherwise',
    'conversation.ready body.factDigest == sha256(JCS(exact combo.worker-conversation-ready-fact/1 fields))',
    'conversation.ready sourceEventId == openCommandId, sourceEventId != re-envelope messageId, and correlationId == conversationId',
    'conversation.ready fact installationId/workerSessionId/leaseId/fence bind original open authority and MAY differ from the current outer transport authority after authorized re-enveloping',
    'conversation.open correlationId == body.conversationId and messageId != correlationId',
    'conversation.open lease.deploymentId == body.openAuthority.deploymentId',
    'conversation.open body.openAuthority is immutable while outer connection/sequence/time/session/lease/fence MAY change after authorized re-enveloping',
    'Worker invocation event body.factDigest == sha256(JCS(exact combo.worker-invocation-fact/1 fields))',
    'Worker invocation sourceEventId == prepareCommandId for prepared, startCommandId for started, and invocationId for terminal facts; it MUST NOT equal the re-envelope messageId',
    'Worker invocation fact leaseId/fence bind original execution authority and MAY differ from the current outer transport lease after authorized re-enveloping',
    'prepared/started commandId == correlationId; delta and terminal correlationId == invocationId',
    'all Broker frames MUST pass the authoritative runtime BrokerEnvelopeSchema parser after structural JSON Schema validation',
  ],
  BrokerConversationOpenCommand: [
    'correlationId == body.conversationId and messageId != correlationId',
    'lease.deploymentId == body.openAuthority.deploymentId',
    'body.openAuthority binds the original deployment/installation/session/lease/fence authority',
    'outer connectionId/sequence/sentAt/expiresAt/leaseId/workerSessionId/fence MAY change after authorized re-enveloping',
    'all conversation.open commands MUST pass BrokerConversationOpenCommandSchema',
  ],
  BrokerConversationOpenLogicalCommand: [
    'logical digest preimage contains only protocol/schemaVersion/kind/type/messageId/correlationId/body',
    'connectionId/sequence/sentAt/expiresAt/current outer lease are excluded from the logical digest',
  ],
  BrokerContractRegistry: [
    'contracts[0].contractDigest == currentBrokerContractDigest()',
    'contracts[0].artifactPath identifies the checked standalone Broker contract artifact',
  ],
  WorkerInvocationFact: [
    'sourceEventId == prepareCommandId for prepared, startCommandId for started, and invocationId for succeeded/failed/cancelled/uncertain',
    'leaseId/fence bind the original execution authority and remain immutable across Broker reconnection/re-enveloping',
    'started stores exact runtimeThreadId/runtimeTurnId query handles; succeeded repeats both handles and binds startedFactDigest',
    'fence MUST be a canonical decimal string in the exact uint63 range 0..9223372036854775807',
    'all Worker Invocation facts MUST pass the authoritative runtime WorkerInvocationFactSchema parser after structural JSON Schema validation',
  ],
  WorkerConversationReadyFact: [
    'sourceEventId == openCommandId and remains stable across Broker reconnection/re-enveloping',
    'installationId/workerSessionId/leaseId/fence bind the original conversation.open authority and remain immutable',
    'fence MUST be a canonical decimal string in the exact uint63 range 0..9223372036854775807',
    'all Worker Conversation Ready facts MUST pass the authoritative runtime WorkerConversationReadyFactSchema parser after structural JSON Schema validation',
  ],
  ConsumerEventOutboxRecord: [
    'payload.conversationId == conversationId',
    'payload.invocationId == invocationId',
    'payloadDigest == sha256(JCS(payload))',
    'dedupeKey == sha256(JCS(protocol,ownerId,sourceEventId,eventType))',
    'retainedUntil == createdAt + 7 days',
  ],
};

function attachRuntimeSemanticConstraints(
  name: keyof typeof ContractSchemaDefinitions,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const constraints = RuntimeSemanticConstraints[name];
  return constraints === undefined
    ? schema
    : { ...schema, 'x-combo-runtime-constraints': [...constraints] };
}

export function createJsonSchemaBundle(): Record<string, unknown> {
  return {
    protocol: 'combo.creator-agent-contract-schemas/1',
    schemaVersion: 1,
    schemas: Object.fromEntries(
      Object.entries(ContractSchemaDefinitions).map(([name, schema]) => [
        name,
        attachRuntimeSemanticConstraints(
          name as keyof typeof ContractSchemaDefinitions,
          zodToJsonSchema(schema, {
            name,
            target: 'jsonSchema7',
            $refStrategy: 'root',
          }) as Record<string, unknown>,
        ),
      ]),
    ),
  };
}

export const CREATOR_BROKER_CONTRACT_PROTOCOL = 'combo.creator-broker-contract/1' as const;

const BrokerContractSchemaNames = [
  'BrokerRegistrationCapabilities',
  'BrokerHandshake',
  'BrokerEnvelope',
  'BrokerConversationOpenAuthority',
  'BrokerConversationOpenCommand',
  'BrokerConversationOpenLogicalCommand',
] as const satisfies readonly (keyof typeof ContractSchemaDefinitions)[];

/** Standalone Broker wire contract. It intentionally contains no current digest value. */
export function createBrokerContractArtifact(): Record<string, unknown> {
  return {
    protocol: CREATOR_BROKER_CONTRACT_PROTOCOL,
    schemaVersion: 1,
    wireProtocol: CREATOR_BROKER_PROTOCOL,
    canonicalization: CANONICAL_JSON_IMPLEMENTATION,
    connectPath: BROKER_WORKER_CONNECT_PATH,
    maxFrameBytes: BROKER_MAX_FRAME_BYTES,
    closeCodes: { ...BrokerCloseCode },
    closeReasons: { ...BrokerCloseReason },
    schemas: Object.fromEntries(
      BrokerContractSchemaNames.map((name) => [
        name,
        zodToJsonSchema(ContractSchemaDefinitions[name], {
          name,
          target: 'jsonSchema7',
          $refStrategy: 'root',
        }) as Record<string, unknown>,
      ]),
    ),
    runtimeConstraints: Object.fromEntries(
      BrokerContractSchemaNames.map((name) => [
        name,
        [...(RuntimeSemanticConstraints[name] ?? [])],
      ]),
    ),
  };
}

/** RFC 8785 digest advertised by registration and signed Broker handshakes. */
export function currentBrokerContractDigest(): `sha256:${string}` {
  return `sha256:${canonicalSha256(createBrokerContractArtifact())}`;
}

function openApiSchema(name: keyof typeof ContractSchemaDefinitions): Record<string, unknown> {
  const converted = attachRuntimeSemanticConstraints(
    name,
    zodToJsonSchema(ContractSchemaDefinitions[name], {
      target: 'openApi3',
      $refStrategy: 'none',
    }) as Record<string, unknown>,
  );
  delete converted.$schema;
  return converted;
}

const jsonContent = (schemaName: string) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } },
});

const requestBody = (schemaName: string) => ({ required: true, content: jsonContent(schemaName) });

const response = (description: string, schemaName: string, status = '200') => ({
  [status]: { description, content: jsonContent(schemaName) },
  default: { description: '稳定错误信封', content: jsonContent('VnextErrorResponse') },
});

const idempotencyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

export function createOpenApiDocument(): Record<string, unknown> {
  const componentNames = [
    'SnapshotUploadCreateRequest',
    'SnapshotUploadCreateResponse',
    'SnapshotUploadCompleteRequest',
    'SnapshotUploadView',
    'CreateAgentRequest',
    'AgentView',
    'CreateAgentVersionRequest',
    'AgentVersionView',
    'DeploymentMutation',
    'DeploymentView',
    'CreateConversationRequest',
    'ConversationView',
    'SendConversationMessageRequest',
    'InvocationAcceptedResponse',
    'InvocationView',
    'CancelInvocationRequest',
    'RetryInvocationRequest',
    'ConversationTranscript',
    'ConsumerEvent',
    'ConsumerTerminalEventPayload',
    'VnextErrorResponse',
  ] as const;

  return {
    openapi: '3.1.0',
    info: {
      title: 'Combo Creator-hosted Agent VNext API',
      version: '1.0.0-alpha.1',
      description:
        'Creator/Consumer HTTP contract. All IDs are control-plane data and never model input.',
    },
    servers: [{ url: 'https://test.example.invalid' }],
    security: [{ creatorOAuth: [] }],
    paths: {
      '/v1/creator/snapshot-uploads': {
        post: {
          operationId: 'createSnapshotUpload',
          parameters: [idempotencyHeader],
          requestBody: requestBody('SnapshotUploadCreateRequest'),
          responses: response(
            '已创建绑定对象和校验和的上传会话',
            'SnapshotUploadCreateResponse',
            '201',
          ),
        },
      },
      '/v1/creator/snapshot-uploads/{uploadId}:complete': {
        post: {
          operationId: 'completeSnapshotUpload',
          parameters: [
            {
              name: 'uploadId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            idempotencyHeader,
          ],
          requestBody: requestBody('SnapshotUploadCompleteRequest'),
          responses: response('上传进入 VERIFYING', 'SnapshotUploadView', '202'),
        },
      },
      '/v1/creator/agents': {
        post: {
          operationId: 'createAgent',
          parameters: [idempotencyHeader],
          requestBody: requestBody('CreateAgentRequest'),
          responses: response('已创建 Agent', 'AgentView', '201'),
        },
      },
      '/v1/creator/agents/{agentId}/versions': {
        post: {
          operationId: 'createAgentVersion',
          parameters: [
            {
              name: 'agentId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            idempotencyHeader,
          ],
          requestBody: requestBody('CreateAgentVersionRequest'),
          responses: response('已创建或复用不可变 AgentVersion', 'AgentVersionView', '201'),
        },
      },
      '/v1/creator/agents/{agentId}/versions/{versionId}': {
        get: {
          operationId: 'getAgentVersion',
          parameters: [
            {
              name: 'agentId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'versionId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: response('不可变 AgentVersion 视图', 'AgentVersionView'),
        },
      },
      '/v1/creator/agents/{agentId}/deployment': {
        put: {
          operationId: 'updateAgentDeployment',
          parameters: [
            {
              name: 'agentId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            idempotencyHeader,
            {
              name: 'If-Match',
              in: 'header',
              required: true,
              schema: { type: 'string', pattern: '^"generation-[0-9]+"$' },
            },
          ],
          requestBody: requestBody('DeploymentMutation'),
          responses: response(
            '已接受 desired state；observed state 由 Worker 事实更新',
            'DeploymentView',
            '202',
          ),
        },
      },
      '/v1/public/agents/{slug}/conversations': {
        post: {
          operationId: 'createConversation',
          security: [{ consumerSession: [] }],
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
            idempotencyHeader,
          ],
          requestBody: requestBody('CreateConversationRequest'),
          responses: response(
            'Conversation 已原子固定 serving AgentVersion',
            'ConversationView',
            '201',
          ),
        },
      },
      '/v1/conversations/{conversationId}': {
        get: {
          operationId: 'getConversationTranscript',
          security: [{ consumerSession: [] }],
          parameters: [
            {
              name: 'conversationId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: response('权威 transcript 与最新 durable cursor', 'ConversationTranscript'),
        },
      },
      '/v1/conversations/{conversationId}/messages': {
        post: {
          operationId: 'sendConversationMessage',
          security: [{ consumerSession: [] }],
          parameters: [
            {
              name: 'conversationId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            idempotencyHeader,
          ],
          requestBody: requestBody('SendConversationMessageRequest'),
          responses: response(
            '请求与 Outbox 已在 PostgreSQL 原子提交',
            'InvocationAcceptedResponse',
            '202',
          ),
        },
      },
      '/v1/conversations/{conversationId}/events': {
        get: {
          operationId: 'streamConversationEvents',
          security: [{ consumerSession: [] }],
          parameters: [
            {
              name: 'conversationId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'Last-Event-ID',
              in: 'header',
              required: false,
              schema: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
            },
          ],
          responses: {
            '200': {
              description: 'SSE；delta 可丢，terminal/final 可从 PostgreSQL 恢复',
              content: {
                'text/event-stream': { schema: { $ref: '#/components/schemas/ConsumerEvent' } },
              },
            },
            default: { description: '稳定错误信封', content: jsonContent('VnextErrorResponse') },
          },
        },
      },
      '/v1/invocations/{invocationId}': {
        get: {
          operationId: 'getInvocation',
          security: [{ consumerSession: [] }],
          parameters: [
            {
              name: 'invocationId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: response('Invocation 当前权威状态', 'InvocationView'),
        },
      },
      '/v1/invocations/{invocationId}:cancel': {
        post: {
          operationId: 'cancelInvocation',
          security: [{ consumerSession: [] }],
          parameters: [
            {
              name: 'invocationId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            idempotencyHeader,
          ],
          requestBody: requestBody('CancelInvocationRequest'),
          responses: response('已记录取消请求；不等同于已取消', 'InvocationView', '202'),
        },
      },
      '/v1/invocations/{invocationId}:retry': {
        post: {
          operationId: 'retryInvocation',
          security: [{ consumerSession: [] }],
          parameters: [
            {
              name: 'invocationId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            idempotencyHeader,
          ],
          requestBody: requestBody('RetryInvocationRequest'),
          responses: response('已创建关联的新 Invocation', 'InvocationAcceptedResponse', '202'),
        },
      },
    },
    components: {
      securitySchemes: {
        creatorOAuth: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: '/oauth/authorize',
              tokenUrl: '/oauth/token',
              scopes: {},
            },
          },
        },
        consumerSession: { type: 'apiKey', in: 'cookie', name: '__Host-cb_session' },
      },
      schemas: Object.fromEntries(componentNames.map((name) => [name, openApiSchema(name)])),
    },
  };
}
