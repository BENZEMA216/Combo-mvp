import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentVersionManifestSchema } from './agent-version.js';
import {
  BrokerEnvelopeSchema,
  BrokerHandshakeSchema,
  ExecutionCapabilitySchema,
  ExecutionCapabilityUnsignedSchema,
  ExecutionCapabilityUseRecordSchema,
} from './broker.js';
import {
  EvidenceBundleIndexSchema,
  EvidenceBundleManifestSchema,
  EvidenceEnvironmentSchema,
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
  SnapshotUploadCompleteRequestSchema,
  SnapshotUploadCreateRequestSchema,
  SnapshotUploadCreateResponseSchema,
  SnapshotUploadViewSchema,
} from './http.js';
import { InvocationTransitionSchema, VnextErrorResponseSchema } from './invocation.js';
import {
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
import { SnapshotManifestSchema } from './snapshot.js';

export const ContractSchemaDefinitions = {
  AgentVersionManifest: AgentVersionManifestSchema,
  SnapshotManifest: SnapshotManifestSchema,
  BrokerHandshake: BrokerHandshakeSchema,
  BrokerEnvelope: BrokerEnvelopeSchema,
  ExecutionCapabilityUnsigned: ExecutionCapabilityUnsignedSchema,
  ExecutionCapability: ExecutionCapabilitySchema,
  ExecutionCapabilityUseRecord: ExecutionCapabilityUseRecordSchema,
  InvocationTransition: InvocationTransitionSchema,
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
  EvidenceBundleManifest: EvidenceBundleManifestSchema,
  EvidenceBundleIndex: EvidenceBundleIndexSchema,
  EvidenceEnvironment: EvidenceEnvironmentSchema,
  InvariantRegistry: InvariantRegistrySchema,
  TestCaseRegistry: TestCaseRegistrySchema,
  DecisionRegistry: DecisionRegistrySchema,
  DataFlowAllowlist: DataFlowAllowlistSchema,
} as const;

export function createJsonSchemaBundle(): Record<string, unknown> {
  return {
    protocol: 'combo.creator-agent-contract-schemas/1',
    schemaVersion: 1,
    schemas: Object.fromEntries(
      Object.entries(ContractSchemaDefinitions).map(([name, schema]) => [
        name,
        zodToJsonSchema(schema, { name, target: 'jsonSchema7', $refStrategy: 'root' }),
      ]),
    ),
  };
}

function openApiSchema(name: keyof typeof ContractSchemaDefinitions): Record<string, unknown> {
  const converted = zodToJsonSchema(ContractSchemaDefinitions[name], {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
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
