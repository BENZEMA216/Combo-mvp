import { createHash } from 'node:crypto';
import { AgentRuntimeBundleSchema, type AgentRuntimeBundle } from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import { ARTIFACT_BUCKET } from '../artifact/repo.js';

interface AgentRevisionDbRow {
  id: string;
  project_id: string;
  entry_capability_id: string;
  runtime_bundle_storage_key: string;
  runtime_bundle_sha256: string;
  ui_artifact_id: string;
  ui_storage_key: string;
  ui_sha256: string;
  release_id?: string | null;
}

export interface LoadedAgentRevision {
  projectId: string;
  revisionId: string;
  releaseId: string | null;
  entryCapabilityId: string;
  runtimeBundleSha256: string;
  uiArtifactId: string;
  uiStorageKey: string;
  uiSha256: string;
  bundle: AgentRuntimeBundle;
}

export type LoadAgentRevisionResult =
  | { kind: 'ok'; revision: LoadedAgentRevision }
  | { kind: 'not_found' }
  | { kind: 'invalid_bundle' };

const REVISION_COLUMNS = `r.id, r.project_id, r.entry_capability_id,
  r.runtime_bundle_storage_key, r.runtime_bundle_sha256,
  r.ui_artifact_id, r.ui_storage_key, r.ui_sha256`;

async function loadRow(
  objectStore: RuntimeObjectStore,
  row: AgentRevisionDbRow | undefined,
): Promise<LoadAgentRevisionResult> {
  if (!row) return { kind: 'not_found' };
  let text: string;
  try {
    text = await objectStore.getObjectText(ARTIFACT_BUCKET, row.runtime_bundle_storage_key);
  } catch {
    return { kind: 'invalid_bundle' };
  }
  if (createHash('sha256').update(text).digest('hex') !== row.runtime_bundle_sha256) {
    return { kind: 'invalid_bundle' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'invalid_bundle' };
  }
  const parsed = AgentRuntimeBundleSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.projectId !== row.project_id ||
    parsed.data.revisionId !== row.id ||
    parsed.data.entryCapabilityId !== row.entry_capability_id ||
    parsed.data.ui.artifactId !== row.ui_artifact_id ||
    parsed.data.ui.storageKey !== row.ui_storage_key ||
    parsed.data.ui.sha256 !== row.ui_sha256
  ) {
    return { kind: 'invalid_bundle' };
  }
  return {
    kind: 'ok',
    revision: {
      projectId: row.project_id,
      revisionId: row.id,
      releaseId: row.release_id ?? null,
      entryCapabilityId: row.entry_capability_id,
      runtimeBundleSha256: row.runtime_bundle_sha256,
      uiArtifactId: row.ui_artifact_id,
      uiStorageKey: row.ui_storage_key,
      uiSha256: row.ui_sha256,
      bundle: parsed.data,
    },
  };
}

/** 创作者启动 Revision Test 时按 Project owner 读取。 */
export async function loadOwnedAgentRevision(
  db: Queryable,
  objectStore: RuntimeObjectStore,
  input: { revisionId: string; ownerUserId: string },
): Promise<LoadAgentRevisionResult> {
  const result = await db.query<AgentRevisionDbRow>(
    `SELECT ${REVISION_COLUMNS}, NULL::uuid AS release_id
       FROM agent_revisions r
       JOIN agent_projects p ON p.id = r.project_id
      WHERE r.id = $1 AND p.owner_user_id = $2 AND p.status = 'active'`,
    [input.revisionId, input.ownerUserId],
  );
  return loadRow(objectStore, result.rows[0]);
}

/** 新建正式 Session 时只解析一次 Project 当前 Release。 */
export async function loadCurrentAgentRelease(
  db: Queryable,
  objectStore: RuntimeObjectStore,
  projectId: string,
): Promise<LoadAgentRevisionResult> {
  const result = await db.query<AgentRevisionDbRow>(
    `SELECT ${REVISION_COLUMNS}, rel.id AS release_id
       FROM agent_projects p
       JOIN agent_releases rel ON rel.id = p.current_release_id AND rel.project_id = p.id
       JOIN agent_revisions r ON r.id = rel.agent_revision_id AND r.project_id = p.id
      WHERE p.id = $1 AND p.status = 'active'`,
    [projectId],
  );
  return loadRow(objectStore, result.rows[0]);
}

/** 已创建 Session 永远按自身固定的 Revision/Release 加载，不追随 Project 当前指针。 */
export async function loadPinnedSessionAgentRevision(
  db: Queryable,
  objectStore: RuntimeObjectStore,
  input: { revisionId: string; releaseId: string | null; sessionOwnerUserId: string },
): Promise<LoadAgentRevisionResult> {
  const result = input.releaseId
    ? await db.query<AgentRevisionDbRow>(
        `SELECT ${REVISION_COLUMNS}, rel.id AS release_id
           FROM agent_revisions r
           JOIN agent_releases rel
             ON rel.agent_revision_id = r.id AND rel.project_id = r.project_id
          WHERE r.id = $1 AND rel.id = $2`,
        [input.revisionId, input.releaseId],
      )
    : await db.query<AgentRevisionDbRow>(
        `SELECT ${REVISION_COLUMNS}, NULL::uuid AS release_id
           FROM agent_revisions r
           JOIN agent_projects p ON p.id = r.project_id
          WHERE r.id = $1 AND p.owner_user_id = $2`,
        [input.revisionId, input.sessionOwnerUserId],
      );
  return loadRow(objectStore, result.rows[0]);
}
