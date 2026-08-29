import type { ProjectHistoryAgentService } from './service.js';
import {
  ProjectHistoryAgentCandidateValidationError,
  ProjectHistoryAgentServiceError,
} from './service.js';
import {
  CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_OMITTED_THREADS,
  CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_SELECTED_THREADS,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { ZodError } from 'zod';
import {
  PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE,
  type ProjectHistoryAgentToolName,
} from './contracts.js';
import { PROJECT_HISTORY_AGENT_DRAFT_APP_URI } from './draft-app.js';

type JsonSchema = Readonly<Record<string, unknown>>;

const DIGEST = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } as const;
const UUID = { type: 'string', format: 'uuid' } as const;
const DRAFT_ID = {
  type: 'string',
  pattern: '^draft\\.agent-package\\.[0-9a-f]{32}$',
} as const;
const CONFIRMATION_TOKEN = {
  type: 'string',
  pattern: '^cfrm_[A-Za-z0-9_-]{43}$',
} as const;
const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'instructions', 'starterPrompts', 'outputDescription'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: 'string', minLength: 1, maxLength: 500 },
    instructions: { type: 'string', minLength: 1, maxLength: 8_000 },
    starterPrompts: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
    },
    outputDescription: { type: 'string', minLength: 1, maxLength: 1_000 },
  },
} as const;
const SOURCE_EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'selection',
    'assurance',
    'completeness',
    'hostAttestation',
    'sourceProjectionEnforced',
    'rawStored',
    'projectCount',
    'discoveredThreadCount',
    'readThreadCount',
    'omittedThreadCount',
    'completedTurnCount',
    'userVisibleMessageCount',
    'omittedItemCount',
    'limitationReasons',
  ],
  properties: {
    kind: { type: 'string', const: 'host_project_scoped_reduced_history' },
    selection: { type: 'string', const: 'user_selected_saved_project' },
    assurance: { type: 'string', const: 'best_effort' },
    completeness: { type: 'string', const: 'not_proven' },
    hostAttestation: { type: 'string', const: 'not_proven' },
    sourceProjectionEnforced: { type: 'string', const: 'not_proven' },
    rawStored: { type: 'boolean', const: false },
    projectCount: { type: 'integer', const: 1 },
    discoveredThreadCount: {
      type: 'integer',
      minimum: 1,
      maximum: CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_SELECTED_THREADS,
      description: 'Eligible same-Project Codex tasks selected for bounded reading (maximum 20).',
    },
    readThreadCount: {
      type: 'integer',
      minimum: 1,
      maximum: CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_SELECTED_THREADS,
      description:
        'Selected eligible tasks read through their final available page; must equal discoveredThreadCount.',
    },
    omittedThreadCount: {
      type: 'integer',
      minimum: 0,
      maximum: CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_OMITTED_THREADS,
      description:
        'All remaining matching or non-Codex tasks in the selected Project, including pinned overflow (maximum 10000).',
    },
    completedTurnCount: { type: 'integer', minimum: 1, maximum: 10_000 },
    userVisibleMessageCount: { type: 'integer', minimum: 1, maximum: 20_000 },
    omittedItemCount: { type: 'integer', minimum: 0, maximum: 20_000 },
    limitationReasons: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: [
        { type: 'string', const: 'READ_OUTPUT_BOUNDED_OR_TRUNCATED' },
        { type: 'string', const: 'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT' },
        { type: 'string', const: 'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED' },
      ],
      additionalItems: false,
    },
  },
} as const;

const DRAFT_REF_PROPERTIES = {
  draftId: DRAFT_ID,
  draftFingerprint: DIGEST,
} as const;

const CREATE_DRAFT_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['creatorRequest', 'candidate', 'sourceEvidence', 'idempotencyKey'],
  properties: {
    creatorRequest: { type: 'string', minLength: 1, maxLength: 2_000 },
    candidate: CANDIDATE_SCHEMA,
    sourceEvidence: SOURCE_EVIDENCE_SCHEMA,
    idempotencyKey: UUID,
  },
} as const;

const RENDER_DRAFT_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['draftId', 'draftFingerprint'],
  properties: DRAFT_REF_PROPERTIES,
} as const;

const CREATE_SHARE_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['draftId', 'draftFingerprint', 'confirmationToken', 'idempotencyKey'],
  properties: {
    ...DRAFT_REF_PROPERTIES,
    confirmationToken: CONFIRMATION_TOKEN,
    idempotencyKey: UUID,
  },
} as const;

const READ_SHARE_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['shareUrl'],
  properties: {
    shareUrl: { type: 'string', format: 'uri', maxLength: 2_048 },
  },
} as const;

const PREPARE_RUN_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['shareUrl', 'packageDigest', 'starterOrdinal', 'starterPrompt'],
  properties: {
    ...READ_SHARE_INPUT.properties,
    packageDigest: DIGEST,
    starterOrdinal: { type: 'integer', minimum: 1, maximum: 5 },
    starterPrompt: { type: 'string', minLength: 1, maxLength: 1_000 },
  },
} as const;

const CREATOR_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['protocol', 'intent', 'request'],
  properties: {
    protocol: { type: 'string', const: 'combo.agent-package-creator-request/3' },
    intent: { type: 'string', const: 'create_agent_package_from_project_task_history' },
    request: { type: 'string', minLength: 1, maxLength: 2_000 },
  },
} as const;
const DRAFT_SOURCE_SCHEMA = {
  ...SOURCE_EVIDENCE_SCHEMA,
  required: [...SOURCE_EVIDENCE_SCHEMA.required, 'candidateCommitment'],
  properties: { ...SOURCE_EVIDENCE_SCHEMA.properties, candidateCommitment: DIGEST },
} as const;
const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'protocol',
    'draftId',
    'revision',
    'parentDraftFingerprint',
    'creatorRequest',
    'source',
    'content',
    'draftFingerprint',
  ],
  properties: {
    protocol: { type: 'string', const: 'combo.agent-package-draft/3' },
    draftId: DRAFT_ID,
    revision: { type: 'integer', const: 1 },
    parentDraftFingerprint: { type: 'null', const: null },
    creatorRequest: CREATOR_REQUEST_SCHEMA,
    source: DRAFT_SOURCE_SCHEMA,
    content: CANDIDATE_SCHEMA,
    draftFingerprint: DIGEST,
  },
} as const;
const PACKAGE_RESOURCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'byteLength', 'digest'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 240 },
    byteLength: { type: 'integer', minimum: 1, maximum: 2 * 1_024 * 1_024 },
    digest: DIGEST,
  },
} as const;
const PACKAGE_MANIFEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['protocol', 'name', 'description', 'instructions', 'skills', 'files'],
  properties: {
    protocol: { type: 'string', const: 'combo.agent-package/1' },
    name: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: 'string', minLength: 1, maxLength: 500 },
    instructions: { type: 'string', const: 'AGENT.md' },
    skills: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 256,
      items: PACKAGE_RESOURCE_SCHEMA,
    },
  },
} as const;
const PACKAGE_BYTE_FILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'contentBase64'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 240 },
    contentBase64: { type: 'string', minLength: 1, maxLength: 2_796_208 },
  },
} as const;
const PACKAGE_BUNDLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['manifest', 'files'],
  properties: {
    manifest: PACKAGE_MANIFEST_SCHEMA,
    files: { type: 'array', minItems: 1, maxItems: 256, items: PACKAGE_BYTE_FILE_SCHEMA },
  },
} as const;
const SHARE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'releaseId',
    'sourceDraftFingerprint',
    'packageDigest',
    'package',
    'starterPrompts',
    'createdAt',
  ],
  properties: {
    schemaVersion: { type: 'string', const: 'combo.agent-package-share/2' },
    releaseId: { type: 'string', pattern: '^release\\.agent-package\\.[0-9a-f]{32}$' },
    sourceDraftFingerprint: DIGEST,
    packageDigest: DIGEST,
    package: PACKAGE_BUNDLE_SCHEMA,
    starterPrompts: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;
const RELEASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['protocol', 'releaseId', 'packageDigest'],
  properties: {
    protocol: { type: 'string', const: 'combo.agent-package-release/1' },
    releaseId: { type: 'string', pattern: '^release\\.agent-package\\.[0-9a-f]{32}$' },
    packageDigest: DIGEST,
  },
} as const;
const RUN_COMPATIBILITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['creatorProjectRequired', 'delivery', 'hostInstalledEnforcement'],
  properties: {
    creatorProjectRequired: { type: 'boolean', const: false },
    delivery: { type: 'string', const: 'server_verified_cleartext_runtime_projection' },
    hostInstalledEnforcement: { type: 'string', const: 'not_proven' },
  },
} as const;
const EXECUTION_BOUNDARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['delivery', 'receiverProjectSelection', 'hostInstalledEnforcement'],
  properties: {
    delivery: { type: 'string', const: 'server_verified_cleartext_runtime_projection' },
    receiverProjectSelection: { type: 'string', const: 'user_selected_in_host' },
    hostInstalledEnforcement: { type: 'string', const: 'not_proven' },
  },
} as const;
const RUNTIME_MATERIAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'agentMarkdown',
    'agentMarkdownDigest',
    'skillPath',
    'skillMarkdown',
    'skillMarkdownDigest',
    'runtimeProjectionDigest',
  ],
  properties: {
    agentMarkdown: { type: 'string', minLength: 1, maxLength: 32_768 },
    agentMarkdownDigest: DIGEST,
    skillPath: { type: 'string', minLength: 1, maxLength: 240 },
    skillMarkdown: { type: 'string', minLength: 1, maxLength: 32_768 },
    skillMarkdownDigest: DIGEST,
    runtimeProjectionDigest: DIGEST,
  },
} as const;
const CREATE_DRAFT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'created', 'draft'],
  properties: {
    schemaVersion: { type: 'string', const: 'combo.agent-package-draft-result/1' },
    created: { type: 'boolean' },
    draft: DRAFT_SCHEMA,
  },
} as const;
const SOURCE_DISCLOSURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'assurance',
    'selection',
    'completeness',
    'hostAttestation',
    'sourceProjectionEnforced',
    'rawStored',
    'projectCount',
    'discoveredThreadCount',
    'readThreadCount',
    'omittedThreadCount',
    'completedTurnCount',
    'userVisibleMessageCount',
    'omittedItemCount',
    'limitationReasons',
  ],
  properties: {
    kind: SOURCE_EVIDENCE_SCHEMA.properties.kind,
    assurance: SOURCE_EVIDENCE_SCHEMA.properties.assurance,
    selection: SOURCE_EVIDENCE_SCHEMA.properties.selection,
    completeness: SOURCE_EVIDENCE_SCHEMA.properties.completeness,
    hostAttestation: SOURCE_EVIDENCE_SCHEMA.properties.hostAttestation,
    sourceProjectionEnforced: SOURCE_EVIDENCE_SCHEMA.properties.sourceProjectionEnforced,
    rawStored: SOURCE_EVIDENCE_SCHEMA.properties.rawStored,
    projectCount: SOURCE_EVIDENCE_SCHEMA.properties.projectCount,
    discoveredThreadCount: SOURCE_EVIDENCE_SCHEMA.properties.discoveredThreadCount,
    readThreadCount: SOURCE_EVIDENCE_SCHEMA.properties.readThreadCount,
    omittedThreadCount: SOURCE_EVIDENCE_SCHEMA.properties.omittedThreadCount,
    completedTurnCount: SOURCE_EVIDENCE_SCHEMA.properties.completedTurnCount,
    userVisibleMessageCount: SOURCE_EVIDENCE_SCHEMA.properties.userVisibleMessageCount,
    omittedItemCount: SOURCE_EVIDENCE_SCHEMA.properties.omittedItemCount,
    limitationReasons: SOURCE_EVIDENCE_SCHEMA.properties.limitationReasons,
  },
} as const;
const CARD_ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'message', 'emphasis'],
  properties: {
    id: { type: 'string', const: 'confirm_create_agent_package_share' },
    label: { type: 'string', const: '确认创建公开且不可撤回的分享' },
    message: { type: 'string', const: PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE },
    emphasis: { type: 'string', const: 'primary' },
  },
} as const;
const RENDER_DRAFT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'draft', 'cardSnapshot', 'actions', 'confirmation'],
  properties: {
    schemaVersion: { type: 'string', const: 'combo.agent-package-draft-card/1' },
    draft: DRAFT_SCHEMA,
    cardSnapshot: {
      type: 'object',
      additionalProperties: false,
      required: ['stage', 'title', 'summary', 'sourceDisclosure', 'shareDisclosure', 'content'],
      properties: {
        stage: { type: 'string', const: 'draft' },
        title: { type: 'string', minLength: 1, maxLength: 80 },
        summary: { type: 'string', minLength: 1, maxLength: 1_000 },
        sourceDisclosure: SOURCE_DISCLOSURE_SCHEMA,
        shareDisclosure: {
          type: 'object',
          additionalProperties: false,
          required: ['access', 'revocation', 'expiry', 'marketplacePublication'],
          properties: {
            access: { type: 'string', const: 'public_by_link' },
            revocation: { type: 'string', const: 'not_supported' },
            expiry: { type: 'string', const: 'none' },
            marketplacePublication: { type: 'boolean', const: false },
          },
        },
        content: CANDIDATE_SCHEMA,
      },
    },
    actions: { type: 'array', minItems: 1, maxItems: 1, items: CARD_ACTION_SCHEMA },
    confirmation: {
      type: 'object',
      additionalProperties: false,
      required: ['scheme', 'confirmationToken', 'expiresAt'],
      properties: {
        scheme: { type: 'string', const: 'combo.agent-package-share-confirmation/1' },
        confirmationToken: CONFIRMATION_TOKEN,
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;
const SHARE_RESULT_COMMON_PROPERTIES = {
  schemaVersion: { type: 'string', const: 'combo.agent-package-share-result/2' },
  release: RELEASE_SCHEMA,
  share: SHARE_SCHEMA,
  package: PACKAGE_BUNDLE_SCHEMA,
  packageManifest: PACKAGE_MANIFEST_SCHEMA,
  packageDigest: DIGEST,
  shareUrl: { type: 'string', format: 'uri', maxLength: 2_048 },
  copyPrompt: { type: 'string', minLength: 1, maxLength: 4_096 },
  runCompatibility: RUN_COMPATIBILITY_SCHEMA,
} as const;
const SHARE_RESULT_REQUIRED = [
  'schemaVersion',
  'release',
  'share',
  'package',
  'packageManifest',
  'packageDigest',
  'shareUrl',
  'copyPrompt',
  'runCompatibility',
] as const;
const CREATE_SHARE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['created', ...SHARE_RESULT_REQUIRED],
  properties: { created: { type: 'boolean' }, ...SHARE_RESULT_COMMON_PROPERTIES },
} as const;
const READ_SHARE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: SHARE_RESULT_REQUIRED,
  properties: SHARE_RESULT_COMMON_PROPERTIES,
} as const;
const PREPARE_RUN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'shareUrl',
    'packageDigest',
    'starterOrdinal',
    'starterPrompt',
    'sourceDraftFingerprint',
    'runtimeMaterial',
    'executionBoundary',
    'launchPrompt',
    'runEnvelope',
  ],
  properties: {
    schemaVersion: { type: 'string', const: 'combo.agent-package-run-preparation/2' },
    shareUrl: { type: 'string', format: 'uri', maxLength: 2_048 },
    packageDigest: DIGEST,
    starterOrdinal: { type: 'integer', minimum: 1, maximum: 5 },
    starterPrompt: { type: 'string', minLength: 1, maxLength: 1_000 },
    sourceDraftFingerprint: DIGEST,
    runtimeMaterial: RUNTIME_MATERIAL_SCHEMA,
    executionBoundary: EXECUTION_BOUNDARY_SCHEMA,
    launchPrompt: { type: 'string', minLength: 1, maxLength: 4_096 },
    runEnvelope: { type: 'string', minLength: 1, maxLength: 65_536 },
  },
} as const;
const NON_RETRIABLE_TOOL_ERROR_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['category'],
      properties: {
        category: {
          type: 'string',
          enum: [
            'confirmation_invalid',
            'digest_mismatch',
            'draft_not_found',
            'draft_stale',
            'idempotency_conflict',
            'insufficient_scope',
            'share_not_found',
            'starter_mismatch',
            'tool_not_found',
            'unauthenticated',
            'validation_failed',
          ],
        },
      },
    },
  },
} as const;
const RETRIABLE_INTERNAL_TOOL_ERROR_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['category', 'retryable'],
      properties: {
        category: { type: 'string', const: 'internal' },
        retryable: { type: 'boolean', const: true },
      },
    },
  },
} as const;
const TOOL_ERROR_OUTPUT = {
  type: 'object',
  oneOf: [NON_RETRIABLE_TOOL_ERROR_OUTPUT, RETRIABLE_INTERNAL_TOOL_ERROR_OUTPUT],
} as const;

function toolOutputSchema(success: JsonSchema) {
  return { type: 'object', oneOf: [success, TOOL_ERROR_OUTPUT] } as const;
}

export const PROJECT_HISTORY_AGENT_MCP_SCHEMAS = Object.freeze({
  create_agent_package_draft: Object.freeze({
    inputSchema: CREATE_DRAFT_INPUT,
    outputSchema: toolOutputSchema(CREATE_DRAFT_OUTPUT),
  }),
  render_agent_package_draft: Object.freeze({
    inputSchema: RENDER_DRAFT_INPUT,
    outputSchema: toolOutputSchema(RENDER_DRAFT_OUTPUT),
  }),
  create_agent_package_share: Object.freeze({
    inputSchema: CREATE_SHARE_INPUT,
    outputSchema: toolOutputSchema(CREATE_SHARE_OUTPUT),
  }),
  read_agent_package_share: Object.freeze({
    inputSchema: READ_SHARE_INPUT,
    outputSchema: toolOutputSchema(READ_SHARE_OUTPUT),
  }),
  prepare_agent_package_run: Object.freeze({
    inputSchema: PREPARE_RUN_INPUT,
    outputSchema: toolOutputSchema(PREPARE_RUN_OUTPUT),
  }),
});

export type ProjectHistoryAgentMcpToolDefinition = Readonly<{
  name: ProjectHistoryAgentToolName;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  authorization: 'owner' | 'public_by_link';
  _meta?: Readonly<{
    ui: Readonly<{ resourceUri: string }>;
    'openai/outputTemplate': string;
    'openai/toolInvocation/invoking': string;
    'openai/toolInvocation/invoked': string;
  }>;
  annotations: Readonly<{
    readOnlyHint: boolean;
    destructiveHint: false;
    openWorldHint: boolean;
  }>;
}>;

export const PROJECT_HISTORY_AGENT_MCP_TOOLS: readonly ProjectHistoryAgentMcpToolDefinition[] = [
  {
    name: 'create_agent_package_draft',
    title: 'Create Project-history Agent Package Draft',
    description:
      'Persist one strict Draft derived by the model from a user-selected saved Project through bounded Host reduced-history reads. No Project/task/thread/session IDs, paths, messages, transcripts or raw tool results are accepted or stored. Coverage, Host attestation and source projection remain not proven.',
    ...PROJECT_HISTORY_AGENT_MCP_SCHEMAS.create_agent_package_draft,
    authorization: 'owner',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'render_agent_package_draft',
    title: 'Render exact Agent Package Draft',
    description:
      'Read the exact persisted Draft and mint a five-minute one-time server confirmation token. The token proves render-first state binding, not a Host-authenticated click, and must not be shown in the card or action message.',
    ...PROJECT_HISTORY_AGENT_MCP_SCHEMAS.render_agent_package_draft,
    authorization: 'owner',
    _meta: {
      ui: { resourceUri: PROJECT_HISTORY_AGENT_DRAFT_APP_URI },
      'openai/outputTemplate': PROJECT_HISTORY_AGENT_DRAFT_APP_URI,
      'openai/toolInvocation/invoking': '正在读取精确草稿…',
      'openai/toolInvocation/invoked': '草稿已显示，等待你的确认。',
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'create_agent_package_share',
    title: 'Create immutable Agent Package Release/share',
    description:
      'Consume the one-time render token and freeze the exact Draft into one immutable combo.agent-package/1 public-by-link Release/share. Anyone holding the link can read it; it does not expire and currently cannot be revoked, but it is not a marketplace publication. Exact same idempotency retry returns the same result; stale, expired, cross-subject and replay attempts fail closed.',
    ...PROJECT_HISTORY_AGENT_MCP_SCHEMAS.create_agent_package_share,
    authorization: 'owner',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'read_agent_package_share',
    title: 'Read immutable Agent Package Release/share',
    description:
      'Read exact Package bytes and the authoritative Package digest from the canonical high-entropy share URL alone. This public-by-link read contains no creator Project or Git binding; prepare still requires the returned digest for anti-mixup verification.',
    ...PROJECT_HISTORY_AGENT_MCP_SCHEMAS.read_agent_package_share,
    authorization: 'public_by_link',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'prepare_agent_package_run',
    title: 'Prepare Agent Package Run V2',
    description:
      'Verify the exact Package and selected starter, then return server-verified cleartext Agent/Skill instructions plus a <=8 KiB human-readable launchPrompt. Project B must use only launchPrompt as its visible first message; the <=64 KiB run envelope is machine evidence, not user-facing text. The receiver chooses Project B only in the local Host; no creator Project/Git fields enter this call.',
    ...PROJECT_HISTORY_AGENT_MCP_SCHEMAS.prepare_agent_package_run,
    authorization: 'public_by_link',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
] as const;

export interface ProjectHistoryAgentMcpToolResult {
  content: readonly [{ type: 'text'; text: string }];
  structuredContent: Record<string, unknown>;
  isError?: true;
}

type ProjectHistoryAgentMcpInternalFailureLogFields = Readonly<{
  category: 'project_history_agent_mcp_request_failed';
  traceId: string;
  sqlState?: string;
  constraint?: string;
}>;

const SAFE_DATABASE_CONSTRAINTS = new Set([
  'project_history_agent_drafts_owner_idempotency_key_key',
  'project_history_agent_shares_owner_idempotency_key_key',
  'project_history_agent_confirmations_token_digest_key',
]);

export async function executeProjectHistoryAgentMcpTool(
  context: {
    service: ProjectHistoryAgentService;
    ownerUserId?: string;
    traceId?: string;
    reportInternalFailure?: (fields: ProjectHistoryAgentMcpInternalFailureLogFields) => void;
  },
  name: string,
  rawArguments: unknown,
): Promise<ProjectHistoryAgentMcpToolResult> {
  try {
    let result: Record<string, unknown>;
    switch (name) {
      case 'create_agent_package_draft':
        result = await context.service.createDraft(
          requireOwner(context.ownerUserId),
          rawArguments as never,
        );
        break;
      case 'render_agent_package_draft':
        result = await context.service.renderDraft(
          requireOwner(context.ownerUserId),
          rawArguments as never,
        );
        break;
      case 'create_agent_package_share':
        result = await context.service.createShare(
          requireOwner(context.ownerUserId),
          rawArguments as never,
        );
        break;
      case 'read_agent_package_share':
        result = await context.service.readShare(rawArguments as never);
        break;
      case 'prepare_agent_package_run':
        result = await context.service.prepareRun(rawArguments as never);
        break;
      default:
        return failure('tool_not_found');
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name }) }],
      structuredContent: result,
    };
  } catch (error) {
    if (error instanceof ProjectHistoryAgentMcpAuthorizationError) {
      return failure('unauthenticated');
    }
    if (error instanceof ProjectHistoryAgentServiceError) {
      return failure(error.code);
    }
    if (error instanceof ZodError || error instanceof ProjectHistoryAgentCandidateValidationError) {
      return failure('validation_failed');
    }
    try {
      context.reportInternalFailure?.(
        projectHistoryMcpInternalFailureLogFields(context.traceId ?? 'trace-unavailable', error),
      );
    } catch {
      // Observability must never change the fixed, low-sensitivity MCP failure response.
    }
    return failure('internal');
  }
}

function projectHistoryMcpInternalFailureLogFields(
  traceId: string,
  error: unknown,
): ProjectHistoryAgentMcpInternalFailureLogFields {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const sqlState =
    typeof record.code === 'string' && /^[0-9A-Z]{5}$/u.test(record.code) ? record.code : undefined;
  const constraint =
    typeof record.constraint === 'string' && SAFE_DATABASE_CONSTRAINTS.has(record.constraint)
      ? record.constraint
      : undefined;
  return {
    category: 'project_history_agent_mcp_request_failed',
    traceId,
    ...(sqlState ? { sqlState } : {}),
    ...(constraint ? { constraint } : {}),
  };
}

function requireOwner(ownerUserId: string | undefined): string {
  if (!ownerUserId) throw new ProjectHistoryAgentMcpAuthorizationError();
  return ownerUserId;
}

class ProjectHistoryAgentMcpAuthorizationError extends Error {
  constructor() {
    super('MCP owner principal is required');
    this.name = 'ProjectHistoryAgentMcpAuthorizationError';
  }
}

function failure(category: string): ProjectHistoryAgentMcpToolResult {
  const internal = category === 'internal';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          internal
            ? { ok: false, retryable: true, message: 'Combo 暂时无法完成此请求，请稍后重试。' }
            : { ok: false },
        ),
      },
    ],
    structuredContent: {
      error: internal ? { category, retryable: true } : { category },
    },
    isError: true,
  };
}
