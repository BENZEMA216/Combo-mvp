import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import {
  AgentOutputSchema,
  AgentTestReviewCasesSchema,
  TerminalTurnErrorCodeSchema,
  type AgentOutput,
  type AgentTestDetail,
  type AgentTestListItem,
  type AgentTestQualityStatus,
  type AgentTestReviewStatus,
  type AgentTestReviewView,
  type AgentTestView,
  type TerminalTurnErrorCode,
} from '@cb/shared';
import { withTransaction, type Queryable, type RuntimeDb } from '../../platform/infra/db.js';
import { toIso } from '../session/repo.js';
import type { LoadedAgentRevision } from '../agent/revision-loader.js';

interface AgentTestDbRow {
  id: string;
  project_id: string;
  agent_revision_id: string;
  runtime_bundle_sha256: string;
  ui_sha256: string;
  output_contract: unknown;
  request_key: string;
  request_sha256: string;
  lease_token: string | null;
  lease_expires_at: string | Date | null;
  session_id: string | null;
  turn_id: string | null;
  status: 'starting' | 'running' | 'passed' | 'failed';
  error_code: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
  turn_status?: 'running' | 'completed' | 'failed' | 'interrupted';
  turn_error_code?: unknown;
  quality_status?: AgentTestReviewStatus | null;
  review_id?: string | null;
  review_cases?: unknown;
  review_summary?: string | null;
  review_sha256?: string | null;
  review_user_id?: string | null;
  review_created_at?: string | Date | null;
  current_head_revision_id?: string | null;
  project_status?: 'active' | 'archived';
}

const TEST_COLUMNS = `id, project_id, agent_revision_id, runtime_bundle_sha256,
  ui_sha256, output_contract, request_key, request_sha256,
  lease_token, lease_expires_at, session_id, turn_id, status, error_code, created_at, completed_at`;
const QUALIFIED_TEST_COLUMNS = `t.id, t.project_id, t.agent_revision_id, t.runtime_bundle_sha256,
  t.ui_sha256, t.output_contract, t.request_key, t.request_sha256,
  t.lease_token, t.lease_expires_at, t.session_id, t.turn_id, t.status, t.error_code,
  t.created_at, t.completed_at, q.quality_status,
  q.id AS review_id, q.cases AS review_cases, q.summary AS review_summary,
  q.review_sha256, q.created_by_user_id AS review_user_id,
  q.created_at AS review_created_at,
  p.head_revision_id AS current_head_revision_id, p.status AS project_status`;
const QUALIFIED_TEST_LIST_COLUMNS = `t.id, t.project_id, t.agent_revision_id, t.request_key,
  t.session_id, t.turn_id, t.status, t.error_code, t.created_at, t.completed_at,
  q.quality_status, p.head_revision_id AS current_head_revision_id, p.status AS project_status`;

interface AgentTestListDbRow {
  id: string;
  project_id: string;
  agent_revision_id: string;
  request_key: string;
  session_id: string | null;
  turn_id: string | null;
  status: 'starting' | 'running' | 'passed' | 'failed';
  error_code: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
  quality_status: AgentTestReviewStatus | null;
  current_head_revision_id: string | null;
  project_status: 'active' | 'archived';
}

export const AGENT_TEST_START_LEASE_SECONDS = 60;

function safeTerminalCode(value: unknown): TerminalTurnErrorCode {
  const parsed = TerminalTurnErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'TURN_FAILED';
}

function toView(row: AgentTestDbRow): AgentTestView {
  if (row.status === 'starting' || !row.session_id || !row.turn_id) {
    throw new Error('Agent Test reservation is not active');
  }
  const qualityStatus: AgentTestQualityStatus = row.quality_status ?? 'unreviewed';
  return {
    id: row.id,
    projectId: row.project_id,
    agentRevisionId: row.agent_revision_id,
    runtimeBundleSha256: row.runtime_bundle_sha256,
    uiSha256: row.ui_sha256,
    sessionId: row.session_id,
    turnId: row.turn_id,
    status: row.status,
    qualityStatus,
    canPublish:
      row.status === 'passed' &&
      (qualityStatus === 'passed' || qualityStatus === 'accepted_exception') &&
      row.project_status === 'active' &&
      row.current_head_revision_id === row.agent_revision_id,
    errorCode: row.error_code ? safeTerminalCode(row.error_code) : null,
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
  };
}

function toListItem(row: AgentTestListDbRow): AgentTestListItem {
  const qualityStatus: AgentTestQualityStatus = row.quality_status ?? 'unreviewed';
  return {
    id: row.id,
    projectId: row.project_id,
    agentRevisionId: row.agent_revision_id,
    requestKey: row.request_key,
    sessionId: row.session_id,
    turnId: row.turn_id,
    status: row.status,
    qualityStatus,
    canPublish:
      row.status === 'passed' &&
      (qualityStatus === 'passed' || qualityStatus === 'accepted_exception') &&
      row.project_status === 'active' &&
      row.current_head_revision_id === row.agent_revision_id,
    errorCode: row.error_code ? safeTerminalCode(row.error_code) : null,
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
  };
}

function toReview(row: AgentTestDbRow): AgentTestReviewView | null {
  if (!row.review_id) return null;
  if (!row.quality_status || !row.review_sha256 || !row.review_user_id || !row.review_created_at) {
    throw new Error('Agent Test Review identity is incomplete');
  }
  const reviewedAt = toIso(row.review_created_at);
  return {
    id: row.review_id,
    projectId: row.project_id,
    testId: row.id,
    agentRevisionId: row.agent_revision_id,
    qualityStatus: row.quality_status,
    cases: AgentTestReviewCasesSchema.parse(row.review_cases),
    summary: row.review_summary ?? '',
    reviewSha256: row.review_sha256,
    reviewerUserId: row.review_user_id,
    reviewedAt,
    acceptedAt: row.quality_status === 'accepted_exception' ? reviewedAt : null,
  };
}

function revisionOutputContract(revision: LoadedAgentRevision): AgentOutput {
  const agentMeta = revision.bundle.definition.meta.agent;
  if (typeof agentMeta !== 'object' || agentMeta === null) {
    throw new Error('Agent Runtime Bundle is missing output metadata');
  }
  return AgentOutputSchema.parse((agentMeta as { output?: unknown }).output);
}

function outputMatchesContract(contract: unknown, outputText: string | null): boolean {
  if (!outputText) return false;
  const parsedContract = AgentOutputSchema.safeParse(contract);
  if (!parsedContract.success) return false;
  if (parsedContract.data.type === 'text') return true;
  try {
    const value: unknown = JSON.parse(outputText);
    const validate = new Ajv({ strict: false }).compile(parsedContract.data.schema);
    if ((validate as { $async?: boolean }).$async) return false;
    return validate(value) === true;
  } catch {
    return false;
  }
}

export type ReserveAgentTestOutcome =
  | { kind: 'acquired'; testId: string; leaseToken: string }
  | { kind: 'replayed'; test: AgentTestView }
  | { kind: 'starting' }
  | { kind: 'idempotency_conflict' };

export async function readAgentTestRequest(
  db: Queryable,
  input: { projectId: string; requestKey: string; requestSha256: string; ownerUserId: string },
): Promise<
  | { kind: 'replayed'; test: AgentTestView }
  | { kind: 'starting' }
  | { kind: 'idempotency_conflict' }
  | null
> {
  const result = await db.query<AgentTestDbRow>(
    `SELECT ${QUALIFIED_TEST_COLUMNS}
       FROM agent_tests t
       JOIN agent_projects p ON p.id = t.project_id
       LEFT JOIN agent_test_reviews q
         ON q.project_id = t.project_id AND q.test_id = t.id
      WHERE t.project_id = $1 AND t.request_key = $2 AND p.owner_user_id = $3`,
    [input.projectId, input.requestKey, input.ownerUserId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_sha256 !== input.requestSha256) return { kind: 'idempotency_conflict' };
  return row.status === 'starting' ? { kind: 'starting' } : { kind: 'replayed', test: toView(row) };
}

/** owner-scoped 最近 Test 恢复索引；不触发既有单 Test GET 的终态收口副作用。 */
export async function listAgentProjectTests(
  db: Queryable,
  input: { projectId: string; ownerUserId: string; limit: number },
): Promise<AgentTestListItem[] | null> {
  const ownedProject = await db.query<{ id: string }>(
    `SELECT id
       FROM agent_projects
      WHERE id = $1 AND owner_user_id = $2 AND status = 'active'`,
    [input.projectId, input.ownerUserId],
  );
  if (!ownedProject.rows[0]) return null;

  const result = await db.query<AgentTestListDbRow>(
    `SELECT ${QUALIFIED_TEST_LIST_COLUMNS}
       FROM agent_tests t
       JOIN agent_projects p ON p.id = t.project_id
       LEFT JOIN agent_test_reviews q
         ON q.project_id = t.project_id AND q.test_id = t.id
      WHERE t.project_id = $1 AND p.owner_user_id = $2 AND p.status = 'active'
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $3`,
    [input.projectId, input.ownerUserId, input.limit],
  );
  return result.rows.map(toListItem);
}

/** 在任何 Session/Turn 副作用前原子占用 request key；跨副本重试不会重复启动模型。 */
async function reserveAgentTestAttempt(
  db: Queryable,
  input: {
    revision: LoadedAgentRevision;
    requestKey: string;
    requestSha256: string;
  },
  missingRowRetries: number,
): Promise<ReserveAgentTestOutcome> {
  const id = randomUUID();
  const leaseToken = randomUUID();
  const result = await db.query<AgentTestDbRow>(
    `INSERT INTO agent_tests
       (id, project_id, agent_revision_id, runtime_bundle_sha256, ui_sha256,
        output_contract, request_key, request_sha256, lease_token, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9,
             now() + ($10 * interval '1 second'))
     ON CONFLICT (project_id, request_key) DO NOTHING
     RETURNING ${TEST_COLUMNS}`,
    [
      id,
      input.revision.projectId,
      input.revision.revisionId,
      input.revision.runtimeBundleSha256,
      input.revision.uiSha256,
      JSON.stringify(revisionOutputContract(input.revision)),
      input.requestKey,
      input.requestSha256,
      leaseToken,
      AGENT_TEST_START_LEASE_SECONDS,
    ],
  );
  const row = result.rows[0];
  if (row) return { kind: 'acquired', testId: row.id, leaseToken };

  // 崩溃在 Turn 事务前只会遗留无模型副作用的 starting claim；过期后原子接管。
  const reclaimed = await db.query<AgentTestDbRow>(
    `UPDATE agent_tests
        SET lease_token = $4, lease_expires_at = now() + ($5 * interval '1 second')
      WHERE project_id = $1 AND request_key = $2 AND request_sha256 = $3
        AND status = 'starting' AND lease_expires_at <= now()
      RETURNING ${TEST_COLUMNS}`,
    [
      input.revision.projectId,
      input.requestKey,
      input.requestSha256,
      leaseToken,
      AGENT_TEST_START_LEASE_SECONDS,
    ],
  );
  if (reclaimed.rows[0]) {
    return { kind: 'acquired', testId: reclaimed.rows[0].id, leaseToken };
  }

  const replay = await db.query<AgentTestDbRow>(
    `SELECT ${TEST_COLUMNS}
       FROM agent_tests
      WHERE project_id = $1 AND request_key = $2`,
    [input.revision.projectId, input.requestKey],
  );
  const existing = replay.rows[0];
  if (!existing) {
    if (missingRowRetries > 0) {
      return reserveAgentTestAttempt(db, input, missingRowRetries - 1);
    }
    throw new Error('reserveAgentTest: conflict row is repeatedly missing');
  }
  if (existing.request_sha256 !== input.requestSha256) return { kind: 'idempotency_conflict' };
  return existing.status === 'starting'
    ? { kind: 'starting' }
    : { kind: 'replayed', test: toView(existing) };
}

export async function reserveAgentTest(
  db: Queryable,
  input: {
    revision: LoadedAgentRevision;
    requestKey: string;
    requestSha256: string;
  },
): Promise<ReserveAgentTestOutcome> {
  return reserveAgentTestAttempt(db, input, 1);
}

export async function activateAgentTest(
  db: Queryable,
  input: { testId: string; leaseToken: string; sessionId: string; turnId: string },
): Promise<AgentTestView | null> {
  const result = await db.query<AgentTestDbRow>(
    `UPDATE agent_tests
        SET session_id = $3, turn_id = $4, status = 'running',
            lease_token = NULL, lease_expires_at = NULL
      WHERE id = $1 AND lease_token = $2 AND status = 'starting'
        AND lease_expires_at > now()
      RETURNING ${TEST_COLUMNS}`,
    [input.testId, input.leaseToken, input.sessionId, input.turnId],
  );
  const row = result.rows[0];
  return row ? toView(row) : null;
}

export async function deleteAgentTestReservation(
  db: Queryable,
  input: { testId: string; leaseToken: string },
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `DELETE FROM agent_tests
      WHERE id = $1 AND lease_token = $2 AND status = 'starting'
      RETURNING id`,
    [input.testId, input.leaseToken],
  );
  return Boolean(result.rows[0]);
}

/**
 * token-CAS 删除 claim 与关闭其固定 Session 必须同事务；失败或丢 lease 时两者都不动。
 * 锁序必须与 startTurn 保持一致（Session → Test），避免清理与 lease 接管互相死锁。
 */
export async function discardAgentTestReservation(
  db: RuntimeDb,
  input: { testId: string; leaseToken: string; ownerUserId: string },
): Promise<boolean> {
  return withTransaction(db, async (transaction) => {
    const sessionResult = await transaction.query<{
      id: string;
      owner_user_id: string;
      mode: string;
      status: 'active' | 'closed';
    }>(
      `SELECT id, owner_user_id, mode, status
         FROM sessions
        WHERE id = $1
        FOR UPDATE`,
      [input.testId],
    );
    const session = sessionResult.rows[0];
    // Session INSERT 的提交结果可能仍未知；此时保留 claim，让 lease 接管者复用同一 Test id。
    // 若先删 Test，而该 INSERT 随后提交，就会留下无法再被同一请求回收的孤儿 Session。
    if (!session) return false;

    const discarded = await deleteAgentTestReservation(transaction, input);
    if (!discarded) return false;

    if (session.owner_user_id !== input.ownerUserId || session.mode !== 'consume') {
      throw new Error('discardAgentTestReservation: fixed Session identity mismatch');
    }
    if (session.status === 'closed') return true;

    const closed = await transaction.query<{ id: string }>(
      `UPDATE sessions s
          SET status = 'closed', updated_at = now()
        WHERE s.id = $1 AND s.owner_user_id = $2 AND s.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.status = 'running'
          )
        RETURNING s.id`,
      [input.testId, input.ownerUserId],
    );
    if (!closed.rows[0]) {
      throw new Error('discardAgentTestReservation: fixed Session could not be closed');
    }
    return true;
  });
}

async function readTestWithTurn(
  db: Queryable,
  testId: string,
  ownerUserId: string,
): Promise<AgentTestDbRow | null> {
  const result = await db.query<AgentTestDbRow>(
    `SELECT ${QUALIFIED_TEST_COLUMNS},
            tr.status AS turn_status, tr.last_error ->> 'code' AS turn_error_code
       FROM agent_tests t
       JOIN agent_projects p ON p.id = t.project_id
       LEFT JOIN agent_test_reviews q
         ON q.project_id = t.project_id AND q.test_id = t.id
       JOIN turns tr ON tr.id = t.turn_id AND tr.session_id = t.session_id
      WHERE t.id = $1 AND p.owner_user_id = $2`,
    [testId, ownerUserId],
  );
  return result.rows[0] ?? null;
}

async function readTurnOutput(db: Queryable, turnId: string): Promise<string | null> {
  const result = await db.query<{ content: unknown }>(
    `SELECT content
       FROM messages
      WHERE turn_id = $1 AND role = 'assistant' AND status = 'completed'
      ORDER BY idx DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [turnId],
  );
  const content = result.rows[0]?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text || null;
}

/** GET 同时把已终态的 Turn 单向收口为 Test 终态；CAS 让并发轮询只提交一次。 */
export async function readAndFinalizeAgentTest(
  db: Queryable,
  testId: string,
  ownerUserId: string,
): Promise<AgentTestDetail | null> {
  let row = await readTestWithTurn(db, testId, ownerUserId);
  if (!row) return null;
  if (!row.turn_id || row.status === 'starting') return null;
  let outputText = row.status === 'running' ? null : await readTurnOutput(db, row.turn_id);
  if (row.status === 'running' && row.turn_status && row.turn_status !== 'running') {
    outputText = await readTurnOutput(db, row.turn_id);
    const turnCompleted = row.turn_status === 'completed';
    const passed = turnCompleted && outputMatchesContract(row.output_contract, outputText);
    const errorCode = passed
      ? null
      : turnCompleted
        ? 'AGENT_OUTPUT_INVALID'
        : safeTerminalCode(row.turn_error_code);
    await db.query(
      `UPDATE agent_tests
          SET status = $2, error_code = $3, completed_at = now()
        WHERE id = $1 AND status = 'running'`,
      [row.id, passed ? 'passed' : 'failed', errorCode],
    );
    row = (await readTestWithTurn(db, testId, ownerUserId)) ?? row;
  }
  return { test: toView(row), outputText, review: toReview(row) };
}
