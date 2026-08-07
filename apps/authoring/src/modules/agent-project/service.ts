import { createHash } from 'node:crypto';
import {
  AgentCapabilitySnapshotSchema,
  AgentDefinitionSchema,
  AgentRuntimeBundleSchema,
  canonicalJson,
  deriveAgentTestReviewStatus,
  type AgentProjectDetail,
  type AgentRevisionDetail,
  type CommitAgentRevisionBody,
  type CreateAgentProjectBody,
  type CreateAgentReleaseBody,
  type ObjectStorePort,
  type RecordAgentTestReviewBody,
} from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import type { TxPool } from '../../platform/infra/db-tx.js';
import {
  AGENT_ARTIFACT_BUCKET,
  AgentCompileError,
  compileAgentRevision,
  type AgentRevisionDocument,
} from './compiler.js';
import {
  commitAgentRevision,
  createAgentProject as insertAgentProject,
  createAgentRelease as insertAgentRelease,
  isOwnedSourceTask,
  recordAgentTestReview as insertAgentTestReview,
  readAgentProject,
  readAgentRelease,
  readAgentRevisionRecord,
  readRevisionByMutation,
  toAgentRevisionView,
  type CommitRevisionOutcome,
  type CreateProjectOutcome,
  type CreateReleaseOutcome,
  type RecordTestReviewOutcome,
} from './repo.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** projectId + mutationId 决定稳定 UUID，网络重试不会制造新的对象键。 */
export function deterministicRevisionId(projectId: string, mutationId: string): string {
  const bytes = createHash('sha256').update(`${projectId}\0${mutationId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type CreateAgentProjectServiceOutcome =
  | CreateProjectOutcome
  | { kind: 'source_task_not_found' };

export async function createAgentProject(
  db: Queryable,
  ownerUserId: string,
  body: CreateAgentProjectBody,
): Promise<CreateAgentProjectServiceOutcome> {
  if (body.sourceTaskId && !(await isOwnedSourceTask(db, body.sourceTaskId, ownerUserId))) {
    return { kind: 'source_task_not_found' };
  }
  const idempotencySha256 = sha256(
    canonicalJson({
      name: body.name,
      summary: body.summary,
      sourceTaskId: body.sourceTaskId ?? null,
    }),
  );
  return insertAgentProject(db, {
    ownerUserId,
    name: body.name,
    summary: body.summary,
    ...(body.sourceTaskId ? { sourceTaskId: body.sourceTaskId } : {}),
    idempotencyKey: body.idempotencyKey,
    idempotencySha256,
  });
}

export type CommitAgentRevisionServiceOutcome =
  | CommitRevisionOutcome
  | { kind: 'compile_failed'; error: AgentCompileError };

export async function saveAgentRevision(
  pool: TxPool,
  db: Queryable,
  objectStore: ObjectStorePort,
  input: {
    projectId: string;
    ownerUserId: string;
    body: CommitAgentRevisionBody;
  },
): Promise<CommitAgentRevisionServiceOutcome> {
  const mutationSha256 = sha256(
    canonicalJson({
      expectedHeadRevisionId: input.body.expectedHeadRevisionId,
      changeSummary: input.body.changeSummary,
      definition: input.body.definition,
    }),
  );
  const replay = await readRevisionByMutation(db, {
    projectId: input.projectId,
    mutationId: input.body.mutationId,
    ownerUserId: input.ownerUserId,
  });
  if (replay) {
    return replay.mutationSha256 === mutationSha256
      ? { kind: 'replayed', revision: replay }
      : { kind: 'idempotency_conflict' };
  }
  const project = await readAgentProject(db, input.projectId, input.ownerUserId);
  if (!project) return { kind: 'not_found' };
  if (project.headRevisionId !== input.body.expectedHeadRevisionId) {
    return { kind: 'head_conflict', currentHeadRevisionId: project.headRevisionId };
  }

  const revisionId = deterministicRevisionId(input.projectId, input.body.mutationId);
  let compiled;
  try {
    compiled = await compileAgentRevision(db, objectStore, {
      projectId: input.projectId,
      revisionId,
      ownerUserId: input.ownerUserId,
      definition: input.body.definition,
    });
  } catch (error) {
    if (error instanceof AgentCompileError) return { kind: 'compile_failed', error };
    throw error;
  }
  return commitAgentRevision(pool, {
    projectId: input.projectId,
    revisionId,
    ownerUserId: input.ownerUserId,
    expectedHeadRevisionId: input.body.expectedHeadRevisionId,
    mutationId: input.body.mutationId,
    mutationSha256,
    changeSummary: input.body.changeSummary,
    projectName: input.body.definition.identity.name,
    projectSummary: input.body.definition.identity.summary,
    compiled,
  });
}

export class AgentRevisionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRevisionIntegrityError';
  }
}

export async function readAgentRevisionDetail(
  db: Queryable,
  objectStore: ObjectStorePort,
  input: { projectId: string; revisionId: string; ownerUserId: string },
): Promise<AgentRevisionDetail | null> {
  const record = await readAgentRevisionRecord(db, input);
  if (!record) return null;
  const [definitionText, runtimeBundleText] = await Promise.all([
    objectStore.getObjectText(AGENT_ARTIFACT_BUCKET, record.definitionStorageKey),
    objectStore.getObjectText(AGENT_ARTIFACT_BUCKET, record.runtimeBundleStorageKey),
  ]);
  if (sha256(definitionText) !== record.definitionSha256) {
    throw new AgentRevisionIntegrityError('definition digest mismatch');
  }
  if (sha256(runtimeBundleText) !== record.runtimeBundleSha256) {
    throw new AgentRevisionIntegrityError('runtime bundle digest mismatch');
  }
  let definitionRaw: unknown;
  let runtimeRaw: unknown;
  try {
    definitionRaw = JSON.parse(definitionText);
    runtimeRaw = JSON.parse(runtimeBundleText);
  } catch {
    throw new AgentRevisionIntegrityError('revision object is not JSON');
  }
  const document = definitionRaw as Partial<AgentRevisionDocument>;
  const definition = AgentDefinitionSchema.safeParse(document.definition);
  const snapshots = AgentCapabilitySnapshotSchema.array().safeParse(document.capabilitySnapshots);
  const runtimeBundle = AgentRuntimeBundleSchema.safeParse(runtimeRaw);
  if (!definition.success || !snapshots.success || !runtimeBundle.success) {
    throw new AgentRevisionIntegrityError('revision object failed schema validation');
  }
  if (
    runtimeBundle.data.projectId !== input.projectId ||
    runtimeBundle.data.revisionId !== input.revisionId ||
    runtimeBundle.data.entryCapabilityId !== record.entryCapabilityId ||
    runtimeBundle.data.ui.artifactId !== record.uiArtifactId ||
    runtimeBundle.data.ui.storageKey !== record.uiStorageKey ||
    runtimeBundle.data.ui.sha256 !== record.uiSha256
  ) {
    throw new AgentRevisionIntegrityError('runtime bundle identity mismatch');
  }
  return {
    revision: toAgentRevisionView(record),
    definition: definition.data,
    capabilitySnapshots: snapshots.data,
    runtimeBundle: runtimeBundle.data,
  };
}

export async function readAgentProjectDetail(
  db: Queryable,
  input: { projectId: string; ownerUserId: string },
): Promise<AgentProjectDetail | null> {
  const project = await readAgentProject(db, input.projectId, input.ownerUserId);
  if (!project) return null;
  const [head, release] = await Promise.all([
    project.headRevisionId
      ? readAgentRevisionRecord(db, {
          projectId: project.id,
          revisionId: project.headRevisionId,
          ownerUserId: input.ownerUserId,
        })
      : null,
    project.currentReleaseId
      ? readAgentRelease(db, {
          projectId: project.id,
          releaseId: project.currentReleaseId,
          ownerUserId: input.ownerUserId,
        })
      : null,
  ]);
  return {
    project,
    headRevision: head ? toAgentRevisionView(head) : null,
    currentRelease: release,
  };
}

export async function publishAgentRevision(
  pool: TxPool,
  input: {
    projectId: string;
    ownerUserId: string;
    body: CreateAgentReleaseBody;
  },
): Promise<CreateReleaseOutcome> {
  const idempotencySha256 = sha256(
    canonicalJson({
      expectedHeadRevisionId: input.body.expectedHeadRevisionId,
      agentRevisionId: input.body.agentRevisionId,
      qualifyingTestId: input.body.qualifyingTestId,
      notes: input.body.notes,
    }),
  );
  return insertAgentRelease(pool, {
    projectId: input.projectId,
    ownerUserId: input.ownerUserId,
    expectedHeadRevisionId: input.body.expectedHeadRevisionId,
    agentRevisionId: input.body.agentRevisionId,
    qualifyingTestId: input.body.qualifyingTestId,
    idempotencyKey: input.body.idempotencyKey,
    idempotencySha256,
    notes: input.body.notes,
  });
}

export async function recordAgentTestReview(
  pool: TxPool,
  input: {
    projectId: string;
    testId: string;
    ownerUserId: string;
    body: RecordAgentTestReviewBody;
  },
): Promise<RecordTestReviewOutcome> {
  const qualityStatus = deriveAgentTestReviewStatus(input.body.cases);
  const canonicalReview = {
    projectId: input.projectId,
    testId: input.testId,
    reviewerUserId: input.ownerUserId,
    qualityStatus,
    cases: input.body.cases,
    summary: input.body.summary,
  };
  return insertAgentTestReview(pool, {
    projectId: input.projectId,
    testId: input.testId,
    ownerUserId: input.ownerUserId,
    qualityStatus,
    cases: input.body.cases,
    summary: input.body.summary,
    idempotencyKey: input.body.idempotencyKey,
    idempotencySha256: sha256(canonicalJson(canonicalReview)),
  });
}
