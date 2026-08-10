import { createHash } from 'node:crypto';
import {
  AgentResourceIdSchema,
  CapabilityDefinitionSchema,
  CODEX_AGENT_SOURCE_REF_PATTERN,
  CommitAgentRevisionBodySchema,
  CreateCodexAgentShareBodySchema,
  CreateAgentProjectBodySchema,
  CreateProjectAgentShareBodySchema,
  CreateAgentReleaseBodySchema,
  CreateTaskBodySchema,
  DEFAULT_PAGE_LIMIT,
  InvalidCursorError,
  MAX_PAGE_LIMIT,
  PrepareCodexAgentRunBodySchema,
  canonicalJson,
  decodeIdCursor,
  encodeIdCursor,
  RecordAgentTestReviewBodySchema,
  ReadProjectAgentShareBodySchema,
  ReadCodexAgentShareBodySchema,
  type McpOAuthScope,
  type ObjectStorePort,
} from '@cb/shared';
import { z } from 'zod';
import type { Queryable } from '../../platform/infra/db.js';
import { asTxPool, type TxPool } from '../../platform/infra/db-tx.js';
import {
  AgentCompileDependencyError,
  AgentRevisionIntegrityError,
  createAgentProject,
  listAgentProjects,
  publishAgentRevision,
  recordAgentTestReview,
  readAgentProjectDetail,
  readAgentRevisionDetail,
  saveAgentRevision,
  toAgentRevisionView,
} from '../agent-project/index.js';
import { listCapabilityViews, readCapabilityDefinitionRef } from '../capability/index.js';
import { createProjectAgentShare, readProjectAgentShare } from '../project-agent-share/index.js';
import {
  createCodexAgentShare,
  prepareCodexAgentRun,
  readCodexAgentShare,
} from '../codex-agent-share/index.js';
import { createTask, readTaskView, reconcileExpiredUploadTasks } from '../task/index.js';
import type { McpPrincipal } from './repo.js';
import { McpRuntimeRequestError, type McpRuntimeClient } from './runtime-client.js';
import { hasMcpScope } from './service.js';
import { AGENT_BUILDER_APP_URI } from './agent-builder-app.js';

interface JsonSchema extends Record<string, unknown> {
  type: string;
  properties?: Readonly<Record<string, unknown>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  description?: string;
  oneOf?: readonly unknown[];
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  _meta?: {
    ui: { resourceUri: string };
    'openai/outputTemplate'?: string;
    'openai/toolInvocation/invoking'?: string;
    'openai/toolInvocation/invoked'?: string;
  };
  annotations: {
    readOnlyHint: boolean;
    openWorldHint: boolean;
    destructiveHint: boolean;
  };
  requiredScope: McpOAuthScope;
}

const UUID_SCHEMA = { type: 'string', format: 'uuid' } as const;
const IDEMPOTENCY_SCHEMA = { type: 'string', minLength: 8, maxLength: 200 } as const;
const AGENT_BUILDER_CARD_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stage', 'title', 'summary', 'progress', 'items', 'actions'],
  properties: {
    stage: {
      type: 'string',
      enum: [
        'readiness',
        'recommendations',
        'production',
        'draft',
        'test',
        'release',
        'project_share',
        'project_restore',
      ],
    },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    summary: { type: 'string', maxLength: 1000 },
    progress: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'state'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 80 },
          state: { type: 'string', enum: ['pending', 'current', 'done'] },
        },
      },
    },
    items: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'summary', 'facts'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 120 },
          title: { type: 'string', minLength: 1, maxLength: 120 },
          summary: { type: 'string', maxLength: 1000 },
          facts: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'value'],
              properties: {
                label: { type: 'string', minLength: 1, maxLength: 80 },
                value: { type: 'string', maxLength: 10000 },
              },
            },
          },
          action: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'message', 'emphasis'],
            properties: {
              label: { type: 'string', minLength: 1, maxLength: 80 },
              message: { type: 'string', minLength: 1, maxLength: 1000 },
              emphasis: { type: 'string', enum: ['primary', 'secondary'] },
            },
          },
        },
      },
    },
    actions: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'message', 'emphasis'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 80 },
          message: { type: 'string', minLength: 1, maxLength: 1000 },
          emphasis: { type: 'string', enum: ['primary', 'secondary'] },
        },
      },
    },
  },
} as const;

const PROJECT_AGENT_REPOSITORY_URL_JSON_SCHEMA = {
  type: 'string',
  format: 'uri',
  maxLength: 2048,
  pattern:
    '^https://github\\.com/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/(?!\\.{2,3}git$)(?![A-Za-z0-9._-]{1,100}\\.git\\.git$)[A-Za-z0-9._-]{1,100}\\.git$',
} as const;

const PROJECT_AGENT_SOURCE_REF_JSON_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
  pattern:
    '^refs/(?:heads|tags)/(?!\\.)(?!.*\\/\\.)(?![^\\/]*\\.lock(?:\\/|$))(?!.*\\/[^\\/]*\\.lock(?:\\/|$))(?!.*(?:\\.\\.|@\\{|\\/\\/))(?!.*[\\u0000-\\u0020\\u007f~^:?*\\[\\\\])(?!.*[\\/.]$).+$',
} as const;

const CODEX_AGENT_SOURCE_REF_JSON_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
  pattern: CODEX_AGENT_SOURCE_REF_PATTERN,
} as const;

const PERSISTABLE_JSON_TEXT_PATTERN = '^[^\\u0000]*$';

const PROJECT_AGENT_REQUIREMENTS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['commands', 'plugins', 'environmentVariableNames'],
  properties: {
    codexVersion: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: PERSISTABLE_JSON_TEXT_PATTERN,
    },
    commands: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$',
      },
    },
    plugins: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern:
          '^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,62}/)?[A-Za-z0-9][A-Za-z0-9._-]{0,62}(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,62})?$',
      },
    },
    environmentVariableNames: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[A-Z_][A-Z0-9_]{0,127}$',
      },
    },
  },
} as const;

const PROJECT_AGENT_SHARE_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['manifest', 'shareUrl', 'copyPrompt'],
  properties: {
    manifest: {
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion',
        'name',
        'description',
        'source',
        'startPrompt',
        'requirements',
        'createdAt',
      ],
      properties: {
        schemaVersion: { type: 'string', const: 'combo.project-agent-share/1' },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
        source: {
          type: 'object',
          additionalProperties: false,
          required: ['repositoryUrl', 'sourceRef', 'commitSha', 'treeSha'],
          properties: {
            repositoryUrl: PROJECT_AGENT_REPOSITORY_URL_JSON_SCHEMA,
            sourceRef: PROJECT_AGENT_SOURCE_REF_JSON_SCHEMA,
            commitSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
            treeSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
          },
        },
        startPrompt: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
        requirements: PROJECT_AGENT_REQUIREMENTS_JSON_SCHEMA,
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    shareUrl: { type: 'string', format: 'uri', maxLength: 2048 },
    copyPrompt: { type: 'string', minLength: 1, maxLength: 20000 },
  },
} as const;

const CODEX_AGENT_SHARE_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['manifest', 'manifestSha256', 'shareUrl', 'copyPrompt'],
  properties: {
    manifest: {
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion',
        'name',
        'description',
        'source',
        'agent',
        'authoringSource',
        'requirements',
        'createdAt',
      ],
      properties: {
        schemaVersion: { type: 'string', const: 'combo.codex-agent-share/1' },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
        source: {
          type: 'object',
          additionalProperties: false,
          required: ['repositoryUrl', 'sourceRef', 'commitSha', 'treeSha'],
          properties: {
            repositoryUrl: PROJECT_AGENT_REPOSITORY_URL_JSON_SCHEMA,
            sourceRef: CODEX_AGENT_SOURCE_REF_JSON_SCHEMA,
            commitSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
            treeSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
          },
        },
        agent: {
          type: 'object',
          additionalProperties: false,
          required: ['instructions', 'starterPrompts'],
          properties: {
            instructions: {
              type: 'string',
              minLength: 1,
              maxLength: 8000,
              pattern: PERSISTABLE_JSON_TEXT_PATTERN,
            },
            starterPrompts: {
              type: 'array',
              minItems: 1,
              maxItems: 5,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 1000,
                pattern: PERSISTABLE_JSON_TEXT_PATTERN,
              },
            },
          },
        },
        authoringSource: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'rawStored'],
          properties: {
            kind: { type: 'string', const: 'codex_current_task' },
            rawStored: { type: 'boolean', const: false },
          },
        },
        requirements: PROJECT_AGENT_REQUIREMENTS_JSON_SCHEMA,
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    manifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    shareUrl: { type: 'string', format: 'uri', maxLength: 2048 },
    copyPrompt: { type: 'string', minLength: 1, maxLength: 20000 },
  },
} as const;
const PREPARE_CODEX_AGENT_RUN_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['shareUrl', 'manifestSha256', 'starterPrompt', 'runEnvelope'],
  properties: {
    shareUrl: { type: 'string', format: 'uri', maxLength: 2048 },
    manifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    starterPrompt: {
      type: 'string',
      minLength: 1,
      maxLength: 1000,
      pattern: PERSISTABLE_JSON_TEXT_PATTERN,
    },
    runEnvelope: { type: 'string', minLength: 1, maxLength: 64000 },
  },
} as const;
export const PREPARE_CODEX_AGENT_RUN_TOOL_DESCRIPTION =
  'An ordinary receiver calls this only after the user confirms restore-and-run and selects one displayed starter by 1-based ordinal. A terminal Plugin receiving an exact COMBO_CODEX_AGENT_RUN/1 advanced launch must call it exactly once before any Git preflight or Agent text solely to revalidate the four returned fields and runEnvelope byte-for-byte; that call is not evidence of prior UI consent. All other pre-confirmation calls are forbidden, and clients must never construct the envelope locally.' as const;
const AGENT_DEFINITION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'identity', 'interface', 'behavior', 'ui', 'runtime'],
  properties: {
    schemaVersion: { type: 'string', const: 'combo.agent/1' },
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        summary: { type: 'string', maxLength: 1000, default: '' },
      },
    },
    interface: {
      type: 'object',
      additionalProperties: false,
      required: ['output'],
      properties: {
        inputs: {
          type: 'array',
          maxItems: 50,
          default: [],
          items: {
            type: 'object',
            required: ['key', 'label', 'type'],
            properties: {
              key: { type: 'string', minLength: 1 },
              label: { type: 'string', minLength: 1 },
              type: { type: 'string', enum: ['string', 'text', 'number', 'enum'] },
              required: { type: 'boolean', default: false },
              options: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
              },
            },
          },
        },
        output: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['type'],
              properties: { type: { type: 'string', const: 'text' } },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'schema'],
              properties: {
                type: { type: 'string', const: 'structured' },
                schema: {
                  type: 'object',
                  propertyNames: { type: 'string' },
                  additionalProperties: {},
                },
              },
            },
          ],
        },
        starterPrompts: {
          type: 'array',
          maxItems: 20,
          default: [],
          items: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
    behavior: {
      type: 'object',
      additionalProperties: false,
      required: ['instructions', 'capabilities'],
      properties: {
        instructions: { type: 'string', minLength: 1, maxLength: 200000 },
        capabilities: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['capabilityId', 'role'],
            properties: {
              capabilityId: UUID_SCHEMA,
              role: { type: 'string', enum: ['entry', 'support'] },
            },
          },
        },
      },
    },
    ui: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'artifactId', 'bridgeVersion'],
      properties: {
        kind: { type: 'string', const: 'miniapp-html' },
        artifactId: UUID_SCHEMA,
        bridgeVersion: { type: 'number', const: 1 },
      },
    },
    runtime: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: { mode: { type: 'string', const: 'single-loop' } },
    },
  },
};

export const EXTERNAL_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'create_extraction_task',
    title: 'Create Combo extraction task',
    description:
      'Create a real Combo extraction task for the current Codex task and return the one-time local pairing command. The command fails closed unless it can identify exactly that task; raw source never enters MCP arguments.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['idempotencyKey'],
      properties: {
        description: { type: 'string', maxLength: 500 },
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    requiredScope: 'combo.agent:write',
  },
  {
    name: 'read_extraction_task',
    title: 'Read Combo extraction task',
    description: 'Read the authoritative extraction Task state and Capability count.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: { taskId: UUID_SCHEMA },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'list_capabilities',
    title: 'List extracted capabilities',
    description: 'List owned Capability records, optionally filtered by extraction Task.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: UUID_SCHEMA,
        cursor: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'read_capability_definition',
    title: 'Read full Capability definition',
    description: 'Read one owned Capability with its full immutable definition and SHA-256.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['capabilityId'],
      properties: { capabilityId: UUID_SCHEMA },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'list_agent_projects',
    title: 'List Agent Projects',
    description:
      'List the authenticated user’s active Agent Projects. This remote tool is stateless.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cursor: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'render_agent_builder',
    title: 'Render Combo Agent Builder card',
    description:
      'Render one final, model-checked Agent Builder stage after the required data reads or authorized analysis. This presentation-only tool does not persist a recommendation, select an Agent, record a Review, or publish a Release. A button is confirmation only after its resulting user message appears in the conversation.',
    inputSchema: AGENT_BUILDER_CARD_JSON_SCHEMA,
    outputSchema: AGENT_BUILDER_CARD_JSON_SCHEMA,
    _meta: {
      ui: { resourceUri: AGENT_BUILDER_APP_URI },
      'openai/outputTemplate': AGENT_BUILDER_APP_URI,
      'openai/toolInvocation/invoking': '正在整理 Agent Builder…',
      'openai/toolInvocation/invoked': 'Agent Builder 已更新',
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'create_agent_project',
    title: 'Create Agent Project',
    description: 'Create an empty Agent Project with an idempotency key.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'idempotencyKey'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        summary: { type: 'string', maxLength: 1000 },
        sourceTaskId: UUID_SCHEMA,
        idempotencyKey: IDEMPOTENCY_SCHEMA,
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:write',
  },
  {
    name: 'target_agent_project',
    title: 'Inspect Agent Project target',
    description:
      'Read an Agent Project and return a target snapshot. The remote MCP never stores this snapshot; later tools still require projectId.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId'],
      properties: { projectId: UUID_SCHEMA },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'read_agent_project',
    title: 'Read Agent Project',
    description:
      'Read the authoritative Project, Head Revision and current Release. projectId is always explicit because the remote MCP is stateless.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId'],
      properties: { projectId: UUID_SCHEMA },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'save_agent_ui',
    title: 'Save Agent Miniapp UI',
    description:
      'Create or reuse the entry Capability Studio session and save validated self-contained HTML.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'html', 'idempotencyKey'],
      properties: {
        projectId: UUID_SCHEMA,
        entryCapabilityId: UUID_SCHEMA,
        html: { type: 'string', minLength: 1, maxLength: 1000000 },
        title: { type: 'string', minLength: 1, maxLength: 120 },
        idempotencyKey: IDEMPOTENCY_SCHEMA,
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:write',
  },
  {
    name: 'read_agent_ui',
    title: 'Read authoritative Agent Miniapp UI',
    description:
      'Read an owner-scoped HTML artifact. Pass artifactId or projectId, never both; projectId resolves the current Head UI and verifies its digest.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { artifactId: UUID_SCHEMA, projectId: UUID_SCHEMA },
      oneOf: [
        { required: ['artifactId'], not: { required: ['projectId'] } },
        { required: ['projectId'], not: { required: ['artifactId'] } },
      ],
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'commit_agent_revision',
    title: 'Commit immutable Agent Revision',
    description:
      'Compile and commit a complete AgentDefinition with explicit projectId and Head compare-and-swap.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'projectId',
        'expectedHeadRevisionId',
        'mutationId',
        'changeSummary',
        'definition',
      ],
      properties: {
        projectId: UUID_SCHEMA,
        expectedHeadRevisionId: { anyOf: [UUID_SCHEMA, { type: 'null' }] },
        mutationId: IDEMPOTENCY_SCHEMA,
        changeSummary: { type: 'string', minLength: 1, maxLength: 1000 },
        definition: AGENT_DEFINITION_JSON_SCHEMA,
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:write',
  },
  {
    name: 'read_agent_revision',
    title: 'Read immutable Agent Revision',
    description: 'Read a frozen Agent Definition, Capability snapshots, Runtime Bundle and hashes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId'],
      properties: { projectId: UUID_SCHEMA, revisionId: UUID_SCHEMA },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'run_agent_test',
    title: 'Run pinned Agent Revision test',
    description:
      'Start a real Runtime Session and Turn pinned to an explicit Project and immutable Revision, then return its visible Runtime preview. A running response is not a pass; read the Test later with its testId.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'revisionId', 'text', 'idempotencyKey'],
      properties: {
        projectId: UUID_SCHEMA,
        revisionId: UUID_SCHEMA,
        text: { type: 'string', minLength: 1, maxLength: 20000 },
        idempotencyKey: IDEMPOTENCY_SCHEMA,
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    requiredScope: 'combo.agent:write',
  },
  {
    name: 'list_agent_tests',
    title: 'List recent Agent Project tests',
    description: 'Recover recent Test IDs for an owned Agent Project. projectId is required.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId'],
      properties: {
        projectId: UUID_SCHEMA,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'read_agent_test',
    title: 'Read Agent Revision test',
    description:
      'Read and finalize one real Agent Test and return its visible Runtime preview. status=passed means execution completed, not business quality; Release also requires a publishable immutable Review of the current Head.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['testId'],
      properties: { testId: UUID_SCHEMA },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'record_agent_test_review',
    title: 'Record immutable Agent Test quality review',
    description:
      'Record the authenticated user’s immutable quality decision for a passed Test. Call only after the user explicitly confirms the normal, boundary and failure case results in the current Codex task. caseId values must be unique.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'testId', 'idempotencyKey', 'cases'],
      properties: {
        projectId: UUID_SCHEMA,
        testId: UUID_SCHEMA,
        idempotencyKey: IDEMPOTENCY_SCHEMA,
        summary: { type: 'string', maxLength: 2000, default: '' },
        cases: {
          type: 'array',
          minItems: 3,
          maxItems: 50,
          uniqueItems: true,
          allOf: [
            {
              contains: {
                type: 'object',
                required: ['kind'],
                properties: { kind: { type: 'string', const: 'normal' } },
              },
            },
            {
              contains: {
                type: 'object',
                required: ['kind'],
                properties: { kind: { type: 'string', const: 'boundary' } },
              },
            },
            {
              contains: {
                type: 'object',
                required: ['kind'],
                properties: { kind: { type: 'string', const: 'failure' } },
              },
            },
          ],
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['caseId', 'kind', 'executionStatus', 'qualityVerdict', 'reason'],
            properties: {
              caseId: { type: 'string', minLength: 1, maxLength: 120 },
              kind: { type: 'string', enum: ['normal', 'boundary', 'failure'] },
              executionStatus: { type: 'string', enum: ['completed', 'failed'] },
              qualityVerdict: {
                type: 'string',
                enum: ['passed', 'failed', 'accepted_exception'],
              },
              reason: { type: 'string', minLength: 1, maxLength: 2000 },
              impact: { type: 'string', maxLength: 2000 },
            },
            allOf: [
              {
                if: {
                  required: ['qualityVerdict'],
                  properties: {
                    qualityVerdict: { type: 'string', const: 'accepted_exception' },
                  },
                },
                then: {
                  required: ['impact'],
                  properties: { impact: { type: 'string', minLength: 1, maxLength: 2000 } },
                },
              },
            ],
          },
        },
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:write',
  },
  {
    name: 'publish_agent_revision',
    title: 'Publish tested Agent Revision',
    description:
      'Create an immutable Release only when the selected Test completed, has a publishable immutable quality Review, and still matches the current Head. Requires a separate explicit Release confirmation before calling.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'testId', 'idempotencyKey'],
      properties: {
        projectId: UUID_SCHEMA,
        testId: UUID_SCHEMA,
        idempotencyKey: IDEMPOTENCY_SCHEMA,
        notes: { type: 'string', maxLength: 2000 },
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    requiredScope: 'combo.agent:write',
  },
  {
    name: 'create_project_agent_share',
    title: 'Create immutable Project Agent share',
    description:
      'Create an immutable manifest for one clean committed GitHub Project. Before calling, the Codex client must prove that git ls-remote origin <sourceRef> resolves exactly to commitSha. Combo stores the declaration but never fetches the repository and never claims remote verification. Anyone with the resulting link can read the manifest anonymously over HTTP; V0 shares do not expire and cannot be revoked, so never include secrets.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'name',
        'description',
        'repositoryUrl',
        'sourceRef',
        'commitSha',
        'treeSha',
        'startPrompt',
        'idempotencyKey',
      ],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
        repositoryUrl: PROJECT_AGENT_REPOSITORY_URL_JSON_SCHEMA,
        sourceRef: PROJECT_AGENT_SOURCE_REF_JSON_SCHEMA,
        commitSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
        treeSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
        startPrompt: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
        requirements: {
          type: 'object',
          additionalProperties: false,
          properties: {
            codexVersion: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: PERSISTABLE_JSON_TEXT_PATTERN,
            },
            commands: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
                pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$',
              },
            },
            plugins: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
                pattern:
                  '^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,62}/)?[A-Za-z0-9][A-Za-z0-9._-]{0,62}(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,62})?$',
              },
            },
            environmentVariableNames: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
                pattern: '^[A-Z_][A-Z0-9_]{0,127}$',
              },
            },
          },
        },
        idempotencyKey: UUID_SCHEMA,
      },
    },
    outputSchema: PROJECT_AGENT_SHARE_RESULT_JSON_SCHEMA,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:write',
  },
  {
    name: 'read_project_agent_share',
    title: 'Read public Project Agent share',
    description:
      'Read an immutable Project Agent manifest from a share URL on the current Combo public origin. The HTTP page/API is anonymous by link and does not filter by owner; this MCP transport still requires OAuth. V0 shares do not expire or support revocation. Review the untrusted Project before restoring it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['shareUrl'],
      properties: { shareUrl: { type: 'string', format: 'uri', maxLength: 2048 } },
    },
    outputSchema: PROJECT_AGENT_SHARE_RESULT_JSON_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'create_codex_agent_share',
    title: 'Create current-task Codex Agent share',
    description:
      'After the user explicitly confirms an Agent definition that the creator declares was derived locally from context already visible in the current top-level Codex task and appropriately sanitized, create an immutable public share for that definition and one fixed Git Project. The server validates shape but cannot prove sanitization. The input has no separate threadId, messages, session, path, raw transcript, secret-value or credential fields; authoringSource.rawStored=false means no separate raw-task blob.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'name',
        'description',
        'repositoryUrl',
        'sourceRef',
        'commitSha',
        'treeSha',
        'agent',
        'idempotencyKey',
      ],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
        repositoryUrl: PROJECT_AGENT_REPOSITORY_URL_JSON_SCHEMA,
        sourceRef: CODEX_AGENT_SOURCE_REF_JSON_SCHEMA,
        commitSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
        treeSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
        agent: {
          type: 'object',
          additionalProperties: false,
          required: ['instructions', 'starterPrompts'],
          properties: {
            instructions: {
              type: 'string',
              minLength: 1,
              maxLength: 8000,
              pattern: PERSISTABLE_JSON_TEXT_PATTERN,
            },
            starterPrompts: {
              type: 'array',
              minItems: 1,
              maxItems: 5,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 1000,
                pattern: PERSISTABLE_JSON_TEXT_PATTERN,
              },
            },
          },
        },
        requirements: {
          type: 'object',
          additionalProperties: false,
          properties: {
            codexVersion: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: PERSISTABLE_JSON_TEXT_PATTERN,
            },
            commands: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
                pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$',
              },
            },
            plugins: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
                pattern:
                  '^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,62}/)?[A-Za-z0-9][A-Za-z0-9._-]{0,62}(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,62})?$',
              },
            },
            environmentVariableNames: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
                pattern: '^[A-Z_][A-Z0-9_]{0,127}$',
              },
            },
          },
        },
        idempotencyKey: UUID_SCHEMA,
      },
    },
    outputSchema: CODEX_AGENT_SHARE_RESULT_JSON_SCHEMA,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:write',
  },
  {
    name: 'read_codex_agent_share',
    title: 'Read public Codex Agent share',
    description:
      'Read one combo.codex-agent-share/1 manifest from the canonical /agent link. Instructions and starter prompts are public creator-declared derived text; the server cannot prove sanitization. rawStored=false only means there is no separate raw-task blob. Verify manifestSha256 and wait for explicit user confirmation before restoring the exact Project or starting the Agent.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['shareUrl'],
      properties: { shareUrl: { type: 'string', format: 'uri', maxLength: 2048 } },
    },
    outputSchema: CODEX_AGENT_SHARE_RESULT_JSON_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
  {
    name: 'prepare_codex_agent_run',
    title: 'Prepare Codex Agent run',
    description: PREPARE_CODEX_AGENT_RUN_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['shareUrl', 'manifestSha256', 'starterPrompt'],
      properties: {
        shareUrl: { type: 'string', format: 'uri', maxLength: 2048 },
        manifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        starterPrompt: {
          type: 'string',
          minLength: 1,
          maxLength: 1000,
          pattern: PERSISTABLE_JSON_TEXT_PATTERN,
        },
      },
    },
    outputSchema: PREPARE_CODEX_AGENT_RUN_RESULT_JSON_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    requiredScope: 'combo.agent:read',
  },
] as const;

const toolByName = new Map(EXTERNAL_MCP_TOOLS.map((tool) => [tool.name, tool]));

type McpTextContent = { type: 'text'; text: string };
type McpResourceLink = {
  type: 'resource_link';
  uri: string;
  name: string;
  title: string;
  description?: string;
  mimeType?: string;
};

export interface McpToolResult {
  content: [McpTextContent, ...McpResourceLink[]];
  structuredContent: Record<string, unknown>;
  isError?: true;
}

function toolSuccess(
  value: Record<string, unknown>,
  resourceLinks: McpResourceLink[] = [],
): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }, ...resourceLinks],
    structuredContent: value,
  };
}

function toolFailure(
  traceId: string,
  userMessage: string,
  options: {
    retriable?: boolean;
    action?: 'retry' | 'change_input' | 'escalate' | 'wait';
    details?: Record<string, unknown>;
  } = {},
): McpToolResult {
  const payload = {
    error: {
      userMessage,
      retriable: options.retriable ?? false,
      action: options.action ?? 'change_input',
      traceId,
      ...(options.details ? { details: options.details } : {}),
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

export interface ExecuteToolContext {
  db: Queryable;
  txPool: TxPool;
  objectStore: ObjectStorePort;
  principal: McpPrincipal;
  comboEnvironment: string;
  publicOrigin: string;
  runtime: McpRuntimeClient;
  traceId: string;
}

const listInputSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  })
  .strict();
const taskInputSchema = z.object({ taskId: AgentResourceIdSchema }).strict();
const capabilityInputSchema = z.object({ capabilityId: AgentResourceIdSchema }).strict();
const capabilityListInputSchema = z
  .object({
    taskId: AgentResourceIdSchema.optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  })
  .strict();
const projectInputSchema = z.object({ projectId: AgentResourceIdSchema }).strict();
const revisionInputSchema = z
  .object({ projectId: AgentResourceIdSchema, revisionId: AgentResourceIdSchema.optional() })
  .strict();
const commitInputSchema = z
  .object({ projectId: AgentResourceIdSchema })
  .merge(CommitAgentRevisionBodySchema);
const saveUiInputSchema = z
  .object({
    projectId: AgentResourceIdSchema,
    entryCapabilityId: AgentResourceIdSchema.optional(),
    html: z.string().min(1).max(1_000_000),
    title: z.string().trim().min(1).max(120).optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();
const readUiInputSchema = z
  .object({
    artifactId: AgentResourceIdSchema.optional(),
    projectId: AgentResourceIdSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.artifactId) !== Boolean(value.projectId), {
    message: 'artifactId 与 projectId 必须且只能传一个',
  });
const runTestInputSchema = z
  .object({
    projectId: AgentResourceIdSchema,
    revisionId: AgentResourceIdSchema,
    text: z.string().trim().min(1).max(20_000),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();
const listTestsInputSchema = z
  .object({
    projectId: AgentResourceIdSchema,
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
const readTestInputSchema = z.object({ testId: AgentResourceIdSchema }).strict();
const reviewTestInputSchema = z
  .object({ projectId: AgentResourceIdSchema, testId: AgentResourceIdSchema })
  .merge(RecordAgentTestReviewBodySchema);
const publishInputSchema = z
  .object({
    projectId: AgentResourceIdSchema,
    testId: AgentResourceIdSchema,
    idempotencyKey: z.string().trim().min(8).max(200),
    notes: z.string().trim().max(2_000).optional(),
  })
  .strict();
const agentBuilderActionInputSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(1_000),
    emphasis: z.enum(['primary', 'secondary']),
  })
  .strict();
const renderAgentBuilderInputSchema = z
  .object({
    stage: z.enum([
      'readiness',
      'recommendations',
      'production',
      'draft',
      'test',
      'release',
      'project_share',
      'project_restore',
    ]),
    title: z.string().trim().min(1).max(120),
    summary: z.string().max(1_000),
    progress: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(80),
            state: z.enum(['pending', 'current', 'done']),
          })
          .strict(),
      )
      .max(8),
    items: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            title: z.string().trim().min(1).max(120),
            summary: z.string().max(1_000),
            facts: z
              .array(
                z
                  .object({
                    label: z.string().trim().min(1).max(80),
                    value: z.string().max(10_000),
                  })
                  .strict(),
              )
              .max(12),
            action: agentBuilderActionInputSchema.optional(),
          })
          .strict(),
      )
      .max(8),
    actions: z.array(agentBuilderActionInputSchema).max(4),
  })
  .strict();

function validationFailure(traceId: string, error: z.ZodError): McpToolResult {
  return toolFailure(traceId, '工具参数不符合 Combo 契约，请修正后重试。', {
    details: {
      issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    },
  });
}

function targetSnapshot(detail: {
  project: { id: string; headRevisionId: string | null; currentReleaseId: string | null };
}): Record<string, unknown> {
  return {
    projectId: detail.project.id,
    observedHeadRevisionId: detail.project.headRevisionId,
    currentReleaseId: detail.project.currentReleaseId,
  };
}

function releasedAgentUrl(
  publicOrigin: string,
  detail: { project: { id: string; currentReleaseId: string | null } },
): string | null {
  return detail.project.currentReleaseId
    ? new URL(`/try/a/${encodeURIComponent(detail.project.id)}`, publicOrigin).toString()
    : null;
}

function runtimeSessionUrl(publicOrigin: string, sessionId: string): string {
  return new URL(`/try/session/${encodeURIComponent(sessionId)}`, publicOrigin).toString();
}

function runtimeSessionLink(uri: string): McpResourceLink {
  return {
    type: 'resource_link',
    uri,
    name: 'combo-agent-test',
    title: '打开 Agent 测试预览',
    description: '在 Combo Runtime 中查看这个固定 Revision 的真实交互与输出。',
    mimeType: 'text/html',
  };
}

function releasedAgentLink(uri: string): McpResourceLink {
  return {
    type: 'resource_link',
    uri,
    name: 'combo-released-agent',
    title: '打开已发布 Agent',
    description: '打开当前不可变 Release 的稳定使用入口。',
    mimeType: 'text/html',
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderCurrentCodexTaskConnectCommand(connectUrl: string): string {
  return `(set +x; test -n "\${CODEX_THREAD_ID:-}" || { printf '%s\\n' 'CODEX_THREAD_ID is required.' >&2; exit 1; }; combo_connect_script=$(curl -fsSL -- ${shellQuote(connectUrl)}) || exit $?; case "$combo_connect_script" in *[![:space:]]*) ;; *) printf '%s\\n' 'Combo connect script response was empty or whitespace-only.' >&2; exit 1 ;; esac; printf '%s\\n' "$combo_connect_script" | env BASH_ENV=/dev/null ENV=/dev/null COMBO_SOURCE_SCOPE=codex_current_task /bin/sh)`;
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  const id = decodeIdCursor(cursor);
  if (!AgentResourceIdSchema.safeParse(id).success) throw new InvalidCursorError();
  return id;
}

export async function executeExternalMcpTool(
  context: ExecuteToolContext,
  name: string,
  rawArguments: unknown,
): Promise<McpToolResult> {
  const tool = toolByName.get(name);
  if (!tool) return toolFailure(context.traceId, 'Combo 没有这个工具。');
  if (!hasMcpScope(context.principal, tool.requiredScope)) {
    return toolFailure(context.traceId, '当前授权范围不允许执行这个工具，请重新授权 Combo。', {
      action: 'escalate',
    });
  }
  const input = rawArguments ?? {};

  try {
    if (name === 'render_agent_builder') {
      const parsed = renderAgentBuilderInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      return toolSuccess(parsed.data);
    }

    if (name === 'create_extraction_task') {
      const parsed = CreateTaskBodySchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const outcome = await createTask(context.txPool, context.db, {
        ownerUserId: context.principal.userId,
        ...parsed.data,
      });
      if (outcome.kind === 'conflict') {
        return toolFailure(context.traceId, '这个幂等键已被占用，请换一个幂等键。');
      }
      const task = await readTaskView(context.db, outcome.taskId, context.principal.userId);
      if (!task) throw new Error('created task cannot be read back');
      const connectUrl = new URL('/api/v1/connect/script', context.publicOrigin);
      connectUrl.searchParams.set('code', outcome.pairingCode);
      return toolSuccess({
        task,
        connectUrl: connectUrl.toString(),
        connectCommand: renderCurrentCodexTaskConnectCommand(connectUrl.toString()),
        pairingExpiresAt: task.upload.pairingExpiresAt,
      });
    }

    if (name === 'read_extraction_task') {
      const parsed = taskInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      await reconcileExpiredUploadTasks(context.db, {
        traceId: context.traceId,
        ownerUserId: context.principal.userId,
        taskId: parsed.data.taskId,
      });
      const task = await readTaskView(context.db, parsed.data.taskId, context.principal.userId);
      if (!task) return toolFailure(context.traceId, '没有找到这个提取任务。');
      return toolSuccess({ ...task });
    }

    if (name === 'list_capabilities') {
      const parsed = capabilityListInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const limit = parsed.data.limit ?? DEFAULT_PAGE_LIMIT;
      let cursorId: string | undefined;
      try {
        cursorId = decodeCursor(parsed.data.cursor);
      } catch {
        return toolFailure(context.traceId, '分页游标无效，请从第一页重新读取。');
      }
      const page = await listCapabilityViews(context.db, {
        ownerUserId: context.principal.userId,
        limit,
        ...(parsed.data.taskId ? { taskId: parsed.data.taskId } : {}),
        ...(cursorId ? { cursorId } : {}),
      });
      const last = page.items.at(-1);
      return toolSuccess({
        items: page.items,
        page: {
          nextCursor: page.hasMore && last ? encodeIdCursor(last.id) : null,
          hasMore: page.hasMore,
          limit,
        },
        nextAction:
          page.items.length === 0 && !parsed.data.cursor && !parsed.data.taskId
            ? {
                kind: 'extract_capabilities',
                tool: 'create_extraction_task',
                requiresSourceAuthorization: true,
                userMessage:
                  '还没有可用 Capability。请先确认要使用的本地对话历史范围，再开始能力提取。',
              }
            : null,
      });
    }

    if (name === 'read_capability_definition') {
      const parsed = capabilityInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const ref = await readCapabilityDefinitionRef(
        context.db,
        parsed.data.capabilityId,
        context.principal.userId,
      );
      if (!ref) return toolFailure(context.traceId, '没有找到这个 Capability。');
      const raw = JSON.parse(
        await context.objectStore.getObjectText('combo-artifacts', ref.storageKey),
      ) as unknown;
      const definition = CapabilityDefinitionSchema.safeParse(raw);
      if (!definition.success) throw new Error('stored capability definition is invalid');
      return toolSuccess({
        capability: ref.view,
        definition: definition.data,
        definitionSha256: createHash('sha256').update(canonicalJson(definition.data)).digest('hex'),
      });
    }

    if (name === 'list_agent_projects') {
      const parsed = listInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const limit = parsed.data.limit ?? DEFAULT_PAGE_LIMIT;
      let cursorId: string | undefined;
      try {
        cursorId = decodeCursor(parsed.data.cursor);
      } catch {
        return toolFailure(context.traceId, '分页游标无效，请从第一页重新读取。');
      }
      const page = await listAgentProjects(context.db, {
        ownerUserId: context.principal.userId,
        limit,
        ...(cursorId ? { cursorId } : {}),
      });
      const last = page.items.at(-1);
      return toolSuccess({
        items: page.items,
        page: {
          nextCursor: page.hasMore && last ? encodeIdCursor(last.id) : null,
          hasMore: page.hasMore,
          limit,
        },
      });
    }

    if (name === 'create_agent_project') {
      const parsed = CreateAgentProjectBodySchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const outcome = await createAgentProject(context.db, context.principal.userId, parsed.data);
      if (outcome.kind === 'source_task_not_found') {
        return toolFailure(context.traceId, '来源任务不存在或不属于当前账号。');
      }
      if (outcome.kind === 'idempotency_conflict') {
        return toolFailure(context.traceId, '这个幂等键已经用于另一份 Project 内容。');
      }
      const detail = await readAgentProjectDetail(context.db, {
        projectId: outcome.project.id,
        ownerUserId: context.principal.userId,
      });
      if (!detail) throw new Error('created project cannot be read back');
      return toolSuccess({
        project: detail,
        releasedAgentUrl: null,
        target: targetSnapshot(detail),
      });
    }

    if (name === 'target_agent_project') {
      const parsed = projectInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const detail = await readAgentProjectDetail(context.db, {
        projectId: parsed.data.projectId,
        ownerUserId: context.principal.userId,
      });
      if (!detail) return toolFailure(context.traceId, '没有找到这个 Agent Project。');
      return toolSuccess({
        project: detail,
        releasedAgentUrl: releasedAgentUrl(context.publicOrigin, detail),
        target: targetSnapshot(detail),
      });
    }

    if (name === 'read_agent_project') {
      const parsed = projectInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const detail = await readAgentProjectDetail(context.db, {
        projectId: parsed.data.projectId,
        ownerUserId: context.principal.userId,
      });
      if (!detail) return toolFailure(context.traceId, '没有找到这个 Agent Project。');
      return toolSuccess({
        project: detail,
        releasedAgentUrl: releasedAgentUrl(context.publicOrigin, detail),
        target: targetSnapshot(detail),
      });
    }

    if (name === 'save_agent_ui') {
      const parsed = saveUiInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const project = await readAgentProjectDetail(context.db, {
        projectId: parsed.data.projectId,
        ownerUserId: context.principal.userId,
      });
      if (!project) return toolFailure(context.traceId, '没有找到这个 Agent Project。');
      let capabilityId = parsed.data.entryCapabilityId;
      if (!capabilityId) {
        if (!project.project.headRevisionId) {
          return toolFailure(
            context.traceId,
            '第一次保存 Agent UI 前必须显式提供 entryCapabilityId。',
          );
        }
        const revision = await readAgentRevisionDetail(context.db, context.objectStore, {
          projectId: parsed.data.projectId,
          revisionId: project.project.headRevisionId,
          ownerUserId: context.principal.userId,
        });
        if (!revision) return toolFailure(context.traceId, '没有找到当前 Agent Head Revision。');
        capabilityId = revision.revision.entryCapabilityId;
      }
      const studio = await context.runtime.createStudioSession(capabilityId);
      const saved = await context.runtime.saveAgentUiRevision(studio.session.id, {
        html: parsed.data.html,
        title: parsed.data.title ?? 'Agent Miniapp',
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return toolSuccess({
        projectId: parsed.data.projectId,
        studioSessionId: studio.session.id,
        saved,
      });
    }

    if (name === 'read_agent_ui') {
      const parsed = readUiInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      if (parsed.data.artifactId) {
        const ui = await context.runtime.readArtifactContent(parsed.data.artifactId);
        return toolSuccess({ ui, source: { kind: 'explicit-artifact' } });
      }
      const projectId = parsed.data.projectId!;
      const project = await readAgentProjectDetail(context.db, {
        projectId,
        ownerUserId: context.principal.userId,
      });
      if (!project) return toolFailure(context.traceId, '没有找到这个 Agent Project。');
      const revisionId = project.project.headRevisionId;
      if (!revisionId)
        return toolFailure(context.traceId, '这个 Agent Project 还没有 Head Revision。');
      const revision = await readAgentRevisionDetail(context.db, context.objectStore, {
        projectId,
        revisionId,
        ownerUserId: context.principal.userId,
      });
      if (!revision) return toolFailure(context.traceId, '没有找到当前 Agent Head Revision。');
      const ui = await context.runtime.readArtifactContent(revision.revision.uiArtifactId);
      if (ui.artifact.sha256 !== revision.revision.uiSha256) {
        return toolFailure(context.traceId, 'Agent UI 回读摘要与 Head Revision 不一致。', {
          action: 'escalate',
        });
      }
      return toolSuccess({
        ui,
        source: {
          kind: 'head-revision',
          projectId,
          revisionId,
          expectedUiSha256: revision.revision.uiSha256,
          integrityVerified: true,
        },
        target: targetSnapshot(project),
      });
    }

    if (name === 'commit_agent_revision') {
      const parsed = commitInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const { projectId, ...body } = parsed.data;
      const outcome = await saveAgentRevision(context.txPool, context.db, context.objectStore, {
        projectId,
        ownerUserId: context.principal.userId,
        body,
      });
      if (outcome.kind === 'not_found') {
        return toolFailure(context.traceId, 'Project、Capability 或 Miniapp 不存在。');
      }
      if (outcome.kind === 'idempotency_conflict') {
        return toolFailure(context.traceId, '这个 mutationId 已用于另一份 Revision 内容。');
      }
      if (outcome.kind === 'head_conflict') {
        return toolFailure(
          context.traceId,
          'Agent Head 已被更新，请读取最新 Project 后合并修改。',
          {
            details: { currentHeadRevisionId: outcome.currentHeadRevisionId },
          },
        );
      }
      if (outcome.kind === 'compile_failed') {
        return toolFailure(context.traceId, 'Agent 定义没有通过编译契约。', {
          details: { kind: outcome.error.kind, ...(outcome.error.details ?? {}) },
        });
      }
      const detail = await readAgentProjectDetail(context.db, {
        projectId,
        ownerUserId: context.principal.userId,
      });
      if (!detail) throw new Error('committed project cannot be read back');
      return toolSuccess({
        project: detail,
        revision: toAgentRevisionView(outcome.revision),
        target: targetSnapshot(detail),
      });
    }

    if (name === 'read_agent_revision') {
      const parsed = revisionInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      let revisionId = parsed.data.revisionId;
      if (!revisionId) {
        const project = await readAgentProjectDetail(context.db, {
          projectId: parsed.data.projectId,
          ownerUserId: context.principal.userId,
        });
        if (!project) return toolFailure(context.traceId, '没有找到这个 Agent Project。');
        revisionId = project.project.headRevisionId ?? undefined;
      }
      if (!revisionId)
        return toolFailure(context.traceId, '这个 Agent Project 还没有 Head Revision。');
      const detail = await readAgentRevisionDetail(context.db, context.objectStore, {
        projectId: parsed.data.projectId,
        revisionId,
        ownerUserId: context.principal.userId,
      });
      if (!detail) return toolFailure(context.traceId, '没有找到这个 Agent Revision。');
      const { storageKey: _storageKey, ...publicRuntimeUi } = detail.runtimeBundle.ui;
      return toolSuccess({
        revision: detail.revision,
        definition: detail.definition,
        capabilitySnapshots: detail.capabilitySnapshots,
        runtimeBundle: { ...detail.runtimeBundle, ui: publicRuntimeUi },
      });
    }

    if (name === 'run_agent_test') {
      const parsed = runTestInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const revision = await readAgentRevisionDetail(context.db, context.objectStore, {
        projectId: parsed.data.projectId,
        revisionId: parsed.data.revisionId,
        ownerUserId: context.principal.userId,
      });
      if (!revision) return toolFailure(context.traceId, '没有找到这个 Agent Revision。');
      const detail = await context.runtime.startAgentTest(parsed.data.revisionId, {
        text: parsed.data.text,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      const previewUrl = runtimeSessionUrl(context.publicOrigin, detail.test.sessionId);
      return toolSuccess(
        {
          ...detail,
          runtimeSessionUrl: previewUrl,
          checkBackAfterSeconds: detail.test.status === 'running' ? 2 : null,
        },
        [runtimeSessionLink(previewUrl)],
      );
    }

    if (name === 'list_agent_tests') {
      const parsed = listTestsInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const project = await readAgentProjectDetail(context.db, {
        projectId: parsed.data.projectId,
        ownerUserId: context.principal.userId,
      });
      if (!project) return toolFailure(context.traceId, '没有找到这个 Agent Project。');
      const tests = await context.runtime.listAgentTests(parsed.data.projectId, parsed.data.limit);
      return toolSuccess({
        projectId: parsed.data.projectId,
        tests,
        selectedTestId: tests.find((test) => test.status !== 'starting')?.id ?? null,
        target: targetSnapshot(project),
      });
    }

    if (name === 'read_agent_test') {
      const parsed = readTestInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const detail = await context.runtime.readAgentTest(parsed.data.testId);
      const project = await readAgentProjectDetail(context.db, {
        projectId: detail.test.projectId,
        ownerUserId: context.principal.userId,
      });
      if (!project) return toolFailure(context.traceId, '没有找到这个 Agent Test。');
      const previewUrl = runtimeSessionUrl(context.publicOrigin, detail.test.sessionId);
      return toolSuccess(
        {
          ...detail,
          runtimeSessionUrl: previewUrl,
          canPublish: detail.test.canPublish,
          checkBackAfterSeconds: detail.test.status === 'running' ? 2 : null,
        },
        [runtimeSessionLink(previewUrl)],
      );
    }

    if (name === 'record_agent_test_review') {
      const parsed = reviewTestInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const outcome = await recordAgentTestReview(context.txPool, {
        projectId: parsed.data.projectId,
        testId: parsed.data.testId,
        ownerUserId: context.principal.userId,
        body: {
          idempotencyKey: parsed.data.idempotencyKey,
          cases: parsed.data.cases,
          summary: parsed.data.summary,
        },
      });
      if (outcome.kind === 'not_found') {
        return toolFailure(context.traceId, '没有找到这个 Agent Project 或 Test。');
      }
      if (outcome.kind === 'idempotency_conflict') {
        return toolFailure(context.traceId, '这个幂等键已经用于另一份质量复核正文。');
      }
      if (outcome.kind === 'test_not_passed') {
        return toolFailure(context.traceId, '只有技术执行已经通过的 Agent Test 才能记录质量复核。');
      }
      if (outcome.kind === 'review_exists') {
        return toolFailure(
          context.traceId,
          '这个 Test 已有不可变质量复核；需要改变结论时请重新运行 Test。',
        );
      }
      const project = await readAgentProjectDetail(context.db, {
        projectId: parsed.data.projectId,
        ownerUserId: context.principal.userId,
      });
      if (!project) throw new Error('reviewed project cannot be read back');
      const canPublish =
        (outcome.review.qualityStatus === 'passed' ||
          outcome.review.qualityStatus === 'accepted_exception') &&
        project.project.headRevisionId === outcome.review.agentRevisionId;
      return toolSuccess({
        review: outcome.review,
        canPublish,
        target: targetSnapshot(project),
      });
    }

    if (name === 'publish_agent_revision') {
      const parsed = publishInputSchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const test = await context.runtime.readAgentTest(parsed.data.testId);
      if (test.test.projectId !== parsed.data.projectId) {
        return toolFailure(context.traceId, '所选 Test 属于另一个 Agent Project。');
      }
      if (test.test.status !== 'passed') {
        return toolFailure(context.traceId, '所选 Agent Test 尚未通过。');
      }
      if (
        test.test.canPublish === false ||
        test.test.qualityStatus === 'unreviewed' ||
        test.test.qualityStatus === 'failed'
      ) {
        return toolFailure(context.traceId, '所选 Test 还没有通过或已接受例外的不可变质量复核。');
      }
      const project = await readAgentProjectDetail(context.db, {
        projectId: parsed.data.projectId,
        ownerUserId: context.principal.userId,
      });
      if (!project) return toolFailure(context.traceId, '没有找到这个 Agent Project。');
      if (project.project.headRevisionId !== test.test.agentRevisionId) {
        return toolFailure(context.traceId, '已通过的 Test 不再匹配当前 Agent Head。');
      }
      const body = CreateAgentReleaseBodySchema.parse({
        expectedHeadRevisionId: test.test.agentRevisionId,
        agentRevisionId: test.test.agentRevisionId,
        qualifyingTestId: test.test.id,
        idempotencyKey: parsed.data.idempotencyKey,
        notes: parsed.data.notes ?? '',
      });
      const outcome = await publishAgentRevision(context.txPool, context.db, context.objectStore, {
        projectId: parsed.data.projectId,
        ownerUserId: context.principal.userId,
        body,
      });
      if (outcome.kind === 'not_found') {
        return toolFailure(context.traceId, 'Project、Revision 或 Test 不存在。');
      }
      if (outcome.kind === 'idempotency_conflict') {
        return toolFailure(context.traceId, '这个幂等键已经用于另一份 Release 内容。');
      }
      if (outcome.kind === 'head_conflict') {
        return toolFailure(context.traceId, '只能发布当前 Agent Head。', {
          details: { currentHeadRevisionId: outcome.currentHeadRevisionId },
        });
      }
      if (outcome.kind === 'test_not_passed') {
        return toolFailure(context.traceId, '发布要求同一 Revision 的真实 Runtime Test 已通过。');
      }
      if (outcome.kind === 'review_not_publishable') {
        return toolFailure(context.traceId, '发布要求该 Test 已有可发布的不可变质量复核。');
      }
      if (outcome.kind === 'capability_ineligible') {
        return toolFailure(context.traceId, '占位能力不可用于 Agent。');
      }
      const detail = await readAgentProjectDetail(context.db, {
        projectId: parsed.data.projectId,
        ownerUserId: context.principal.userId,
      });
      if (!detail) throw new Error('released project cannot be read back');
      const releaseUrl = releasedAgentUrl(context.publicOrigin, detail);
      if (!releaseUrl) throw new Error('released project is missing its stable URL');
      return toolSuccess(
        {
          project: detail,
          release: outcome.release,
          releasedAgentUrl: releaseUrl,
          target: targetSnapshot(detail),
        },
        [releasedAgentLink(releaseUrl)],
      );
    }

    if (name === 'create_project_agent_share') {
      const parsed = CreateProjectAgentShareBodySchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const outcome = await createProjectAgentShare(context.db, {
        ownerUserId: context.principal.userId,
        body: parsed.data,
        publicOrigin: context.publicOrigin,
      });
      if (outcome.kind === 'idempotency_conflict') {
        return toolFailure(context.traceId, '这个幂等键已经用于另一份 Project Agent manifest。');
      }
      return toolSuccess(outcome.result, [
        {
          type: 'resource_link',
          uri: outcome.result.shareUrl,
          name: 'combo-project-agent-share',
          title: '打开 Project Agent 分享',
          description: '审查这份不可变 Git Project manifest 与恢复边界。',
          mimeType: 'text/html',
        },
      ]);
    }

    if (name === 'read_project_agent_share') {
      const parsed = ReadProjectAgentShareBodySchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const outcome = await readProjectAgentShare(context.db, {
        publicOrigin: context.publicOrigin,
        shareUrl: parsed.data.shareUrl,
      });
      if (outcome.kind === 'invalid_url') {
        return toolFailure(context.traceId, '分享链接不属于当前 Combo 环境或格式无效。');
      }
      if (outcome.kind === 'not_found') {
        return toolFailure(context.traceId, '没有找到这个 Project Agent 分享。');
      }
      return toolSuccess(outcome.result, [
        {
          type: 'resource_link',
          uri: outcome.result.shareUrl,
          name: 'combo-project-agent-share',
          title: '打开 Project Agent 分享',
          description: '审查这份不可信项目的来源、固定版本和依赖。',
          mimeType: 'text/html',
        },
      ]);
    }

    if (name === 'create_codex_agent_share') {
      const parsed = CreateCodexAgentShareBodySchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const outcome = await createCodexAgentShare(context.db, {
        ownerUserId: context.principal.userId,
        body: parsed.data,
        publicOrigin: context.publicOrigin,
        comboEnvironment: context.comboEnvironment,
      });
      if (outcome.kind === 'environment_conflict') {
        return toolFailure(
          context.traceId,
          'Codex Agent Share V1 的接收文案固定连接 Combo Test，当前环境只允许读取，不能创建新分享。',
        );
      }
      if (outcome.kind === 'idempotency_conflict') {
        return toolFailure(context.traceId, '这个幂等键已经用于另一份 Codex Agent manifest。');
      }
      return {
        content: [
          { type: 'text', text: '{"created":true}' },
          {
            type: 'resource_link',
            uri: outcome.result.shareUrl,
            name: 'combo-codex-agent-share',
            title: '打开 Codex Agent 分享',
            description: '审查当前任务派生的公开 Agent 定义、固定 Project 和接收边界。',
            mimeType: 'text/html',
          },
        ],
        structuredContent: outcome.result,
      };
    }

    if (name === 'read_codex_agent_share') {
      const parsed = ReadCodexAgentShareBodySchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const outcome = await readCodexAgentShare(context.db, {
        publicOrigin: context.publicOrigin,
        shareUrl: parsed.data.shareUrl,
      });
      if (outcome.kind === 'invalid_url') {
        return toolFailure(context.traceId, '分享链接不属于当前 Combo 环境或格式无效。');
      }
      if (outcome.kind === 'not_found') {
        return toolFailure(context.traceId, '没有找到这个 Codex Agent 分享。');
      }
      return {
        content: [
          { type: 'text', text: '{"read":true}' },
          {
            type: 'resource_link',
            uri: outcome.result.shareUrl,
            name: 'combo-codex-agent-share',
            title: '打开 Codex Agent 分享',
            description:
              '审查公开派生 instructions、固定 Project、manifest digest，以及“无独立 raw-task blob、公开自由文本仍需审查”的边界。',
            mimeType: 'text/html',
          },
        ],
        structuredContent: outcome.result,
      };
    }

    if (name === 'prepare_codex_agent_run') {
      const parsed = PrepareCodexAgentRunBodySchema.safeParse(input);
      if (!parsed.success) return validationFailure(context.traceId, parsed.error);
      const outcome = await prepareCodexAgentRun(context.db, {
        publicOrigin: context.publicOrigin,
        body: parsed.data,
      });
      if (outcome.kind === 'invalid_url') {
        return toolFailure(context.traceId, '分享链接不属于当前 Combo 环境或格式无效。');
      }
      if (outcome.kind === 'not_found') {
        return toolFailure(context.traceId, '没有找到这个 Codex Agent 分享。');
      }
      if (outcome.kind === 'digest_mismatch') {
        return toolFailure(
          context.traceId,
          'Manifest 摘要与用户确认的分享不一致，已停止准备运行。',
        );
      }
      if (outcome.kind === 'starter_not_found') {
        return toolFailure(
          context.traceId,
          '所选 starter 不属于用户刚确认的 manifest，已停止准备运行。',
        );
      }
      return {
        content: [{ type: 'text', text: '{"prepared":true}' }],
        structuredContent: outcome.result,
      };
    }
  } catch (error) {
    if (error instanceof AgentCompileDependencyError) {
      return toolFailure(context.traceId, 'Agent 编译依赖暂时不可用，请稍后重试。', {
        retriable: true,
        action: 'retry',
      });
    }
    if (error instanceof AgentRevisionIntegrityError) {
      return toolFailure(context.traceId, 'Revision 完整性校验失败，请联系支持。', {
        action: 'escalate',
      });
    }
    if (error instanceof McpRuntimeRequestError) {
      return toolFailure(error.traceId ?? context.traceId, error.message, {
        retriable: error.retriable,
        action:
          error.action === 'retry' ||
          error.action === 'change_input' ||
          error.action === 'escalate' ||
          error.action === 'wait'
            ? error.action
            : 'change_input',
        ...(error.details ? { details: error.details } : {}),
      });
    }
    return toolFailure(context.traceId, 'Combo 暂时无法完成这个工具调用，请稍后重试。', {
      retriable: true,
      action: 'retry',
    });
  }

  return toolFailure(context.traceId, 'Combo 没有这个工具。');
}

/** 生产 Fastify Pool 到工具事务端口的唯一适配点。 */
export function toolTxPool(db: Parameters<typeof asTxPool>[0]): TxPool {
  return asTxPool(db);
}
