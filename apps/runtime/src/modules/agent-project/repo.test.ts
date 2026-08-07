import { describe, expect, it } from 'vitest';
import type { Queryable, QueryResultLike, RuntimeDb, TxConn } from '../../platform/infra/db.js';
import type { LoadedAgentRevision } from '../agent/revision-loader.js';
import {
  activateAgentTest,
  deleteAgentTestReservation,
  discardAgentTestReservation,
  listAgentProjectTests,
  readAgentTestRequest,
  readAndFinalizeAgentTest,
  reserveAgentTest,
} from './repo.js';

type TestStatus = 'starting' | 'running' | 'passed' | 'failed';

interface TestRow {
  id: string;
  project_id: string;
  agent_revision_id: string;
  runtime_bundle_sha256: string;
  ui_sha256: string;
  output_contract: unknown;
  request_key: string;
  request_sha256: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  session_id: string | null;
  turn_id: string | null;
  status: TestStatus;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
  turn_status: 'running' | 'completed' | 'failed' | 'interrupted';
  turn_error_code: string | null;
  quality_status: 'passed' | 'failed' | 'accepted_exception' | null;
  review_id: string | null;
  review_cases: unknown;
  review_summary: string | null;
  review_sha256: string | null;
  review_user_id: string | null;
  review_created_at: string | null;
  current_head_revision_id: string | null;
  project_status: 'active' | 'archived';
}

const IDS = {
  test: '11111111-1111-4111-8111-111111111111',
  project: '22222222-2222-4222-8222-222222222222',
  revision: '33333333-3333-4333-8333-333333333333',
  session: '44444444-4444-4444-8444-444444444444',
  turn: '55555555-5555-4555-8555-555555555555',
} as const;

const STRUCTURED_OUTPUT_CONTRACT = {
  type: 'structured',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
} as const;

function testRow(overrides: Partial<TestRow> = {}): TestRow {
  return {
    id: IDS.test,
    project_id: IDS.project,
    agent_revision_id: IDS.revision,
    runtime_bundle_sha256: 'a'.repeat(64),
    ui_sha256: 'b'.repeat(64),
    output_contract: STRUCTURED_OUTPUT_CONTRACT,
    request_key: 'agent-test-request-1',
    request_sha256: 'c'.repeat(64),
    lease_token: null,
    lease_expires_at: null,
    session_id: IDS.session,
    turn_id: IDS.turn,
    status: 'running',
    error_code: null,
    created_at: '2026-08-05T01:00:00.000Z',
    completed_at: null,
    turn_status: 'completed',
    turn_error_code: null,
    quality_status: null,
    review_id: null,
    review_cases: null,
    review_summary: null,
    review_sha256: null,
    review_user_id: null,
    review_created_at: null,
    current_head_revision_id: IDS.revision,
    project_status: 'active',
    ...overrides,
  };
}

function result<R>(rows: R[]): QueryResultLike<R> {
  return { rows, rowCount: rows.length };
}

class FinalizeTestDb implements Queryable {
  readonly queries: string[] = [];

  constructor(
    private row: TestRow,
    private readonly outputContent: unknown,
  ) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push(sql);
    if (sql.includes('JOIN turns tr')) {
      return result([this.row as R]);
    }
    if (sql.includes('FROM messages')) {
      return result([{ content: this.outputContent } as R]);
    }
    if (sql.includes('UPDATE agent_tests')) {
      if (this.row.status === 'running') {
        this.row = {
          ...this.row,
          status: params[1] as TestStatus,
          error_code: params[2] as string | null,
          completed_at: '2026-08-05T01:00:01.000Z',
        };
      }
      return result([]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

class RequestTestDb implements Queryable {
  constructor(private readonly row: TestRow | null) {}

  async query<R = Record<string, unknown>>(sql: string): Promise<QueryResultLike<R>> {
    if (!sql.includes('FROM agent_tests t') || !sql.includes('JOIN agent_projects p')) {
      throw new Error(`Unexpected query: ${sql}`);
    }
    return result(this.row ? [this.row as R] : []);
  }
}

class ListProjectTestsDb implements Queryable {
  readonly queries: { sql: string; params: unknown[] }[] = [];

  constructor(
    private readonly ownerUserId: string,
    private readonly rows: TestRow[],
  ) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: normalized, params });
    if (normalized.startsWith('SELECT id FROM agent_projects')) {
      const owned = params[0] === IDS.project && params[1] === this.ownerUserId;
      return result(owned ? ([{ id: IDS.project }] as R[]) : []);
    }
    if (normalized.includes('FROM agent_tests t JOIN agent_projects p')) {
      if (params[0] !== IDS.project || params[1] !== this.ownerUserId) return result([]);
      const limit = params[2] as number;
      const rows = [...this.rows]
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(0, limit);
      return result(rows as R[]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

class ReservationTestDb implements Queryable {
  private row: TestRow | null = null;
  private vanishBeforeReplay = false;

  expireReservation(): void {
    if (this.row?.status === 'starting') this.row.lease_expires_at = '2000-01-01T00:00:00.000Z';
  }

  vanishOnNextReplay(): void {
    this.vanishBeforeReplay = true;
  }

  hasReservation(): boolean {
    return this.row !== null;
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    if (sql.includes('INSERT INTO agent_tests')) {
      if (this.row) return result([]);
      this.row = testRow({
        id: params[0] as string,
        request_key: params[6] as string,
        request_sha256: params[7] as string,
        lease_token: params[8] as string,
        lease_expires_at: '2099-01-01T00:00:00.000Z',
        session_id: null,
        turn_id: null,
        status: 'starting',
        turn_status: 'running',
      });
      return result([this.row as R]);
    }
    if (sql.includes('UPDATE agent_tests') && sql.includes('SET lease_token')) {
      if (!this.row || this.row.status !== 'starting') return result([]);
      if ((this.row.lease_expires_at ?? '') > '2026-08-05T00:00:00.000Z') return result([]);
      this.row = {
        ...this.row,
        lease_token: params[3] as string,
        lease_expires_at: '2099-01-01T00:00:00.000Z',
      };
      return result([this.row as R]);
    }
    if (sql.includes('FROM agent_tests') && sql.includes('request_key = $2')) {
      if (this.vanishBeforeReplay) {
        this.vanishBeforeReplay = false;
        this.row = null;
      }
      return result(this.row ? [this.row as R] : []);
    }
    if (sql.includes('UPDATE agent_tests') && sql.includes("status = 'running'")) {
      if (!this.row || this.row.status !== 'starting') return result([]);
      this.row = {
        ...this.row,
        lease_token: null,
        lease_expires_at: null,
        session_id: params[2] as string,
        turn_id: params[3] as string,
        status: 'running',
      };
      return result([this.row as R]);
    }
    if (sql.includes('DELETE FROM agent_tests')) {
      if (!this.row || this.row.status !== 'starting' || this.row.lease_token !== params[1]) {
        return result([]);
      }
      const id = this.row.id;
      this.row = null;
      return result([{ id } as R]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

class DiscardReservationDb implements RuntimeDb {
  row: TestRow | null = testRow({
    lease_token: '88888888-8888-4888-8888-888888888888',
    lease_expires_at: '2099-01-01T00:00:00.000Z',
    session_id: null,
    turn_id: null,
    status: 'starting',
  });
  sessionStatus: 'active' | 'closed' = 'active';
  sessionExists = true;
  failClose = false;
  readonly txLog: string[] = [];
  readonly lockOrder: string[] = [];
  private snapshot: { row: TestRow | null; sessionStatus: 'active' | 'closed' } | null = null;

  async connect(): Promise<TxConn> {
    return { query: (sql, params) => this.query(sql, params), release: () => undefined };
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized === 'BEGIN') {
      this.snapshot = {
        row: this.row ? { ...this.row } : null,
        sessionStatus: this.sessionStatus,
      };
      this.txLog.push('BEGIN');
      return result([]);
    }
    if (normalized === 'COMMIT') {
      this.snapshot = null;
      this.txLog.push('COMMIT');
      return result([]);
    }
    if (normalized === 'ROLLBACK') {
      if (this.snapshot) {
        this.row = this.snapshot.row;
        this.sessionStatus = this.snapshot.sessionStatus;
      }
      this.snapshot = null;
      this.txLog.push('ROLLBACK');
      return result([]);
    }
    if (normalized.startsWith('DELETE FROM agent_tests')) {
      this.lockOrder.push('Test');
      if (!this.row || this.row.status !== 'starting' || this.row.lease_token !== params[1]) {
        return result([]);
      }
      const id = this.row.id;
      this.row = null;
      return result([{ id } as R]);
    }
    if (normalized.includes('FROM sessions') && normalized.endsWith('FOR UPDATE')) {
      this.lockOrder.push('Session');
      if (!this.sessionExists) return result([]);
      return result([
        {
          id: IDS.test,
          owner_user_id: 'owner-1',
          mode: 'consume',
          status: this.sessionStatus,
        } as R,
      ]);
    }
    if (normalized.startsWith("UPDATE sessions s SET status = 'closed'")) {
      if (this.failClose) return result([]);
      this.sessionStatus = 'closed';
      return result([{ id: IDS.test } as R]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

function loadedRevision(): LoadedAgentRevision {
  return {
    projectId: IDS.project,
    revisionId: IDS.revision,
    releaseId: null,
    entryCapabilityId: '66666666-6666-4666-8666-666666666666',
    capabilityOwnerUserId: 'owner-1',
    runtimeBundleSha256: 'a'.repeat(64),
    uiArtifactId: '77777777-7777-4777-8777-777777777777',
    uiStorageKey: 'ui/revision.html',
    uiSha256: 'b'.repeat(64),
    bundle: {
      version: 1,
      compilerVersion: 'combo-agent-compiler/1',
      projectId: IDS.project,
      revisionId: IDS.revision,
      entryCapabilityId: '66666666-6666-4666-8666-666666666666',
      definition: {
        version: 1,
        name: 'Research Agent',
        summary: '',
        kind: 'agent',
        instructions: 'Return structured JSON.',
        inputs: [],
        starterPrompts: [],
        meta: { agent: { output: STRUCTURED_OUTPUT_CONTRACT } },
      },
      capabilityHashes: [],
      ui: {
        artifactId: '77777777-7777-4777-8777-777777777777',
        storageKey: 'ui/revision.html',
        sha256: 'b'.repeat(64),
        bridgeVersion: 1,
      },
    },
  };
}

describe('agent-project repo', () => {
  it('lists the owned Project recent Tests including starting and terminal states', async () => {
    const starting = testRow({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      request_key: 'agent-test-starting',
      lease_token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      lease_expires_at: '2026-08-05T02:01:00.000Z',
      session_id: null,
      turn_id: null,
      status: 'starting',
      created_at: '2026-08-05T02:00:00.000Z',
    });
    const failed = testRow({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      request_key: 'agent-test-failed',
      status: 'failed',
      error_code: 'TURN_PROMPT_FAILED',
      created_at: '2026-08-05T01:00:00.000Z',
      completed_at: '2026-08-05T01:00:03.000Z',
    });
    const db = new ListProjectTestsDb('owner-1', [failed, starting]);

    await expect(
      listAgentProjectTests(db, {
        projectId: IDS.project,
        ownerUserId: 'owner-1',
        limit: 2,
      }),
    ).resolves.toEqual([
      {
        id: starting.id,
        projectId: IDS.project,
        agentRevisionId: IDS.revision,
        requestKey: 'agent-test-starting',
        sessionId: null,
        turnId: null,
        status: 'starting',
        qualityStatus: 'unreviewed',
        canPublish: false,
        errorCode: null,
        createdAt: '2026-08-05T02:00:00.000Z',
        completedAt: null,
      },
      expect.objectContaining({
        id: failed.id,
        status: 'failed',
        errorCode: 'TURN_PROMPT_FAILED',
        completedAt: '2026-08-05T01:00:03.000Z',
      }),
    ]);
    expect(db.queries[1]?.sql).toContain('ORDER BY t.created_at DESC, t.id DESC LIMIT $3');
    expect(db.queries[1]?.params).toEqual([IDS.project, 'owner-1', 2]);
  });

  it('returns null without reading Tests when the Project is not owned', async () => {
    const db = new ListProjectTestsDb('owner-1', [testRow()]);

    await expect(
      listAgentProjectTests(db, {
        projectId: IDS.project,
        ownerUserId: 'owner-2',
        limit: 20,
      }),
    ).resolves.toBeNull();
    expect(db.queries).toHaveLength(1);
  });

  it('finalizes a completed structured-output turn as passed when JSON matches the contract', async () => {
    const db = new FinalizeTestDb(testRow(), [{ type: 'text', text: '{"answer":"grounded"}' }]);

    const detail = await readAndFinalizeAgentTest(db, IDS.test, 'owner-1');

    expect(detail).toMatchObject({
      test: {
        id: IDS.test,
        status: 'passed',
        errorCode: null,
        completedAt: '2026-08-05T01:00:01.000Z',
      },
      outputText: '{"answer":"grounded"}',
    });
    expect(db.queries.filter((sql) => sql.includes('UPDATE agent_tests'))).toHaveLength(1);
    expect(db.queries.find((sql) => sql.includes('JOIN turns tr'))).toContain('t.session_id');
  });

  it.each([
    ['non-JSON text', 'not-json'],
    ['JSON that violates the schema', '{"answer":42}'],
  ])('finalizes %s as failed with AGENT_OUTPUT_INVALID', async (_case, outputText) => {
    const db = new FinalizeTestDb(testRow(), [{ type: 'text', text: outputText }]);

    const detail = await readAndFinalizeAgentTest(db, IDS.test, 'owner-1');

    expect(detail).toMatchObject({
      test: {
        id: IDS.test,
        status: 'failed',
        errorCode: 'AGENT_OUTPUT_INVALID',
        completedAt: '2026-08-05T01:00:01.000Z',
      },
      outputText,
    });
    expect(db.queries.filter((sql) => sql.includes('UPDATE agent_tests'))).toHaveLength(1);
  });

  it('fails closed if persisted output metadata contains an async JSON Schema', async () => {
    const db = new FinalizeTestDb(
      testRow({
        output_contract: {
          type: 'structured',
          schema: { $async: true, type: 'object' },
        },
      }),
      [{ type: 'text', text: '{"answer":"grounded"}' }],
    );

    await expect(readAndFinalizeAgentTest(db, IDS.test, 'owner-1')).resolves.toMatchObject({
      test: { status: 'failed', errorCode: 'AGENT_OUTPUT_INVALID' },
    });
  });

  it('recovers the complete immutable quality Review with a terminal Test', async () => {
    const cases = [
      {
        caseId: 'normal-1',
        kind: 'normal',
        executionStatus: 'completed',
        qualityVerdict: 'passed',
        reason: 'Normal output met the expected result.',
      },
      {
        caseId: 'boundary-1',
        kind: 'boundary',
        executionStatus: 'completed',
        qualityVerdict: 'accepted_exception',
        reason: 'The missing optional field is surfaced.',
        impact: 'Only requests without that optional field need manual follow-up.',
      },
      {
        caseId: 'failure-1',
        kind: 'failure',
        executionStatus: 'completed',
        qualityVerdict: 'passed',
        reason: 'Invalid input produced the bounded error.',
      },
    ];
    const db = new FinalizeTestDb(
      testRow({
        status: 'passed',
        completed_at: '2026-08-05T01:00:01.000Z',
        quality_status: 'accepted_exception',
        review_id: '66666666-6666-4666-8666-666666666666',
        review_cases: cases,
        review_summary: 'Accepted one bounded exception.',
        review_sha256: 'd'.repeat(64),
        review_user_id: '77777777-7777-4777-8777-777777777777',
        review_created_at: '2026-08-05T01:01:00.000Z',
      }),
      [{ type: 'text', text: '{"answer":"grounded"}' }],
    );

    await expect(readAndFinalizeAgentTest(db, IDS.test, 'owner-1')).resolves.toMatchObject({
      test: { qualityStatus: 'accepted_exception', canPublish: true },
      review: {
        id: '66666666-6666-4666-8666-666666666666',
        testId: IDS.test,
        qualityStatus: 'accepted_exception',
        cases,
        summary: 'Accepted one bounded exception.',
        reviewSha256: 'd'.repeat(64),
        reviewerUserId: '77777777-7777-4777-8777-777777777777',
        reviewedAt: '2026-08-05T01:01:00.000Z',
        acceptedAt: '2026-08-05T01:01:00.000Z',
      },
    });
  });

  it('replays the same idempotency key and request hash, but conflicts on a different hash', async () => {
    const row = testRow();
    const db = new RequestTestDb(row);
    const request = {
      projectId: IDS.project,
      requestKey: row.request_key,
      requestSha256: row.request_sha256,
      ownerUserId: 'owner-1',
    };

    await expect(readAgentTestRequest(db, request)).resolves.toMatchObject({
      kind: 'replayed',
      test: {
        id: IDS.test,
        projectId: IDS.project,
        agentRevisionId: IDS.revision,
      },
    });
    await expect(
      readAgentTestRequest(db, { ...request, requestSha256: 'd'.repeat(64) }),
    ).resolves.toEqual({ kind: 'idempotency_conflict' });
  });

  it('publishes readiness only for a passed reviewed Test that still matches the active Head', async () => {
    const publishable = testRow({
      status: 'passed',
      completed_at: '2026-08-05T01:00:01.000Z',
      quality_status: 'accepted_exception',
    });
    await expect(
      readAgentTestRequest(new RequestTestDb(publishable), {
        projectId: IDS.project,
        requestKey: publishable.request_key,
        requestSha256: publishable.request_sha256,
        ownerUserId: 'owner-1',
      }),
    ).resolves.toMatchObject({
      kind: 'replayed',
      test: { qualityStatus: 'accepted_exception', canPublish: true },
    });

    const staleHead = testRow({
      status: 'passed',
      completed_at: '2026-08-05T01:00:01.000Z',
      quality_status: 'passed',
      current_head_revision_id: '99999999-9999-4999-8999-999999999999',
    });
    await expect(
      readAgentTestRequest(new RequestTestDb(staleHead), {
        projectId: IDS.project,
        requestKey: staleHead.request_key,
        requestSha256: staleHead.request_sha256,
        ownerUserId: 'owner-1',
      }),
    ).resolves.toMatchObject({ test: { qualityStatus: 'passed', canPublish: false } });

    const failedReview = testRow({
      status: 'passed',
      completed_at: '2026-08-05T01:00:01.000Z',
      quality_status: 'failed',
    });
    await expect(
      readAgentTestRequest(new RequestTestDb(failedReview), {
        projectId: IDS.project,
        requestKey: failedReview.request_key,
        requestSha256: failedReview.request_sha256,
        ownerUserId: 'owner-1',
      }),
    ).resolves.toMatchObject({ test: { qualityStatus: 'failed', canPublish: false } });
  });

  it('reserves the idempotency key before activation, then replays the single bound Test', async () => {
    const db = new ReservationTestDb();
    const input = {
      revision: loadedRevision(),
      requestKey: 'agent-test-request-1',
      requestSha256: 'c'.repeat(64),
    };

    const reserved = await reserveAgentTest(db, input);
    expect(reserved).toMatchObject({
      kind: 'acquired',
      testId: expect.any(String),
      leaseToken: expect.any(String),
    });
    await expect(reserveAgentTest(db, input)).resolves.toEqual({ kind: 'starting' });

    if (reserved.kind !== 'acquired') throw new Error('expected an acquired reservation');
    const activated = await activateAgentTest(db, {
      testId: reserved.testId,
      leaseToken: reserved.leaseToken,
      sessionId: IDS.session,
      turnId: IDS.turn,
    });
    expect(activated).toMatchObject({ id: reserved.testId, status: 'running' });
    await expect(reserveAgentTest(db, input)).resolves.toMatchObject({
      kind: 'replayed',
      test: { id: reserved.testId, sessionId: IDS.session, turnId: IDS.turn },
    });
    await expect(
      reserveAgentTest(db, { ...input, requestSha256: 'd'.repeat(64) }),
    ).resolves.toEqual({ kind: 'idempotency_conflict' });
  });

  it('atomically reclaims an expired starting lease without changing the Test identity', async () => {
    const db = new ReservationTestDb();
    const input = {
      revision: loadedRevision(),
      requestKey: 'agent-test-request-1',
      requestSha256: 'c'.repeat(64),
    };
    const first = await reserveAgentTest(db, input);
    if (first.kind !== 'acquired') throw new Error('expected first lease');
    db.expireReservation();

    const reclaimed = await reserveAgentTest(db, input);

    expect(reclaimed).toMatchObject({ kind: 'acquired', testId: first.testId });
    expect(reclaimed).not.toMatchObject({ leaseToken: first.leaseToken });
    if (reclaimed.kind !== 'acquired') throw new Error('expected reclaimed lease');
    await expect(
      deleteAgentTestReservation(db, {
        testId: first.testId,
        leaseToken: first.leaseToken,
      }),
    ).resolves.toBe(false);
    expect(db.hasReservation()).toBe(true);
    await expect(
      deleteAgentTestReservation(db, {
        testId: reclaimed.testId,
        leaseToken: reclaimed.leaseToken,
      }),
    ).resolves.toBe(true);
    expect(db.hasReservation()).toBe(false);
  });

  it('retries acquisition when a losing starting reservation is deleted before replay', async () => {
    const db = new ReservationTestDb();
    const input = {
      revision: loadedRevision(),
      requestKey: 'agent-test-request-1',
      requestSha256: 'c'.repeat(64),
    };
    const first = await reserveAgentTest(db, input);
    if (first.kind !== 'acquired') throw new Error('expected first lease');
    db.vanishOnNextReplay();

    await expect(reserveAgentTest(db, input)).resolves.toMatchObject({
      kind: 'acquired',
      testId: expect.any(String),
    });
  });

  it('atomically discards an owned claim and fixed Session, but leaves both for a stale token', async () => {
    const db = new DiscardReservationDb();
    await expect(
      discardAgentTestReservation(db, {
        testId: IDS.test,
        leaseToken: '99999999-9999-4999-8999-999999999999',
        ownerUserId: 'owner-1',
      }),
    ).resolves.toBe(false);
    expect(db.row).not.toBeNull();
    expect(db.sessionStatus).toBe('active');
    expect(db.lockOrder).toEqual(['Session', 'Test']);

    await expect(
      discardAgentTestReservation(db, {
        testId: IDS.test,
        leaseToken: '88888888-8888-4888-8888-888888888888',
        ownerUserId: 'owner-1',
      }),
    ).resolves.toBe(true);
    expect(db.row).toBeNull();
    expect(db.sessionStatus).toBe('closed');
    expect(db.txLog).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
    expect(db.lockOrder).toEqual(['Session', 'Test', 'Session', 'Test']);
  });

  it('keeps the claim when the fixed Session may still be committing', async () => {
    const db = new DiscardReservationDb();
    db.sessionExists = false;

    await expect(
      discardAgentTestReservation(db, {
        testId: IDS.test,
        leaseToken: '88888888-8888-4888-8888-888888888888',
        ownerUserId: 'owner-1',
      }),
    ).resolves.toBe(false);
    expect(db.row).not.toBeNull();
    expect(db.lockOrder).toEqual(['Session']);
    expect(db.txLog).toEqual(['BEGIN', 'COMMIT']);
  });

  it('rolls back claim deletion when its fixed Session cannot be closed', async () => {
    const db = new DiscardReservationDb();
    db.failClose = true;

    await expect(
      discardAgentTestReservation(db, {
        testId: IDS.test,
        leaseToken: '88888888-8888-4888-8888-888888888888',
        ownerUserId: 'owner-1',
      }),
    ).rejects.toThrow('could not be closed');
    expect(db.row).not.toBeNull();
    expect(db.sessionStatus).toBe('active');
    expect(db.txLog).toEqual(['BEGIN', 'ROLLBACK']);
    expect(db.lockOrder).toEqual(['Session', 'Test']);
  });
});
