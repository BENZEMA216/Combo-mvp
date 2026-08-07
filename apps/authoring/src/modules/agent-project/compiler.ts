import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import {
  AGENT_COMPILER_VERSION,
  AgentRuntimeBundleSchema,
  CapabilityDefinitionSchema,
  canonicalJson,
  validateAgentMiniappHtml,
  type AgentCapabilitySnapshot,
  type AgentDefinition,
  type AgentRuntimeBundle,
  type ObjectStorePort,
} from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import { isFallbackCapabilityMeta } from '../capability/eligibility.js';

export const AGENT_ARTIFACT_BUCKET = 'combo-artifacts' as const;

export type AgentCompileFailure =
  | 'capability_not_found'
  | 'capability_ineligible'
  | 'capability_invalid'
  | 'ui_not_found'
  | 'ui_capability_mismatch'
  | 'ui_invalid'
  | 'output_schema_invalid';

export class AgentCompileError extends Error {
  constructor(
    readonly kind: AgentCompileFailure,
    readonly details?: Record<string, unknown>,
  ) {
    super(kind);
    this.name = 'AgentCompileError';
  }
}

export class AgentCompileDependencyError extends Error {
  constructor(readonly source: 'capability_definition' | 'ui_artifact') {
    super(`Agent compiler dependency unavailable: ${source}`);
    this.name = 'AgentCompileDependencyError';
  }
}

export interface AgentRevisionDocument {
  definition: AgentDefinition;
  capabilitySnapshots: AgentCapabilitySnapshot[];
}

export interface CompiledAgentRevision {
  entryCapabilityId: string;
  definitionDocument: AgentRevisionDocument;
  definitionStorageKey: string;
  definitionSha256: string;
  runtimeBundle: AgentRuntimeBundle;
  runtimeBundleStorageKey: string;
  runtimeBundleSha256: string;
  uiArtifactId: string;
  uiStorageKey: string;
  uiSha256: string;
}

interface CapabilitySourceRow {
  id: string;
  storage_key: string;
  meta: unknown;
}

interface UiSourceRow {
  id: string;
  storage_key: string;
  capability_id: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateStructuredOutputSchema(definition: AgentDefinition): void {
  if (definition.interface.output.type !== 'structured') return;
  try {
    const validate = new Ajv({ strict: false }).compile(definition.interface.output.schema);
    if ((validate as { $async?: boolean }).$async) {
      throw new Error('async JSON Schema is not supported');
    }
  } catch {
    throw new AgentCompileError('output_schema_invalid');
  }
}

export function definitionStorageKey(
  projectId: string,
  revisionId: string,
  contentSha256: string,
): string {
  return `agent-projects/${projectId}/revisions/${revisionId}/definition-${contentSha256}.json`;
}

export function runtimeBundleStorageKey(
  projectId: string,
  revisionId: string,
  contentSha256: string,
): string {
  return `agent-projects/${projectId}/revisions/${revisionId}/runtime-bundle-${contentSha256}.json`;
}

function outputInstructions(definition: AgentDefinition): string {
  if (definition.interface.output.type === 'text') return '以清晰、可直接使用的文本交付结果。';
  return [
    '最终结果必须是符合以下 JSON Schema 的单个 JSON 值。',
    canonicalJson(definition.interface.output.schema),
  ].join('\n');
}

function composeRuntimeInstructions(
  definition: AgentDefinition,
  snapshots: AgentCapabilitySnapshot[],
): string {
  const playbooks = snapshots.map((snapshot, index) =>
    [
      `## 冻结能力 ${index + 1}（${snapshot.role}）：${snapshot.definition.name}`,
      snapshot.definition.summary,
      snapshot.definition.instructions,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return [
    '# Agent 行为',
    definition.behavior.instructions,
    '# 输出约定',
    outputInstructions(definition),
    '# 冻结能力 Playbook',
    ...playbooks,
  ].join('\n\n');
}

async function loadCapabilitySnapshots(
  db: Queryable,
  objectStore: ObjectStorePort,
  ownerUserId: string,
  definition: AgentDefinition,
): Promise<AgentCapabilitySnapshot[]> {
  const ids = definition.behavior.capabilities.map((binding) => binding.capabilityId);
  const rows = await db.query<CapabilitySourceRow>(
    `SELECT id, storage_key, meta
       FROM capabilities
      WHERE owner_user_id = $1 AND id = ANY($2::uuid[])`,
    [ownerUserId, ids],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const snapshots: AgentCapabilitySnapshot[] = [];
  for (const binding of definition.behavior.capabilities) {
    const row = byId.get(binding.capabilityId);
    if (!row) {
      throw new AgentCompileError('capability_not_found', {
        capabilityId: binding.capabilityId,
      });
    }
    if (isFallbackCapabilityMeta(row.meta)) {
      throw new AgentCompileError('capability_ineligible', {
        capabilityId: binding.capabilityId,
      });
    }
    let definitionText: string;
    try {
      definitionText = await objectStore.getObjectText(AGENT_ARTIFACT_BUCKET, row.storage_key);
    } catch {
      throw new AgentCompileDependencyError('capability_definition');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(definitionText);
    } catch {
      throw new AgentCompileError('capability_invalid', {
        capabilityId: binding.capabilityId,
      });
    }
    const parsed = CapabilityDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AgentCompileError('capability_invalid', {
        capabilityId: binding.capabilityId,
      });
    }
    if (isFallbackCapabilityMeta(parsed.data.meta)) {
      throw new AgentCompileError('capability_ineligible', {
        capabilityId: binding.capabilityId,
      });
    }
    snapshots.push({
      capabilityId: binding.capabilityId,
      role: binding.role,
      definition: parsed.data,
      definitionSha256: sha256(canonicalJson(parsed.data)),
    });
  }
  return snapshots;
}

async function loadUiSource(
  db: Queryable,
  objectStore: ObjectStorePort,
  input: { artifactId: string; ownerUserId: string; entryCapabilityId: string },
): Promise<{ storageKey: string; html: string; sha256: string }> {
  const result = await db.query<UiSourceRow>(
    `SELECT a.id, a.storage_key, s.capability_id
       FROM artifacts a
       JOIN sessions s ON s.id = a.session_id
       LEFT JOIN turns t ON t.id = a.turn_id
      WHERE a.id = $1
        AND s.owner_user_id = $2
        AND s.mode = 'studio'
        AND a.kind = 'html'
        AND (a.turn_id IS NULL OR t.status = 'completed')
      LIMIT 1`,
    [input.artifactId, input.ownerUserId],
  );
  const row = result.rows[0];
  if (!row) throw new AgentCompileError('ui_not_found', { artifactId: input.artifactId });
  if (row.capability_id !== input.entryCapabilityId) {
    throw new AgentCompileError('ui_capability_mismatch', {
      artifactId: input.artifactId,
      entryCapabilityId: input.entryCapabilityId,
    });
  }
  let html: string;
  try {
    html = await objectStore.getObjectText(AGENT_ARTIFACT_BUCKET, row.storage_key);
  } catch {
    throw new AgentCompileDependencyError('ui_artifact');
  }
  const validation = validateAgentMiniappHtml(html);
  if (!validation.ok) {
    throw new AgentCompileError('ui_invalid', { issues: validation.errors });
  }
  return { storageKey: row.storage_key, html, sha256: sha256(html) };
}

/** 读取并冻结 Capability 与 UI，写入不可变 Revision 文档和 Runtime Bundle。 */
export async function compileAgentRevision(
  db: Queryable,
  objectStore: ObjectStorePort,
  input: {
    projectId: string;
    revisionId: string;
    ownerUserId: string;
    definition: AgentDefinition;
  },
): Promise<CompiledAgentRevision> {
  validateStructuredOutputSchema(input.definition);
  const capabilitySnapshots = await loadCapabilitySnapshots(
    db,
    objectStore,
    input.ownerUserId,
    input.definition,
  );
  const entry = capabilitySnapshots.find((snapshot) => snapshot.role === 'entry');
  if (!entry) throw new AgentCompileError('capability_not_found');
  const ui = await loadUiSource(db, objectStore, {
    artifactId: input.definition.ui.artifactId,
    ownerUserId: input.ownerUserId,
    entryCapabilityId: entry.capabilityId,
  });

  const runtimeDefinition = CapabilityDefinitionSchema.parse({
    version: 1,
    name: input.definition.identity.name,
    summary: input.definition.identity.summary,
    kind: 'agent',
    instructions: composeRuntimeInstructions(input.definition, capabilitySnapshots),
    inputs: input.definition.interface.inputs,
    starterPrompts: input.definition.interface.starterPrompts,
    meta: {
      agent: {
        schemaVersion: input.definition.schemaVersion,
        projectId: input.projectId,
        revisionId: input.revisionId,
        compilerVersion: AGENT_COMPILER_VERSION,
        output: input.definition.interface.output,
      },
    },
  });
  const runtimeBundle = AgentRuntimeBundleSchema.parse({
    version: 1,
    compilerVersion: AGENT_COMPILER_VERSION,
    projectId: input.projectId,
    revisionId: input.revisionId,
    entryCapabilityId: entry.capabilityId,
    definition: runtimeDefinition,
    capabilityHashes: capabilitySnapshots.map((snapshot) => ({
      capabilityId: snapshot.capabilityId,
      role: snapshot.role,
      definitionSha256: snapshot.definitionSha256,
    })),
    ui: {
      artifactId: input.definition.ui.artifactId,
      storageKey: ui.storageKey,
      sha256: ui.sha256,
      bridgeVersion: 1,
    },
  });
  const definitionDocument: AgentRevisionDocument = {
    definition: input.definition,
    capabilitySnapshots,
  };
  const definitionText = canonicalJson(definitionDocument);
  const runtimeBundleText = canonicalJson(runtimeBundle);
  const definitionSha256 = sha256(definitionText);
  const runtimeBundleSha256 = sha256(runtimeBundleText);
  // revisionId 由 projectId + mutationId 决定；同一个 mutationId 携带不同正文的并发请求
  // 必须写向不同键，否则落库赢家可能被另一请求覆盖成不匹配的对象。
  const definitionKey = definitionStorageKey(input.projectId, input.revisionId, definitionSha256);
  const runtimeKey = runtimeBundleStorageKey(
    input.projectId,
    input.revisionId,
    runtimeBundleSha256,
  );

  await objectStore.putObject(
    AGENT_ARTIFACT_BUCKET,
    definitionKey,
    new TextEncoder().encode(definitionText),
    { contentType: 'application/json; charset=utf-8' },
  );
  await objectStore.putObject(
    AGENT_ARTIFACT_BUCKET,
    runtimeKey,
    new TextEncoder().encode(runtimeBundleText),
    { contentType: 'application/json; charset=utf-8' },
  );

  return {
    entryCapabilityId: entry.capabilityId,
    definitionDocument,
    definitionStorageKey: definitionKey,
    definitionSha256,
    runtimeBundle,
    runtimeBundleStorageKey: runtimeKey,
    runtimeBundleSha256,
    uiArtifactId: input.definition.ui.artifactId,
    uiStorageKey: ui.storageKey,
    uiSha256: ui.sha256,
  };
}
