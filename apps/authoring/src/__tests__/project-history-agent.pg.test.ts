import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseAgentPackageShareV2,
  serializeAgentPackageShareV2,
} from '@cb/creator-agent-protocol/agent-package-share';

import { createProjectHistoryAgentService } from '../modules/project-history-agent/service.js';
import {
  cleanupRetiredProjectHistoryAgentConfirmations,
  PgProjectHistoryAgentRepository,
} from '../modules/project-history-agent/repo.js';
import { asTxPool } from '../platform/infra/db-tx.js';

const enabled =
  process.env.PROJECT_HISTORY_AGENT_PG_TEST === '1' &&
  Boolean(
    process.env.PROJECT_HISTORY_AGENT_TEST_DATABASE_URL &&
    process.env.PROJECT_HISTORY_AGENT_API_DATABASE_URL,
  );
const pgDescribe = enabled ? describe : describe.skip;

pgDescribe('Project-history Agent PostgreSQL persistence', () => {
  let adminPool: Pool;
  let apiPool: Pool;
  let ownerUserId: string;
  let persistedShareUrl = '';

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.PROJECT_HISTORY_AGENT_TEST_DATABASE_URL });
    apiPool = new Pool({
      connectionString: process.env.PROJECT_HISTORY_AGENT_API_DATABASE_URL,
      max: 6,
    });
    const identity = await apiPool.query<{ current_user: string }>(
      'SELECT current_user::text AS current_user',
    );
    if (identity.rows[0]?.current_user !== 'combo_api') {
      throw new Error('Project-history Agent API test connection must use combo_api');
    }
    const schema = await adminPool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN (
            'project_history_agent_drafts',
            'project_history_agent_confirmations',
            'project_history_agent_shares'
          )`,
    );
    if (schema.rows.length !== 3) throw new Error('Project-history Agent migration is not applied');
    ownerUserId = randomUUID();
    await adminPool.query(`INSERT INTO users (id, account) VALUES ($1, $2)`, [
      ownerUserId,
      randomCreatorAccount(),
    ]);
  });

  afterAll(async () => {
    await Promise.all([adminPool?.end(), apiPool?.end()]);
  });

  function service(clock?: { now(): Date }) {
    return createProjectHistoryAgentService({
      repository: new PgProjectHistoryAgentRepository(asTxPool(apiPool), apiPool),
      publicOrigin: 'https://combo.example',
      ...(clock ? { clock } : {}),
    });
  }

  it('survives restart and atomically consumes one confirmation under competing requests', async () => {
    const first = service();
    const created = await first.createDraft(ownerUserId, {
      creatorRequest: '把这个 Project 里以前完成过的方法做成一个 Agent。',
      candidate: {
        name: 'PostgreSQL 证据核验员',
        description: '验证持久化与幂等。',
        instructions: '读取当前 Project B 的用户提供材料，只做分析并给出证据。',
        starterPrompts: ['核对 B_CONTEXT。'],
        outputDescription: '返回结论、证据和边界。',
      },
      sourceEvidence: {
        kind: 'host_project_scoped_reduced_history',
        selection: 'user_selected_saved_project',
        assurance: 'best_effort',
        completeness: 'not_proven',
        hostAttestation: 'not_proven',
        sourceProjectionEnforced: 'not_proven',
        rawStored: false,
        projectCount: 1,
        discoveredThreadCount: 2,
        readThreadCount: 2,
        omittedThreadCount: 1,
        completedTurnCount: 7,
        userVisibleMessageCount: 11,
        omittedItemCount: 4,
        limitationReasons: [
          'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
          'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
          'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
        ],
      },
      idempotencyKey: randomUUID(),
    });
    await expect(
      adminPool.query(
        `INSERT INTO project_history_agent_drafts (
           draft_id, revision, owner_user_id, draft_fingerprint, candidate_commitment,
           draft_json, idempotency_key, request_fingerprint, created_at
         )
         SELECT $1, 2, owner_user_id, draft_fingerprint, candidate_commitment,
                draft_json, $2, $3, clock_timestamp()
           FROM project_history_agent_drafts
          WHERE owner_user_id = $4 AND draft_id = $5 AND revision = 1`,
        [
          `draft.agent-package.${randomBytes(16).toString('hex')}`,
          randomUUID(),
          `sha256:${randomBytes(32).toString('hex')}`,
          ownerUserId,
          created.draft.draftId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const rendered = await service({ now: () => new Date('2100-01-01T00:00:00.000Z') }).renderDraft(
      ownerUserId,
      {
        draftId: created.draft.draftId,
        draftFingerprint: created.draft.draftFingerprint,
      },
    );
    const confirmationDigest = createHash('sha256')
      .update(rendered.confirmation.confirmationToken, 'utf8')
      .digest('hex');
    const minted = await adminPool.query<{ created_at: Date; expires_at: Date }>(
      `SELECT created_at, expires_at
         FROM project_history_agent_confirmations
        WHERE confirmation_token_sha256 = $1`,
      [confirmationDigest],
    );
    const mintedRow = minted.rows[0];
    expect(mintedRow).toBeDefined();
    if (!mintedRow) throw new Error('confirmation mint row missing');
    expect(mintedRow.expires_at.getTime() - mintedRow.created_at.getTime()).toBe(5 * 60 * 1_000);
    expect(rendered.confirmation.expiresAt).toBe(mintedRow.expires_at.toISOString());
    expect(rendered.confirmation.expiresAt).not.toContain('2100-01-01');
    const candidateInputs = [randomUUID(), randomUUID()].map((idempotencyKey) => ({
      draftId: created.draft.draftId,
      draftFingerprint: created.draft.draftFingerprint,
      confirmationToken: rendered.confirmation.confirmationToken,
      idempotencyKey,
    }));
    const outcomes = await Promise.allSettled(
      candidateInputs.map((input) => service().createShare(ownerUserId, input)),
    );
    const successIndex = outcomes.findIndex(({ status }) => status === 'fulfilled');
    expect(successIndex).toBeGreaterThanOrEqual(0);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(
      outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        ?.reason,
    ).toMatchObject({ code: 'confirmation_invalid' });
    const shared = (
      outcomes[successIndex] as PromiseFulfilledResult<
        Awaited<ReturnType<ReturnType<typeof service>['createShare']>>
      >
    ).value;
    persistedShareUrl = shared.shareUrl;
    await expect(
      first.createShare(ownerUserId, candidateInputs[successIndex]!),
    ).resolves.toMatchObject({
      created: false,
      packageDigest: shared.packageDigest,
      shareUrl: shared.shareUrl,
    });

    const restarted = service();
    await expect(restarted.readShare({ shareUrl: shared.shareUrl })).resolves.toMatchObject({
      packageDigest: shared.packageDigest,
      shareUrl: shared.shareUrl,
      share: { sourceDraftFingerprint: created.draft.draftFingerprint },
    });
    await expect(
      restarted.prepareRun({
        shareUrl: shared.shareUrl,
        packageDigest: shared.packageDigest,
        starterOrdinal: 1,
        starterPrompt: '核对 B_CONTEXT。',
      }),
    ).resolves.toMatchObject({
      packageDigest: shared.packageDigest,
      runtimeMaterial: { agentMarkdown: expect.stringContaining('PostgreSQL 证据核验员') },
    });

    const rows = await adminPool.query<{
      draft_json: string;
      confirmation_token_sha256: string;
      share_count: string;
    }>(
      `SELECT d.draft_json, s.confirmation_token_sha256,
              (SELECT count(*)::text FROM project_history_agent_shares
                WHERE owner_user_id = $1) AS share_count
         FROM project_history_agent_drafts d
         JOIN project_history_agent_shares s
           ON s.owner_user_id = d.owner_user_id AND s.draft_id = d.draft_id
        WHERE d.owner_user_id = $1`,
      [ownerUserId],
    );
    expect(rows.rows[0]?.share_count).toBe('1');
    expect(rows.rows[0]?.confirmation_token_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(rows.rows[0]?.draft_json).not.toMatch(
      /projectId|threadId|sessionId|transcript|RAW_SESSION_DECOY/u,
    );

    await expect(
      cleanupRetiredProjectHistoryAgentConfirmations(apiPool, 100),
    ).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      first.createShare(ownerUserId, candidateInputs[successIndex]!),
    ).resolves.toMatchObject({
      created: false,
      packageDigest: shared.packageDigest,
    });
  });

  it('rejects starter, release, and creation-time corruption against the immutable Share JSON digest', async () => {
    const shareToken = new URL(persistedShareUrl).pathname.split('/').at(-1)!;
    const stored = await adminPool.query<{ share_json: string; share_json_sha256: string }>(
      `SELECT share_json, share_json_sha256
         FROM project_history_agent_shares
        WHERE share_token = $1`,
      [shareToken],
    );
    const original = stored.rows[0]!;
    const share = parseAgentPackageShareV2(original.share_json);
    const originalPrompt = share.starterPrompts[0]!;
    const tamperedPrompt = '数据库篡改后的起始任务。';
    const tamperedStarterJson = original.share_json.replace(
      JSON.stringify(originalPrompt),
      JSON.stringify(tamperedPrompt),
    );
    const tamperedStarterJsonSha256 = createHash('sha256')
      .update(tamperedStarterJson, 'utf8')
      .digest('hex');
    const tamperedShares = [
      { ...share, releaseId: `release.agent-package.${'9'.repeat(32)}` },
      { ...share, createdAt: '2026-08-29T00:00:01.000Z' },
    ];
    const corruptor = await adminPool.connect();
    try {
      await corruptor.query(`SET session_replication_role = replica`);
      await corruptor.query(
        `UPDATE project_history_agent_shares
            SET share_json = $2, share_json_sha256 = $3
          WHERE share_token = $1`,
        [shareToken, tamperedStarterJson, tamperedStarterJsonSha256],
      );
      await corruptor.query(`SET session_replication_role = origin`);

      await expect(service().readShare({ shareUrl: persistedShareUrl })).rejects.toThrow(
        /digest-bound Package starter/u,
      );
      await expect(
        service().prepareRun({
          shareUrl: persistedShareUrl,
          packageDigest: share.packageDigest,
          starterOrdinal: 1,
          starterPrompt: tamperedPrompt,
        }),
      ).rejects.toThrow(/digest-bound Package starter/u);

      await corruptor.query(`SET session_replication_role = replica`);
      await corruptor.query(
        `UPDATE project_history_agent_shares
            SET share_json = $2, share_json_sha256 = $3
          WHERE share_token = $1`,
        [shareToken, original.share_json, original.share_json_sha256],
      );
      await corruptor.query(`SET session_replication_role = origin`);

      for (const tampered of tamperedShares) {
        await corruptor.query(`SET session_replication_role = replica`);
        await corruptor.query(
          `UPDATE project_history_agent_shares SET share_json = $2 WHERE share_token = $1`,
          [shareToken, serializeAgentPackageShareV2(tampered)],
        );
        await corruptor.query(`SET session_replication_role = origin`);

        await expect(service().readShare({ shareUrl: persistedShareUrl })).rejects.toThrow(
          'share materialization mismatch',
        );
        const digest = await adminPool.query<{ share_json_sha256: string }>(
          `SELECT share_json_sha256 FROM project_history_agent_shares WHERE share_token = $1`,
          [shareToken],
        );
        expect(digest.rows[0]?.share_json_sha256).toBe(original.share_json_sha256);

        await corruptor.query(`SET session_replication_role = replica`);
        await corruptor.query(
          `UPDATE project_history_agent_shares SET share_json = $2 WHERE share_token = $1`,
          [shareToken, original.share_json],
        );
        await corruptor.query(`SET session_replication_role = origin`);
      }
    } finally {
      await corruptor.query(`SET session_replication_role = replica`).catch(() => undefined);
      await corruptor
        .query(
          `UPDATE project_history_agent_shares
              SET share_json = $2, share_json_sha256 = $3
            WHERE share_token = $1`,
          [shareToken, original.share_json, original.share_json_sha256],
        )
        .catch(() => undefined);
      await corruptor.query(`SET session_replication_role = origin`).catch(() => undefined);
      corruptor.release();
    }
  });

  it('prevents the API role and table constraints from minting a future or overlong confirmation', async () => {
    const draft = await adminPool.query<{
      draft_id: string;
      revision: string;
      draft_fingerprint: string;
    }>(
      `SELECT draft_id, revision, draft_fingerprint
         FROM project_history_agent_drafts
        WHERE owner_user_id = $1
        ORDER BY created_at
        LIMIT 1`,
      [ownerUserId],
    );
    const row = draft.rows[0]!;
    const insertSql = `INSERT INTO project_history_agent_confirmations (
      owner_user_id, draft_id, revision, draft_fingerprint, confirmation_token_sha256,
      created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp() + interval '6 minutes')`;
    const params = [
      ownerUserId,
      row.draft_id,
      Number(row.revision),
      row.draft_fingerprint,
      createHash('sha256').update('future-api-confirmation', 'utf8').digest('hex'),
    ];
    await expect(apiPool.query(insertSql, params)).rejects.toMatchObject({ code: '42501' });
    await expect(
      adminPool.query(insertSql, [
        ...params.slice(0, 4),
        createHash('sha256').update('future-admin-confirmation', 'utf8').digest('hex'),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('runs bounded concurrent retention without deleting an active confirmation', async () => {
    const draft = await adminPool.query<{
      draft_id: string;
      revision: string;
      draft_fingerprint: string;
    }>(
      `SELECT draft_id, revision, draft_fingerprint
         FROM project_history_agent_drafts
        WHERE owner_user_id = $1
        ORDER BY created_at
        LIMIT 1`,
      [ownerUserId],
    );
    const row = draft.rows[0]!;
    const digests = ['retired-a', 'retired-b', 'retired-c', 'consumed', 'active'].map((label) =>
      createHash('sha256').update(`cleanup-${label}`, 'utf8').digest('hex'),
    );
    for (const [index, digest] of digests.entries()) {
      const retired = index < 3;
      const consumed = index === 3;
      await adminPool.query(
        `WITH database_clock AS (SELECT clock_timestamp() AS checked_at)
         INSERT INTO project_history_agent_confirmations (
           owner_user_id, draft_id, revision, draft_fingerprint,
           confirmation_token_sha256, created_at, expires_at, consumed_at,
           consumed_share_token
         ) SELECT
           $1, $2, $3, $4, $5,
           CASE WHEN $6 THEN '2000-01-01T00:00:00.000Z'::timestamptz ELSE database_clock.checked_at END,
           CASE WHEN $6 THEN '2000-01-01T00:05:00.000Z'::timestamptz ELSE database_clock.checked_at + interval '5 minutes' END,
           CASE WHEN $7 THEN database_clock.checked_at ELSE NULL END,
           CASE WHEN $7 THEN $8 ELSE NULL END
         FROM database_clock`,
        [
          ownerUserId,
          row.draft_id,
          Number(row.revision),
          row.draft_fingerprint,
          digest,
          retired,
          consumed,
          'R'.repeat(43),
        ],
      );
    }

    const concurrent = await Promise.all([
      cleanupRetiredProjectHistoryAgentConfirmations(apiPool, 1),
      cleanupRetiredProjectHistoryAgentConfirmations(apiPool, 1),
    ]);
    expect(concurrent.reduce((total, count) => total + count, 0)).toBe(2);
    const afterBounded = await adminPool.query<{ digest: string }>(
      `SELECT confirmation_token_sha256 AS digest
         FROM project_history_agent_confirmations
        WHERE confirmation_token_sha256 = ANY($1::char(64)[])`,
      [digests],
    );
    const afterBoundedDigests = afterBounded.rows.map(({ digest }) => digest);
    expect(afterBoundedDigests).toHaveLength(3);
    expect(afterBoundedDigests).toEqual(expect.arrayContaining([digests[3], digests[4]]));
    expect(
      afterBoundedDigests.filter((digest) => digests.slice(0, 3).includes(digest)),
    ).toHaveLength(1);

    await expect(
      cleanupRetiredProjectHistoryAgentConfirmations(apiPool, 100),
    ).resolves.toBeGreaterThanOrEqual(2);
    const finalRows = await adminPool.query<{ digest: string }>(
      `SELECT confirmation_token_sha256 AS digest
         FROM project_history_agent_confirmations
        WHERE confirmation_token_sha256 = ANY($1::char(64)[])`,
      [digests],
    );
    expect(finalRows.rows.map(({ digest }) => digest)).toEqual([digests[4]]);
    await expect(
      apiPool.query(
        `DELETE FROM project_history_agent_confirmations WHERE confirmation_token_sha256 = $1`,
        [digests[4]],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('serializes one idempotency key across different Drafts into a stable conflict', async () => {
    const createRendered = async (name: string) => {
      const current = service();
      const created = await current.createDraft(ownerUserId, {
        creatorRequest: '把这个 Project 里以前完成过的方法做成一个 Agent。',
        candidate: {
          name,
          description: '验证跨草稿幂等竞态。',
          instructions: '只读分析当前 Project B 的用户材料，然后返回证据。',
          starterPrompts: ['检查 B_CONTEXT 竞态。'],
          outputDescription: '返回结论、证据和边界。',
        },
        sourceEvidence: {
          kind: 'host_project_scoped_reduced_history',
          selection: 'user_selected_saved_project',
          assurance: 'best_effort',
          completeness: 'not_proven',
          hostAttestation: 'not_proven',
          sourceProjectionEnforced: 'not_proven',
          rawStored: false,
          projectCount: 1,
          discoveredThreadCount: 1,
          readThreadCount: 1,
          omittedThreadCount: 0,
          completedTurnCount: 2,
          userVisibleMessageCount: 4,
          omittedItemCount: 1,
          limitationReasons: [
            'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
            'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
            'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
          ],
        },
        idempotencyKey: randomUUID(),
      });
      const rendered = await current.renderDraft(ownerUserId, {
        draftId: created.draft.draftId,
        draftFingerprint: created.draft.draftFingerprint,
      });
      return { current, created, rendered };
    };

    const [left, right] = await Promise.all([
      createRendered('PostgreSQL 幂等左侧'),
      createRendered('PostgreSQL 幂等右侧'),
    ]);
    const sharedIdempotencyKey = randomUUID();
    const outcomes = await Promise.allSettled([
      left.current.createShare(ownerUserId, {
        draftId: left.created.draft.draftId,
        draftFingerprint: left.created.draft.draftFingerprint,
        confirmationToken: left.rendered.confirmation.confirmationToken,
        idempotencyKey: sharedIdempotencyKey,
      }),
      right.current.createShare(ownerUserId, {
        draftId: right.created.draft.draftId,
        draftFingerprint: right.created.draft.draftFingerprint,
        confirmationToken: right.rendered.confirmation.confirmationToken,
        idempotencyKey: sharedIdempotencyKey,
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejection = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(rejection?.reason).toMatchObject({ code: 'idempotency_conflict' });
    const stored = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM project_history_agent_shares
        WHERE owner_user_id = $1 AND idempotency_key = $2`,
      [ownerUserId, sharedIdempotencyKey],
    );
    expect(stored.rows[0]?.count).toBe('1');
  });

  it('rejects a request that starts before expiry but obtains the row lock after expiry', async () => {
    const current = service();
    const created = await current.createDraft(ownerUserId, {
      creatorRequest: '把这个 Project 里以前完成过的方法做成一个 Agent。',
      candidate: {
        name: 'PostgreSQL 跨锁过期核验员',
        description: '验证确认凭据在等待锁期间到期。',
        instructions: '只读分析当前 Project B 的用户材料并报告边界。',
        starterPrompts: ['核验过期边界。'],
        outputDescription: '返回过期结论与数据库证据。',
      },
      sourceEvidence: {
        kind: 'host_project_scoped_reduced_history',
        selection: 'user_selected_saved_project',
        assurance: 'best_effort',
        completeness: 'not_proven',
        hostAttestation: 'not_proven',
        sourceProjectionEnforced: 'not_proven',
        rawStored: false,
        projectCount: 1,
        discoveredThreadCount: 1,
        readThreadCount: 1,
        omittedThreadCount: 0,
        completedTurnCount: 2,
        userVisibleMessageCount: 4,
        omittedItemCount: 0,
        limitationReasons: [
          'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
          'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
          'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
        ],
      },
      idempotencyKey: randomUUID(),
    });
    const confirmationToken = `cfrm_${Buffer.alloc(32, 29).toString('base64url')}`;
    const confirmationDigest = createHash('sha256').update(confirmationToken, 'utf8').digest('hex');
    const inserted = await adminPool.query<{ expires_at: Date }>(
      `WITH database_clock AS (
         SELECT clock_timestamp() - interval '4 minutes 57 seconds' AS created_at
       )
       INSERT INTO project_history_agent_confirmations (
         owner_user_id, draft_id, revision, draft_fingerprint,
         confirmation_token_sha256, created_at, expires_at
       ) SELECT $1, $2, $3, $4, $5, database_clock.created_at,
                database_clock.created_at + interval '5 minutes'
           FROM database_clock
       RETURNING expires_at`,
      [
        ownerUserId,
        created.draft.draftId,
        created.draft.revision,
        created.draft.draftFingerprint,
        confirmationDigest,
      ],
    );
    const expiresAt = inserted.rows[0]!.expires_at;
    const blocker = await adminPool.connect();
    let transactionOpen = true;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT confirmation_token_sha256
           FROM project_history_agent_confirmations
          WHERE confirmation_token_sha256 = $1
          FOR UPDATE`,
        [confirmationDigest],
      );
      const before = await adminPool.query<{ valid: boolean }>(
        'SELECT clock_timestamp() < $1::timestamptz AS valid',
        [expiresAt],
      );
      expect(before.rows[0]?.valid).toBe(true);

      const shareOutcome = current
        .createShare(ownerUserId, {
          draftId: created.draft.draftId,
          draftFingerprint: created.draft.draftFingerprint,
          confirmationToken,
          idempotencyKey: randomUUID(),
        })
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );

      let lockObserved = false;
      for (let attempt = 0; attempt < 100 && !lockObserved; attempt += 1) {
        const waiting = await adminPool.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM pg_stat_activity
              WHERE usename = 'combo_api'
                AND wait_event_type = 'Lock'
                AND query LIKE '%project_history_agent_confirmations%'
                AND query LIKE '%FOR UPDATE%'
           ) AS blocked`,
        );
        lockObserved = waiting.rows[0]?.blocked === true;
        if (!lockObserved) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(lockObserved).toBe(true);

      let expired = false;
      for (let attempt = 0; attempt < 160 && !expired; attempt += 1) {
        const clock = await adminPool.query<{ expired: boolean }>(
          'SELECT clock_timestamp() >= $1::timestamptz AS expired',
          [expiresAt],
        );
        expired = clock.rows[0]?.expired === true;
        if (!expired) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(expired).toBe(true);
      await blocker.query('COMMIT');
      transactionOpen = false;

      const outcome = await shareOutcome;
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ code: 'confirmation_invalid' });
      }
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    const shares = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM project_history_agent_shares
        WHERE confirmation_token_sha256 = $1`,
      [confirmationDigest],
    );
    expect(shares.rows[0]?.count).toBe('0');
  });
});

function randomCreatorAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('')}`;
}
