import { createHash, randomUUID } from 'node:crypto';
import {
  AgentTestReviewViewSchema,
  canonicalJson,
  type AgentProjectView,
  type AgentReleaseView,
  type AgentRevisionView,
  type AgentTestReviewCase,
  type AgentTestReviewStatus,
  type AgentTestReviewView,
} from '@cb/shared';
import { toIso, type Queryable } from '../../platform/infra/db.js';
import { withTransaction, type TxPool } from '../../platform/infra/db-tx.js';
import type { CompiledAgentRevision } from './compiler.js';

interface AgentProjectRow {
  id: string;
  owner_user_id: string;
  name: string;
  summary: string;
  source_task_id: string | null;
  status: 'active' | 'archived';
  head_revision_id: string | null;
  current_release_id: string | null;
  idempotency_key: string;
  idempotency_sha256: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface AgentRevisionRecord {
  id: string;
  projectId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  entryCapabilityId: string;
  definitionStorageKey: string;
  definitionSha256: string;
  runtimeBundleStorageKey: string;
  runtimeBundleSha256: string;
  uiArtifactId: string;
  uiStorageKey: string;
  uiSha256: string;
  compilerVersion: string;
  changeSummary: string;
  mutationId: string;
  mutationSha256: string;
  createdAt: string;
}

interface AgentRevisionRow {
  id: string;
  project_id: string;
  revision_number: string | number;
  parent_revision_id: string | null;
  entry_capability_id: string;
  definition_storage_key: string;
  definition_sha256: string;
  runtime_bundle_storage_key: string;
  runtime_bundle_sha256: string;
  ui_artifact_id: string;
  ui_storage_key: string;
  ui_sha256: string;
  compiler_version: string;
  change_summary: string;
  mutation_id: string;
  mutation_sha256: string;
  created_at: string | Date;
}

interface AgentReleaseRow {
  id: string;
  project_id: string;
  version_number: string | number;
  agent_revision_id: string;
  qualifying_test_id: string;
  qualifying_review_id: string | null;
  review_sha256: string | null;
  runtime_bundle_sha256: string;
  ui_sha256: string;
  release_sha256: string;
  notes: string;
  idempotency_key: string;
  idempotency_sha256: string;
  created_at: string | Date;
}

interface AgentTestReviewRow {
  id: string;
  project_id: string;
  test_id: string;
  agent_revision_id: string;
  runtime_bundle_sha256: string;
  ui_sha256: string;
  quality_status: AgentTestReviewStatus;
  cases: unknown;
  summary: string;
  review_sha256: string;
  idempotency_key: string;
  idempotency_sha256: string;
  created_by_user_id: string;
  created_at: string | Date;
}

const PROJECT_COLUMNS = `id, owner_user_id, name, summary, source_task_id, status,
  head_revision_id, current_release_id, idempotency_key, idempotency_sha256,
  created_at, updated_at`;
const REVISION_COLUMNS = `id, project_id, revision_number, parent_revision_id,
  entry_capability_id, definition_storage_key, definition_sha256,
  runtime_bundle_storage_key, runtime_bundle_sha256, ui_artifact_id, ui_storage_key,
  ui_sha256, compiler_version, change_summary, mutation_id, mutation_sha256, created_at`;
const RELEASE_COLUMNS = `id, project_id, version_number, agent_revision_id,
  qualifying_test_id, qualifying_review_id, review_sha256,
  runtime_bundle_sha256, ui_sha256, release_sha256, notes,
  idempotency_key, idempotency_sha256, created_at`;
const TEST_REVIEW_COLUMNS = `id, project_id, test_id, agent_revision_id,
  runtime_bundle_sha256, ui_sha256, quality_status, cases, summary, review_sha256,
  idempotency_key, idempotency_sha256, created_by_user_id, created_at`;

function toProjectView(row: AgentProjectRow): AgentProjectView {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    sourceTaskId: row.source_task_id,
    status: row.status,
    headRevisionId: row.head_revision_id,
    currentReleaseId: row.current_release_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toRevisionRecord(row: AgentRevisionRow): AgentRevisionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    revisionNumber: Number(row.revision_number),
    parentRevisionId: row.parent_revision_id,
    entryCapabilityId: row.entry_capability_id,
    definitionStorageKey: row.definition_storage_key,
    definitionSha256: row.definition_sha256,
    runtimeBundleStorageKey: row.runtime_bundle_storage_key,
    runtimeBundleSha256: row.runtime_bundle_sha256,
    uiArtifactId: row.ui_artifact_id,
    uiStorageKey: row.ui_storage_key,
    uiSha256: row.ui_sha256,
    compilerVersion: row.compiler_version,
    changeSummary: row.change_summary,
    mutationId: row.mutation_id,
    mutationSha256: row.mutation_sha256,
    createdAt: toIso(row.created_at),
  };
}

export function toAgentRevisionView(record: AgentRevisionRecord): AgentRevisionView {
  return {
    id: record.id,
    projectId: record.projectId,
    revisionNumber: record.revisionNumber,
    parentRevisionId: record.parentRevisionId,
    entryCapabilityId: record.entryCapabilityId,
    definitionSha256: record.definitionSha256,
    runtimeBundleSha256: record.runtimeBundleSha256,
    uiArtifactId: record.uiArtifactId,
    uiSha256: record.uiSha256,
    compilerVersion: record.compilerVersion,
    changeSummary: record.changeSummary,
    createdAt: record.createdAt,
  };
}

function toReleaseView(row: AgentReleaseRow): AgentReleaseView {
  return {
    id: row.id,
    projectId: row.project_id,
    versionNumber: Number(row.version_number),
    agentRevisionId: row.agent_revision_id,
    qualifyingTestId: row.qualifying_test_id,
    qualifyingReviewId: row.qualifying_review_id,
    reviewSha256: row.review_sha256,
    runtimeBundleSha256: row.runtime_bundle_sha256,
    uiSha256: row.ui_sha256,
    releaseSha256: row.release_sha256,
    notes: row.notes,
    runtimePath: `/try/a/${row.project_id}`,
    createdAt: toIso(row.created_at),
  };
}

function toTestReviewView(row: AgentTestReviewRow): AgentTestReviewView {
  const reviewedAt = toIso(row.created_at);
  return AgentTestReviewViewSchema.parse({
    id: row.id,
    projectId: row.project_id,
    testId: row.test_id,
    agentRevisionId: row.agent_revision_id,
    qualityStatus: row.quality_status,
    cases: row.cases,
    summary: row.summary,
    reviewSha256: row.review_sha256,
    reviewerUserId: row.created_by_user_id,
    reviewedAt,
    acceptedAt: row.quality_status === 'accepted_exception' ? reviewedAt : null,
  });
}

export async function isOwnedSourceTask(
  db: Queryable,
  taskId: string,
  ownerUserId: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM tasks WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
    [taskId, ownerUserId],
  );
  return result.rows[0] !== undefined;
}

export type CreateProjectOutcome =
  | { kind: 'created' | 'replayed'; project: AgentProjectView }
  | { kind: 'idempotency_conflict' };

export async function createAgentProject(
  db: Queryable,
  input: {
    ownerUserId: string;
    name: string;
    summary: string;
    sourceTaskId?: string;
    idempotencyKey: string;
    idempotencySha256: string;
  },
): Promise<CreateProjectOutcome> {
  const inserted = await db.query<AgentProjectRow>(
    `INSERT INTO agent_projects
       (owner_user_id, name, summary, source_task_id, idempotency_key, idempotency_sha256)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING
     RETURNING ${PROJECT_COLUMNS}`,
    [
      input.ownerUserId,
      input.name,
      input.summary,
      input.sourceTaskId ?? null,
      input.idempotencyKey,
      input.idempotencySha256,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { kind: 'created', project: toProjectView(created) };
  const existing = await db.query<AgentProjectRow>(
    `SELECT ${PROJECT_COLUMNS}
       FROM agent_projects
      WHERE owner_user_id = $1 AND idempotency_key = $2`,
    [input.ownerUserId, input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row || row.idempotency_sha256 !== input.idempotencySha256) {
    return { kind: 'idempotency_conflict' };
  }
  return { kind: 'replayed', project: toProjectView(row) };
}

export async function listAgentProjects(
  db: Queryable,
  input: { ownerUserId: string; limit: number; cursorId?: string },
): Promise<{ items: AgentProjectView[]; hasMore: boolean }> {
  const result = await db.query<AgentProjectRow>(
    `SELECT ${PROJECT_COLUMNS}
       FROM agent_projects
      WHERE owner_user_id = $1
        AND status = 'active'
        AND ($2::uuid IS NULL OR id < $2)
      ORDER BY id DESC
      LIMIT $3`,
    [input.ownerUserId, input.cursorId ?? null, input.limit + 1],
  );
  return {
    items: result.rows.slice(0, input.limit).map(toProjectView),
    hasMore: result.rows.length > input.limit,
  };
}

export async function readAgentProject(
  db: Queryable,
  projectId: string,
  ownerUserId: string,
): Promise<AgentProjectView | null> {
  const result = await db.query<AgentProjectRow>(
    `SELECT ${PROJECT_COLUMNS}
       FROM agent_projects
      WHERE id = $1 AND owner_user_id = $2 AND status = 'active'`,
    [projectId, ownerUserId],
  );
  const row = result.rows[0];
  return row ? toProjectView(row) : null;
}

export async function readAgentRevisionRecord(
  db: Queryable,
  input: { projectId: string; revisionId: string; ownerUserId: string },
): Promise<AgentRevisionRecord | null> {
  const result = await db.query<AgentRevisionRow>(
    `SELECT ${REVISION_COLUMNS.replaceAll(/\b(id|created_at)\b/g, 'r.$1')}
       FROM agent_revisions r
       JOIN agent_projects p ON p.id = r.project_id
      WHERE r.id = $1 AND r.project_id = $2 AND p.owner_user_id = $3 AND p.status = 'active'`,
    [input.revisionId, input.projectId, input.ownerUserId],
  );
  const row = result.rows[0];
  return row ? toRevisionRecord(row) : null;
}

export async function readRevisionByMutation(
  db: Queryable,
  input: { projectId: string; mutationId: string; ownerUserId: string },
): Promise<AgentRevisionRecord | null> {
  const result = await db.query<AgentRevisionRow>(
    `SELECT ${REVISION_COLUMNS.replaceAll(/\b(id|created_at)\b/g, 'r.$1')}
       FROM agent_revisions r
       JOIN agent_projects p ON p.id = r.project_id
      WHERE r.project_id = $1 AND r.mutation_id = $2
        AND p.owner_user_id = $3 AND p.status = 'active'`,
    [input.projectId, input.mutationId, input.ownerUserId],
  );
  const row = result.rows[0];
  return row ? toRevisionRecord(row) : null;
}

export async function readAgentRelease(
  db: Queryable,
  input: { projectId: string; releaseId: string; ownerUserId: string },
): Promise<AgentReleaseView | null> {
  const result = await db.query<AgentReleaseRow>(
    `SELECT ${RELEASE_COLUMNS.replaceAll(/\b(id|created_at)\b/g, 'r.$1')}
       FROM agent_releases r
       JOIN agent_projects p ON p.id = r.project_id
      WHERE r.id = $1 AND r.project_id = $2 AND p.owner_user_id = $3`,
    [input.releaseId, input.projectId, input.ownerUserId],
  );
  const row = result.rows[0];
  return row ? toReleaseView(row) : null;
}

export type CommitRevisionOutcome =
  | { kind: 'created' | 'replayed'; revision: AgentRevisionRecord }
  | { kind: 'not_found' }
  | { kind: 'head_conflict'; currentHeadRevisionId: string | null }
  | { kind: 'idempotency_conflict' };

export async function commitAgentRevision(
  pool: TxPool,
  input: {
    projectId: string;
    revisionId: string;
    ownerUserId: string;
    expectedHeadRevisionId: string | null;
    mutationId: string;
    mutationSha256: string;
    changeSummary: string;
    projectName: string;
    projectSummary: string;
    compiled: CompiledAgentRevision;
  },
): Promise<CommitRevisionOutcome> {
  return withTransaction(pool, async (tx) => {
    const projectResult = await tx.query<AgentProjectRow>(
      `SELECT ${PROJECT_COLUMNS}
         FROM agent_projects
        WHERE id = $1 AND owner_user_id = $2 AND status = 'active'
        FOR UPDATE`,
      [input.projectId, input.ownerUserId],
    );
    const project = projectResult.rows[0];
    if (!project) return { kind: 'not_found' };

    const replay = await tx.query<AgentRevisionRow>(
      `SELECT ${REVISION_COLUMNS}
         FROM agent_revisions
        WHERE project_id = $1 AND mutation_id = $2`,
      [input.projectId, input.mutationId],
    );
    const replayRow = replay.rows[0];
    if (replayRow) {
      return replayRow.mutation_sha256 === input.mutationSha256
        ? { kind: 'replayed', revision: toRevisionRecord(replayRow) }
        : { kind: 'idempotency_conflict' };
    }

    if (project.head_revision_id !== input.expectedHeadRevisionId) {
      return { kind: 'head_conflict', currentHeadRevisionId: project.head_revision_id };
    }
    const next = await tx.query<{ revision_number: string | number }>(
      `SELECT COALESCE(max(revision_number), 0) + 1 AS revision_number
         FROM agent_revisions
        WHERE project_id = $1`,
      [input.projectId],
    );
    const revisionNumber = Number(next.rows[0]?.revision_number ?? 1);
    const inserted = await tx.query<AgentRevisionRow>(
      `INSERT INTO agent_revisions
         (id, project_id, revision_number, parent_revision_id, entry_capability_id,
          definition_storage_key, definition_sha256, runtime_bundle_storage_key,
          runtime_bundle_sha256, ui_artifact_id, ui_storage_key, ui_sha256,
          compiler_version, change_summary, mutation_id, mutation_sha256, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING ${REVISION_COLUMNS}`,
      [
        input.revisionId,
        input.projectId,
        revisionNumber,
        input.expectedHeadRevisionId,
        input.compiled.entryCapabilityId,
        input.compiled.definitionStorageKey,
        input.compiled.definitionSha256,
        input.compiled.runtimeBundleStorageKey,
        input.compiled.runtimeBundleSha256,
        input.compiled.uiArtifactId,
        input.compiled.uiStorageKey,
        input.compiled.uiSha256,
        input.compiled.runtimeBundle.compilerVersion,
        input.changeSummary,
        input.mutationId,
        input.mutationSha256,
        input.ownerUserId,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('commitAgentRevision: insert returned no row');
    const updated = await tx.query(
      `UPDATE agent_projects
          SET head_revision_id = $3, name = $4, summary = $5, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2
          AND head_revision_id IS NOT DISTINCT FROM $6`,
      [
        input.projectId,
        input.ownerUserId,
        input.revisionId,
        input.projectName,
        input.projectSummary,
        input.expectedHeadRevisionId,
      ],
    );
    if (updated.rowCount !== 1) throw new Error('commitAgentRevision: head CAS lost under lock');
    return { kind: 'created', revision: toRevisionRecord(row) };
  });
}

export type RecordTestReviewOutcome =
  | { kind: 'created' | 'replayed'; review: AgentTestReviewView }
  | { kind: 'not_found' }
  | { kind: 'test_not_passed' }
  | { kind: 'review_exists' }
  | { kind: 'idempotency_conflict' };

export async function recordAgentTestReview(
  pool: TxPool,
  input: {
    projectId: string;
    testId: string;
    ownerUserId: string;
    qualityStatus: AgentTestReviewStatus;
    cases: AgentTestReviewCase[];
    summary: string;
    idempotencyKey: string;
    idempotencySha256: string;
  },
): Promise<RecordTestReviewOutcome> {
  return withTransaction(pool, async (tx) => {
    const projectResult = await tx.query<AgentProjectRow>(
      `SELECT ${PROJECT_COLUMNS}
         FROM agent_projects
        WHERE id = $1 AND owner_user_id = $2 AND status = 'active'
        FOR UPDATE`,
      [input.projectId, input.ownerUserId],
    );
    if (!projectResult.rows[0]) return { kind: 'not_found' };

    const existingKey = await tx.query<AgentTestReviewRow>(
      `SELECT ${TEST_REVIEW_COLUMNS}
         FROM agent_test_reviews
        WHERE project_id = $1 AND idempotency_key = $2`,
      [input.projectId, input.idempotencyKey],
    );
    const replay = existingKey.rows[0];
    if (replay) {
      return replay.idempotency_sha256 === input.idempotencySha256
        ? { kind: 'replayed', review: toTestReviewView(replay) }
        : { kind: 'idempotency_conflict' };
    }

    const existingTestReview = await tx.query<AgentTestReviewRow>(
      `SELECT ${TEST_REVIEW_COLUMNS}
         FROM agent_test_reviews
        WHERE project_id = $1 AND test_id = $2`,
      [input.projectId, input.testId],
    );
    if (existingTestReview.rows[0]) return { kind: 'review_exists' };

    const testResult = await tx.query<{
      agent_revision_id: string;
      runtime_bundle_sha256: string;
      ui_sha256: string;
      status: string;
    }>(
      `SELECT t.agent_revision_id, t.runtime_bundle_sha256, t.ui_sha256, t.status
         FROM agent_tests t
         JOIN agent_projects p ON p.id = t.project_id
        WHERE t.id = $1 AND t.project_id = $2
          AND p.owner_user_id = $3 AND p.status = 'active'`,
      [input.testId, input.projectId, input.ownerUserId],
    );
    const test = testResult.rows[0];
    if (!test) return { kind: 'not_found' };
    if (test.status !== 'passed') return { kind: 'test_not_passed' };
    const reviewSha256 = createHash('sha256')
      .update(
        canonicalJson({
          projectId: input.projectId,
          testId: input.testId,
          agentRevisionId: test.agent_revision_id,
          runtimeBundleSha256: test.runtime_bundle_sha256,
          uiSha256: test.ui_sha256,
          reviewerUserId: input.ownerUserId,
          qualityStatus: input.qualityStatus,
          cases: input.cases,
          summary: input.summary,
        }),
      )
      .digest('hex');

    const inserted = await tx.query<AgentTestReviewRow>(
      `INSERT INTO agent_test_reviews
         (project_id, test_id, agent_revision_id, runtime_bundle_sha256, ui_sha256,
          quality_status, cases, summary, review_sha256, idempotency_key,
          idempotency_sha256, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
       RETURNING ${TEST_REVIEW_COLUMNS}`,
      [
        input.projectId,
        input.testId,
        test.agent_revision_id,
        test.runtime_bundle_sha256,
        test.ui_sha256,
        input.qualityStatus,
        JSON.stringify(input.cases),
        input.summary,
        reviewSha256,
        input.idempotencyKey,
        input.idempotencySha256,
        input.ownerUserId,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('recordAgentTestReview: insert returned no row');
    return { kind: 'created', review: toTestReviewView(row) };
  });
}

export type CreateReleaseOutcome =
  | { kind: 'created' | 'replayed'; release: AgentReleaseView }
  | { kind: 'not_found' }
  | { kind: 'head_conflict'; currentHeadRevisionId: string | null }
  | { kind: 'test_not_passed' }
  | { kind: 'review_not_publishable' }
  | { kind: 'idempotency_conflict' };

export async function createAgentRelease(
  pool: TxPool,
  input: {
    projectId: string;
    ownerUserId: string;
    expectedHeadRevisionId: string;
    agentRevisionId: string;
    qualifyingTestId: string;
    idempotencyKey: string;
    idempotencySha256: string;
    notes: string;
  },
): Promise<CreateReleaseOutcome> {
  return withTransaction(pool, async (tx) => {
    const projectResult = await tx.query<AgentProjectRow>(
      `SELECT ${PROJECT_COLUMNS}
         FROM agent_projects
        WHERE id = $1 AND owner_user_id = $2 AND status = 'active'
        FOR UPDATE`,
      [input.projectId, input.ownerUserId],
    );
    const project = projectResult.rows[0];
    if (!project) return { kind: 'not_found' };
    const existing = await tx.query<AgentReleaseRow>(
      `SELECT ${RELEASE_COLUMNS}
         FROM agent_releases
        WHERE project_id = $1 AND idempotency_key = $2`,
      [input.projectId, input.idempotencyKey],
    );
    const replay = existing.rows[0];
    if (replay) {
      return replay.idempotency_sha256 === input.idempotencySha256
        ? { kind: 'replayed', release: toReleaseView(replay) }
        : { kind: 'idempotency_conflict' };
    }
    if (
      project.head_revision_id !== input.expectedHeadRevisionId ||
      input.agentRevisionId !== input.expectedHeadRevisionId
    ) {
      return { kind: 'head_conflict', currentHeadRevisionId: project.head_revision_id };
    }

    const proof = await tx.query<{
      runtime_bundle_sha256: string;
      ui_sha256: string;
      status: string;
      qualifying_review_id: string | null;
      review_sha256: string | null;
      quality_status: AgentTestReviewStatus | null;
    }>(
      `SELECT r.runtime_bundle_sha256, r.ui_sha256, t.status,
              q.id AS qualifying_review_id, q.review_sha256, q.quality_status
         FROM agent_revisions r
         JOIN agent_tests t
           ON t.agent_revision_id = r.id
          AND t.project_id = r.project_id
          AND t.runtime_bundle_sha256 = r.runtime_bundle_sha256
          AND t.ui_sha256 = r.ui_sha256
         LEFT JOIN agent_test_reviews q
           ON q.project_id = t.project_id
          AND q.test_id = t.id
          AND q.agent_revision_id = t.agent_revision_id
          AND q.runtime_bundle_sha256 = t.runtime_bundle_sha256
          AND q.ui_sha256 = t.ui_sha256
        WHERE r.id = $1 AND r.project_id = $2 AND t.id = $3`,
      [input.agentRevisionId, input.projectId, input.qualifyingTestId],
    );
    const tested = proof.rows[0];
    if (!tested || tested.status !== 'passed') return { kind: 'test_not_passed' };
    if (
      !tested.qualifying_review_id ||
      !tested.review_sha256 ||
      (tested.quality_status !== 'passed' && tested.quality_status !== 'accepted_exception')
    ) {
      return { kind: 'review_not_publishable' };
    }
    const versionResult = await tx.query<{ version_number: string | number }>(
      `SELECT COALESCE(max(version_number), 0) + 1 AS version_number
         FROM agent_releases
        WHERE project_id = $1`,
      [input.projectId],
    );
    const versionNumber = Number(versionResult.rows[0]?.version_number ?? 1);
    const releaseId = randomUUID();
    const releaseSha256 = createHash('sha256')
      .update(
        canonicalJson({
          projectId: input.projectId,
          versionNumber,
          agentRevisionId: input.agentRevisionId,
          qualifyingTestId: input.qualifyingTestId,
          qualifyingReviewId: tested.qualifying_review_id,
          reviewSha256: tested.review_sha256,
          runtimeBundleSha256: tested.runtime_bundle_sha256,
          uiSha256: tested.ui_sha256,
        }),
      )
      .digest('hex');
    const inserted = await tx.query<AgentReleaseRow>(
      `INSERT INTO agent_releases
         (id, project_id, version_number, agent_revision_id, qualifying_test_id,
          qualifying_review_id, review_sha256, runtime_bundle_sha256, ui_sha256,
          release_sha256, notes, idempotency_key, idempotency_sha256, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${RELEASE_COLUMNS}`,
      [
        releaseId,
        input.projectId,
        versionNumber,
        input.agentRevisionId,
        input.qualifyingTestId,
        tested.qualifying_review_id,
        tested.review_sha256,
        tested.runtime_bundle_sha256,
        tested.ui_sha256,
        releaseSha256,
        input.notes,
        input.idempotencyKey,
        input.idempotencySha256,
        input.ownerUserId,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('createAgentRelease: insert returned no row');
    await tx.query(
      `UPDATE agent_projects
          SET current_release_id = $3, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [input.projectId, input.ownerUserId, releaseId],
    );
    return { kind: 'created', release: toReleaseView(row) };
  });
}
