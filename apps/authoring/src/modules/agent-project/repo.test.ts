import { describe, expect, it } from 'vitest';
import type { RecordAgentTestReviewBody } from '@cb/shared';
import type { TxConn, TxPool } from '../../platform/infra/db-tx.js';
import { createAgentRelease } from './repo.js';
import { recordAgentTestReview } from './service.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const REVISION_ID = '33333333-3333-4333-8333-333333333333';
const TEST_ID = '44444444-4444-4444-8444-444444444444';
const REVIEW_ID = '55555555-5555-4555-8555-555555555555';
const RELEASE_ID = '66666666-6666-4666-8666-666666666666';
const BUNDLE_SHA = 'a'.repeat(64);
const UI_SHA = 'b'.repeat(64);
const NOW = '2026-08-07T00:00:00.000Z';

const PROJECT_ROW = {
  id: PROJECT_ID,
  owner_user_id: OWNER_ID,
  name: 'Release reviewer',
  summary: '',
  source_task_id: null,
  status: 'active',
  head_revision_id: REVISION_ID,
  current_release_id: null,
  idempotency_key: 'project-create-1',
  idempotency_sha256: 'c'.repeat(64),
  created_at: NOW,
  updated_at: NOW,
};

function reviewCases(
  boundaryVerdict: 'passed' | 'accepted_exception' = 'accepted_exception',
): RecordAgentTestReviewBody['cases'] {
  return [
    {
      caseId: 'normal-1',
      kind: 'normal',
      executionStatus: 'completed',
      qualityVerdict: 'passed',
      reason: 'Normal input produced a complete decision.',
    },
    {
      caseId: 'boundary-1',
      kind: 'boundary',
      executionStatus: 'completed',
      qualityVerdict: boundaryVerdict,
      reason: 'Missing rollback details are surfaced explicitly.',
      ...(boundaryVerdict === 'accepted_exception'
        ? { impact: 'Only incomplete rollback inputs require a follow-up.' }
        : {}),
    },
    {
      caseId: 'failure-1',
      kind: 'failure',
      executionStatus: 'completed',
      qualityVerdict: 'passed',
      reason: 'A critical unresolved defect returns NO_GO.',
    },
  ];
}

interface ReviewRow {
  id: string;
  project_id: string;
  test_id: string;
  agent_revision_id: string;
  runtime_bundle_sha256: string;
  ui_sha256: string;
  quality_status: 'passed' | 'failed' | 'accepted_exception';
  cases: RecordAgentTestReviewBody['cases'];
  summary: string;
  review_sha256: string;
  idempotency_key: string;
  idempotency_sha256: string;
  created_by_user_id: string;
  created_at: string;
}

class ReviewTx implements TxConn {
  readonly statements: string[] = [];
  review: ReviewRow | null = null;

  constructor(
    readonly testStatus: 'running' | 'passed' | 'failed' = 'passed',
    readonly runtimeBundleSha256 = BUNDLE_SHA,
  ) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number }> {
    this.statements.push(sql.replace(/\s+/g, ' ').trim());
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM agent_projects') && sql.includes('FOR UPDATE')) {
      return { rows: [PROJECT_ROW as R], rowCount: 1 };
    }
    if (sql.includes('FROM agent_test_reviews') && sql.includes('idempotency_key = $2')) {
      const rows =
        this.review?.idempotency_key === params[1] ? ([this.review as R] satisfies R[]) : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM agent_test_reviews') && sql.includes('test_id = $2')) {
      const rows = this.review ? ([this.review as R] satisfies R[]) : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM agent_tests t')) {
      return {
        rows: [
          {
            agent_revision_id: REVISION_ID,
            runtime_bundle_sha256: this.runtimeBundleSha256,
            ui_sha256: UI_SHA,
            status: this.testStatus,
          } as R,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO agent_test_reviews')) {
      this.review = {
        id: REVIEW_ID,
        project_id: params[0] as string,
        test_id: params[1] as string,
        agent_revision_id: params[2] as string,
        runtime_bundle_sha256: params[3] as string,
        ui_sha256: params[4] as string,
        quality_status: params[5] as ReviewRow['quality_status'],
        cases: JSON.parse(params[6] as string) as RecordAgentTestReviewBody['cases'],
        summary: params[7] as string,
        review_sha256: params[8] as string,
        idempotency_key: params[9] as string,
        idempotency_sha256: params[10] as string,
        created_by_user_id: params[11] as string,
        created_at: NOW,
      };
      return { rows: [this.review as R], rowCount: 1 };
    }
    throw new Error(`ReviewTx did not expect SQL: ${sql}`);
  }

  release(): void {}
}

function pool(conn: TxConn): TxPool {
  return { connect: async () => conn };
}

function reviewBody(overrides: Partial<RecordAgentTestReviewBody> = {}): RecordAgentTestReviewBody {
  return {
    idempotencyKey: 'quality-review-0001',
    cases: reviewCases(),
    summary: 'Reviewed all three release-readiness cases.',
    ...overrides,
  };
}

describe('Agent Test quality review repository', () => {
  it('creates once, replays the same key and body, and conflicts on different content', async () => {
    const conn = new ReviewTx();
    const input = {
      projectId: PROJECT_ID,
      testId: TEST_ID,
      ownerUserId: OWNER_ID,
      body: reviewBody(),
    };

    const created = await recordAgentTestReview(pool(conn), input);
    const replayed = await recordAgentTestReview(pool(conn), input);
    const conflict = await recordAgentTestReview(pool(conn), {
      ...input,
      body: reviewBody({ summary: 'Different review content.' }),
    });

    expect(created).toMatchObject({
      kind: 'created',
      review: {
        qualityStatus: 'accepted_exception',
        reviewerUserId: OWNER_ID,
        reviewedAt: NOW,
        acceptedAt: NOW,
      },
    });
    expect(replayed).toEqual({ ...created, kind: 'replayed' });
    expect(conflict).toEqual({ kind: 'idempotency_conflict' });
    expect(
      conn.statements.filter((sql) => sql.startsWith('INSERT INTO agent_test_reviews')),
    ).toHaveLength(1);
  });

  it('rejects a non-passed technical Test and keeps the immutable Test review unique', async () => {
    const running = new ReviewTx('running');
    await expect(
      recordAgentTestReview(pool(running), {
        projectId: PROJECT_ID,
        testId: TEST_ID,
        ownerUserId: OWNER_ID,
        body: reviewBody(),
      }),
    ).resolves.toEqual({ kind: 'test_not_passed' });
    expect(running.review).toBeNull();

    const reviewed = new ReviewTx();
    await recordAgentTestReview(pool(reviewed), {
      projectId: PROJECT_ID,
      testId: TEST_ID,
      ownerUserId: OWNER_ID,
      body: reviewBody(),
    });
    await expect(
      recordAgentTestReview(pool(reviewed), {
        projectId: PROJECT_ID,
        testId: TEST_ID,
        ownerUserId: OWNER_ID,
        body: reviewBody({ idempotencyKey: 'quality-review-0002' }),
      }),
    ).resolves.toEqual({ kind: 'review_exists' });
  });

  it('hashes the frozen Test Revision, Runtime Bundle and UI into the review evidence', async () => {
    const first = await recordAgentTestReview(pool(new ReviewTx('passed', 'd'.repeat(64))), {
      projectId: PROJECT_ID,
      testId: TEST_ID,
      ownerUserId: OWNER_ID,
      body: reviewBody(),
    });
    const second = await recordAgentTestReview(pool(new ReviewTx('passed', 'e'.repeat(64))), {
      projectId: PROJECT_ID,
      testId: TEST_ID,
      ownerUserId: OWNER_ID,
      body: reviewBody(),
    });
    if (first.kind !== 'created' || second.kind !== 'created') throw new Error('expected reviews');
    expect(first.review.reviewSha256).not.toBe(second.review.reviewSha256);
  });
});

class ReleaseTx implements TxConn {
  readonly statements: string[] = [];
  insertedParams: unknown[] | null = null;

  constructor(readonly reviewStatus: 'passed' | 'failed' | 'accepted_exception' | null) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number }> {
    this.statements.push(sql.replace(/\s+/g, ' ').trim());
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM agent_projects') && sql.includes('FOR UPDATE')) {
      return { rows: [PROJECT_ROW as R], rowCount: 1 };
    }
    if (sql.includes('FROM agent_releases') && sql.includes('idempotency_key = $2')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM agent_revisions r') && sql.includes('LEFT JOIN agent_test_reviews')) {
      return {
        rows: [
          {
            runtime_bundle_sha256: BUNDLE_SHA,
            ui_sha256: UI_SHA,
            status: 'passed',
            qualifying_review_id: this.reviewStatus ? REVIEW_ID : null,
            review_sha256: this.reviewStatus ? 'f'.repeat(64) : null,
            quality_status: this.reviewStatus,
          } as R,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('max(version_number)')) {
      return { rows: [{ version_number: 1 } as R], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO agent_releases')) {
      this.insertedParams = params;
      return {
        rows: [
          {
            id: RELEASE_ID,
            project_id: PROJECT_ID,
            version_number: 1,
            agent_revision_id: REVISION_ID,
            qualifying_test_id: TEST_ID,
            qualifying_review_id: params[5],
            review_sha256: params[6],
            runtime_bundle_sha256: BUNDLE_SHA,
            ui_sha256: UI_SHA,
            release_sha256: params[9],
            notes: '',
            idempotency_key: 'release-request-1',
            idempotency_sha256: '1'.repeat(64),
            created_at: NOW,
          } as R,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('UPDATE agent_projects')) return { rows: [], rowCount: 1 };
    throw new Error(`ReleaseTx did not expect SQL: ${sql}`);
  }

  release(): void {}
}

describe('Agent Release review fence', () => {
  const input = {
    projectId: PROJECT_ID,
    ownerUserId: OWNER_ID,
    expectedHeadRevisionId: REVISION_ID,
    agentRevisionId: REVISION_ID,
    qualifyingTestId: TEST_ID,
    idempotencyKey: 'release-request-1',
    idempotencySha256: '1'.repeat(64),
    notes: '',
  };

  it('freezes the publishable review id and digest into a new Release', async () => {
    const conn = new ReleaseTx('accepted_exception');
    const outcome = await createAgentRelease(pool(conn), input);

    expect(outcome).toMatchObject({
      kind: 'created',
      release: {
        qualifyingReviewId: REVIEW_ID,
        reviewSha256: 'f'.repeat(64),
      },
    });
    expect(conn.insertedParams?.[5]).toBe(REVIEW_ID);
    expect(conn.insertedParams?.[6]).toBe('f'.repeat(64));
  });

  it.each([null, 'failed'] as const)(
    'rejects a missing or failed quality review (%s)',
    async (reviewStatus) => {
      const conn = new ReleaseTx(reviewStatus);
      await expect(createAgentRelease(pool(conn), input)).resolves.toEqual({
        kind: 'review_not_publishable',
      });
      expect(conn.insertedParams).toBeNull();
    },
  );
});
