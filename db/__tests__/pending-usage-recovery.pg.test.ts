import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.PENDING_USAGE_RECOVERY_PG_TEST === '1' && Boolean(databaseUrl);
const pgDescribe = enabled ? describe : describe.skip;

const CAPABILITY_PROTOCOL = 'combo.agent-package-capability/2';
const PACKAGE_PROTOCOL = 'combo.agent-package/1';
const RELEASE_PROTOCOL = 'combo.agent-package-release/1';
const RELEASE_SCOPE = 'controlled_test';
const RESOURCE_PATH = 'skills/knowledge/references/knowledge-bundle.json';
const BILLING_POLICY = 'knowledge-billing-v1';
const VALIDATOR_POLICY = 'knowledge-citations-v1';
const UNIT_PRICE_CENTS = 1;
const FREE_LIMIT = 3;
const RECEIPT_PROTOCOL = 'combo.agent-usage-receipt/1';
const RUNTIME_SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678';
const RUNTIME_RELEASE_ID = `release-${RUNTIME_SOURCE_SHA}`;
const ANSWER_TEXT = 'Agent Package 的身份由 exact digest 冻结。';
const INSUFFICIENT_TEXT = '现有知识证据不足，不能可靠回答。';
const CITATION_ID = 'chunk.knowledge.0123456789abcdef0123456789abcdef';

type TerminalOutcome = 'answered' | 'insufficient_evidence' | 'failed' | 'interrupted';

interface DatabaseError {
  code?: string;
  constraint?: string;
}

interface PendingFixture {
  publisherUserId: string;
  ownerUserId: string;
  capabilityId: string;
  sessionId: string;
  usageId: string;
  requestText: string;
  requestFingerprint: string;
  releaseId: string;
  packageDigest: string;
  resourceDigest: string;
}

let savepointSequence = 0;

function digest(label: string): string {
  return `sha256:${createHash('sha256').update(`${label}:${randomUUID()}`).digest('hex')}`;
}

function creatorAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${randomUUID()
    .replaceAll('-', '')
    .slice(0, 8)
    .split('')
    .map((character) => alphabet[Number.parseInt(character, 16)]!)
    .join('')}`;
}

function releaseId(): string {
  return `release.agent-package.${randomUUID().replaceAll('-', '')}`;
}

async function expectDatabaseError(
  client: Client,
  operation: () => Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  const savepoint = `pending_recovery_expect_${(savepointSequence += 1)}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let caught: DatabaseError | undefined;
  try {
    await operation();
  } catch (error) {
    caught = error as DatabaseError;
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  expect(caught).toMatchObject({ code });
  if (constraint) expect(caught?.constraint).toBe(constraint);
}

async function seedPending(
  client: Client,
  options: { createdAt?: string; expiresAt?: string } = {},
): Promise<PendingFixture> {
  const packageDigest = digest('package');
  const resourceDigest = digest('resource');
  const exactReleaseId = releaseId();
  const usageId = randomUUID();
  const requestText = '请根据知识包解释 Combo 的 Agent Package 不变量。';
  const requestFingerprint = createHash('sha256')
    .update(`pending:${usageId}:${requestText}`)
    .digest('hex');
  const publisherUserId = (
    await client.query<{ id: string }>('INSERT INTO users (account) VALUES ($1) RETURNING id', [
      creatorAccount(),
    ])
  ).rows[0]!.id;
  const ownerUserId = (
    await client.query<{ id: string }>('INSERT INTO users (account) VALUES ($1) RETURNING id', [
      creatorAccount(),
    ])
  ).rows[0]!.id;
  const taskId = (
    await client.query<{ id: string }>(
      `INSERT INTO tasks (owner_user_id, idempotency_key)
       VALUES ($1, $2) RETURNING id`,
      [publisherUserId, `pending-task-${randomUUID()}`],
    )
  ).rows[0]!.id;
  const capabilityId = (
    await client.query<{ id: string }>(
      `INSERT INTO capabilities (task_id, owner_user_id, name, kind, storage_key, published)
       VALUES ($1, $2, 'Recovery Knowledge', 'knowledge', $3, true)
       RETURNING id`,
      [taskId, publisherUserId, `pending/${randomUUID()}`],
    )
  ).rows[0]!.id;
  await client.query(
    `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
     VALUES ($1, $2, $3)`,
    [packageDigest, PACKAGE_PROTOCOL, publisherUserId],
  );
  await client.query(
    `INSERT INTO agent_package_releases (
       release_id, package_digest, owner_user_id, protocol, release_scope,
       idempotency_key, request_sha256
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      exactReleaseId,
      packageDigest,
      publisherUserId,
      RELEASE_PROTOCOL,
      RELEASE_SCOPE,
      randomUUID(),
      createHash('sha256').update(randomUUID()).digest('hex'),
    ],
  );
  const sessionId = (
    await client.query<{ id: string }>(
      `INSERT INTO sessions (
         capability_id, owner_user_id, mode, product_kind, capability_protocol,
         release_id, package_digest, release_scope,
         knowledge_resource_path, knowledge_resource_digest
       ) VALUES ($1, $2, 'consume', 'knowledge_agent_test', $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        capabilityId,
        ownerUserId,
        CAPABILITY_PROTOCOL,
        exactReleaseId,
        packageDigest,
        RELEASE_SCOPE,
        RESOURCE_PATH,
        resourceDigest,
      ],
    )
  ).rows[0]!.id;
  await client.query(
    `INSERT INTO pending_usage_recoveries (
       owner_user_id, usage_id, session_id, capability_id,
       request_text, request_fingerprint, product_kind, capability_protocol,
       release_id, package_digest, release_scope,
       knowledge_resource_path, knowledge_resource_digest,
       billing_policy_version, validator_policy_version,
       unit_price_cents, free_limit_snapshot, active_recharge_intent_id,
       created_at, updated_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'knowledge_agent_test', $7,
       $8, $9, $10, $11, $12, $13, $14, $15, $16, $2,
       COALESCE($17::timestamptz, now()), COALESCE($17::timestamptz, now()),
       COALESCE($18::timestamptz, now() + interval '7 days')
     )`,
    [
      ownerUserId,
      usageId,
      sessionId,
      capabilityId,
      requestText,
      requestFingerprint,
      CAPABILITY_PROTOCOL,
      exactReleaseId,
      packageDigest,
      RELEASE_SCOPE,
      RESOURCE_PATH,
      resourceDigest,
      BILLING_POLICY,
      VALIDATOR_POLICY,
      UNIT_PRICE_CENTS,
      FREE_LIMIT,
      options.createdAt ?? null,
      options.expiresAt ?? null,
    ],
  );
  return {
    publisherUserId,
    ownerUserId,
    capabilityId,
    sessionId,
    usageId,
    requestText,
    requestFingerprint,
    releaseId: exactReleaseId,
    packageDigest,
    resourceDigest,
  };
}

async function insertSiblingPending(client: Client, fixture: PendingFixture): Promise<string> {
  const usageId = randomUUID();
  const requestText = '这是同一 Session 的下一条待恢复请求。';
  await client.query(
    `INSERT INTO pending_usage_recoveries (
       owner_user_id, usage_id, session_id, capability_id,
       request_text, request_fingerprint, product_kind, capability_protocol,
       release_id, package_digest, release_scope,
       knowledge_resource_path, knowledge_resource_digest,
       billing_policy_version, validator_policy_version,
       unit_price_cents, free_limit_snapshot, active_recharge_intent_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'knowledge_agent_test', $7,
       $8, $9, $10, $11, $12, $13, $14, $15, $16, $2
     )`,
    [
      fixture.ownerUserId,
      usageId,
      fixture.sessionId,
      fixture.capabilityId,
      requestText,
      createHash('sha256').update(`sibling:${usageId}:${requestText}`).digest('hex'),
      CAPABILITY_PROTOCOL,
      fixture.releaseId,
      fixture.packageDigest,
      RELEASE_SCOPE,
      RESOURCE_PATH,
      fixture.resourceDigest,
      BILLING_POLICY,
      VALIDATOR_POLICY,
      UNIT_PRICE_CENTS,
      FREE_LIMIT,
    ],
  );
  return usageId;
}

async function reserveWalletUsage(
  client: Client,
  fixture: PendingFixture,
): Promise<{ chargeId: string; turnId: string }> {
  const fundingOrderId = (
    await client.query<{ id: string }>(
      `INSERT INTO recharge_orders (
         order_no, owner_user_id, client_idempotency_key, package_id, amount_cents,
         payment_method, pay_type, gateway_environment, institution_no, merchant_no,
         pay_trace_no, pay_time, payment_status, credit_status,
         platform_trade_no, paid_at, credited_at
       ) VALUES (
         $1, $2, $3, 'manual', $4, 'qr', 'alipay', 'test', 'institution', 'merchant',
         $5, '20260901120000', 'succeeded', 'credited', $6, now(), now()
       ) RETURNING id`,
      [
        `CBR${randomUUID().replaceAll('-', '')}`,
        fixture.ownerUserId,
        randomUUID(),
        UNIT_PRICE_CENTS,
        `CB${randomUUID().replaceAll('-', '')}`,
        `trade-${randomUUID()}`,
      ],
    )
  ).rows[0]!.id;
  await client.query(
    `INSERT INTO billing_accounts (owner_user_id, balance_cents)
     VALUES ($1, $2)`,
    [fixture.ownerUserId, UNIT_PRICE_CENTS],
  );
  await client.query(
    `INSERT INTO wallet_ledger (
       owner_user_id, entry_type, amount_cents, recharge_order_id
     ) VALUES ($1, 'recharge_credit', $2, $3)`,
    [fixture.ownerUserId, UNIT_PRICE_CENTS, fundingOrderId],
  );
  const turnId = randomUUID();
  await client.query(`INSERT INTO turns (id, session_id, status) VALUES ($1, $2, 'running')`, [
    turnId,
    fixture.sessionId,
  ]);
  await client.query(
    `UPDATE billing_accounts
        SET balance_cents = balance_cents - $2,
            reserved_cents = reserved_cents + $2,
            updated_at = now()
      WHERE owner_user_id = $1`,
    [fixture.ownerUserId, UNIT_PRICE_CENTS],
  );
  const chargeId = (
    await client.query<{ id: string }>(
      `INSERT INTO usage_charges (
         owner_user_id, usage_id, capability_id, session_id, turn_id,
         request_fingerprint, charge_source, status, unit_price_cents,
         free_limit_snapshot, reserved_cents, settled_cents,
         product_kind, capability_protocol, release_id, package_digest, release_scope,
         knowledge_resource_path, knowledge_resource_digest,
         billing_policy_version, validator_policy_version
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'wallet', 'reserved', $7, $8, $7, 0,
         'knowledge_agent_test', $9, $10, $11, $12, $13, $14, $15, $16
       ) RETURNING id`,
      [
        fixture.ownerUserId,
        fixture.usageId,
        fixture.capabilityId,
        fixture.sessionId,
        turnId,
        fixture.requestFingerprint,
        UNIT_PRICE_CENTS,
        FREE_LIMIT,
        CAPABILITY_PROTOCOL,
        fixture.releaseId,
        fixture.packageDigest,
        RELEASE_SCOPE,
        RESOURCE_PATH,
        fixture.resourceDigest,
        BILLING_POLICY,
        VALIDATOR_POLICY,
      ],
    )
  ).rows[0]!.id;
  return { chargeId, turnId };
}

async function finishWalletUsage(
  client: Client,
  fixture: PendingFixture,
  chargeId: string,
  turnId: string,
  outcome: TerminalOutcome,
): Promise<void> {
  const answered = outcome === 'answered';
  const responseBearing = answered || outcome === 'insufficient_evidence';
  const turnStatus =
    outcome === 'answered' || outcome === 'insufficient_evidence' ? 'completed' : outcome;
  const chargeStatus = answered ? 'completed' : 'released';
  const settledCents = answered ? UNIT_PRICE_CENTS : 0;
  const validationCode = answered
    ? 'accepted'
    : outcome === 'insufficient_evidence'
      ? 'insufficient_evidence'
      : 'not_run';
  const responseText = outcome === 'insufficient_evidence' ? INSUFFICIENT_TEXT : ANSWER_TEXT;
  let responseMessageId: string | null = null;

  // Match Runtime's established lock order before closing Turn, charge, receipt, and recovery.
  await client.query('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE', [fixture.sessionId]);
  if (responseBearing) {
    responseMessageId = (
      await client.query<{ id: string }>(
        `INSERT INTO messages (session_id, turn_id, idx, seq, role, content, status)
         VALUES ($1, $2, 1, NULL, 'assistant', $3::jsonb, 'completed')
         RETURNING id`,
        [fixture.sessionId, turnId, JSON.stringify([{ type: 'text', text: responseText }])],
      )
    ).rows[0]!.id;
  }
  await client.query(
    `UPDATE turns
        SET status = $2, finished_at = now()
      WHERE id = $1 AND session_id = $3`,
    [turnId, turnStatus, fixture.sessionId],
  );
  if (answered) {
    await client.query(
      `UPDATE billing_accounts
          SET reserved_cents = reserved_cents - $2, updated_at = now()
        WHERE owner_user_id = $1`,
      [fixture.ownerUserId, UNIT_PRICE_CENTS],
    );
    await client.query(
      `INSERT INTO wallet_ledger (
         owner_user_id, entry_type, amount_cents, usage_charge_id
       ) VALUES ($1, 'usage_debit', $2, $3)`,
      [fixture.ownerUserId, -UNIT_PRICE_CENTS, chargeId],
    );
  } else {
    await client.query(
      `UPDATE billing_accounts
          SET balance_cents = balance_cents + $2,
              reserved_cents = reserved_cents - $2,
              updated_at = now()
        WHERE owner_user_id = $1`,
      [fixture.ownerUserId, UNIT_PRICE_CENTS],
    );
  }
  await client.query(
    `UPDATE usage_charges
        SET status = $2, settled_cents = $3, execution_outcome = $4,
            updated_at = now(), finished_at = now()
      WHERE id = $1`,
    [chargeId, chargeStatus, settledCents, outcome],
  );
  await client.query(
    `INSERT INTO agent_usage_receipts (
       protocol, usage_charge_id, owner_user_id, usage_id, capability_id, session_id, turn_id,
       product_kind, capability_protocol, release_id, package_digest, release_scope,
       knowledge_resource_path, knowledge_resource_digest,
       billing_policy_version, validator_policy_version,
       unit_price_cents, free_limit_snapshot, charge_source, settled_cents,
       execution_outcome, validation_code, response_message_id, response_digest,
       citation_chunk_ids, execution_environment, runtime_release_id, runtime_source_sha
     )
     SELECT
       $2, id, owner_user_id, usage_id, capability_id, session_id, turn_id,
       product_kind, capability_protocol, release_id, package_digest, release_scope,
       knowledge_resource_path, knowledge_resource_digest,
       billing_policy_version, validator_policy_version,
       unit_price_cents, free_limit_snapshot, charge_source, settled_cents,
       execution_outcome, $3, $4::uuid, $5, $6::text[], 'test', $7, $8
       FROM usage_charges
      WHERE id = $1`,
    [
      chargeId,
      RECEIPT_PROTOCOL,
      validationCode,
      responseMessageId,
      responseBearing ? `sha256:${createHash('sha256').update(responseText).digest('hex')}` : null,
      answered ? [CITATION_ID] : [],
      RUNTIME_RELEASE_ID,
      RUNTIME_SOURCE_SHA,
    ],
  );
}

pgDescribe('pending usage recovery on PostgreSQL 16', () => {
  const owner = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await owner.connect();
    const version = await owner.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    expect(version.rows[0]?.version).toMatch(/^16[.]/);
    const migration = await owner.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1',
    );
    expect(migration.rows[0]?.filename).toBe('0020_private_agent_drafts.sql');
  });

  afterAll(async () => {
    await owner.end();
  });

  it('freezes the initial intent and exact request, Session, Package, policy, and price snapshot', async () => {
    await owner.query('BEGIN');
    try {
      const fixture = await seedPending(owner);
      const row = (
        await owner.query<{
          request_text: string;
          active_recharge_intent_id: string;
          recovery_status: string;
          unit_price_cents: string;
          free_limit_snapshot: number;
        }>(
          `SELECT request_text, active_recharge_intent_id, recovery_status,
                  unit_price_cents, free_limit_snapshot
             FROM pending_usage_recoveries
            WHERE owner_user_id = $1 AND usage_id = $2`,
          [fixture.ownerUserId, fixture.usageId],
        )
      ).rows[0];
      expect(row).toEqual({
        request_text: fixture.requestText,
        active_recharge_intent_id: fixture.usageId,
        recovery_status: 'active',
        unit_price_cents: UNIT_PRICE_CENTS.toString(),
        free_limit_snapshot: FREE_LIMIT,
      });
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `UPDATE pending_usage_recoveries
                SET package_digest = $3, updated_at = now()
              WHERE owner_user_id = $1 AND usage_id = $2`,
            [fixture.ownerUserId, fixture.usageId, digest('replacement')],
          ),
        '55000',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `UPDATE pending_usage_recoveries
                SET request_text = 'changed while active', updated_at = now()
              WHERE owner_user_id = $1 AND usage_id = $2`,
            [fixture.ownerUserId, fixture.usageId],
          ),
        '55000',
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('allows only one active recovery per Session and releases the slot after cancellation', async () => {
    await owner.query('BEGIN');
    try {
      const fixture = await seedPending(owner);
      await expectDatabaseError(
        owner,
        () => insertSiblingPending(owner, fixture),
        '23505',
        'uq_pending_usage_recoveries_session_active',
      );
      await owner.query(
        `UPDATE pending_usage_recoveries
            SET recovery_status = 'abandoned', request_text = NULL,
                abandoned_at = now(), updated_at = now()
          WHERE owner_user_id = $1 AND usage_id = $2`,
        [fixture.ownerUserId, fixture.usageId],
      );
      await owner.query('SET CONSTRAINTS ALL IMMEDIATE');
      await owner.query('SET CONSTRAINTS ALL DEFERRED');
      const replacementUsageId = await insertSiblingPending(owner, fixture);
      expect(
        (
          await owner.query<{ usage_id: string; recovery_status: string }>(
            `SELECT usage_id, recovery_status
               FROM pending_usage_recoveries
              WHERE session_id = $1 AND recovery_status = 'active'`,
            [fixture.sessionId],
          )
        ).rows,
      ).toEqual([{ usage_id: replacementUsageId, recovery_status: 'active' }]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('accepts only the final answered wallet receipt, clears text atomically, and cannot revive', async () => {
    await owner.query('BEGIN');
    try {
      const fixture = await seedPending(owner);
      const { chargeId, turnId } = await reserveWalletUsage(owner, fixture);
      await expectDatabaseError(
        owner,
        async () => {
          await owner.query(
            `UPDATE pending_usage_recoveries
                SET recovery_status = 'accepted', request_text = NULL,
                    terminal_turn_id = $3, accepted_at = now(), updated_at = now()
              WHERE owner_user_id = $1 AND usage_id = $2`,
            [fixture.ownerUserId, fixture.usageId, turnId],
          );
          await owner.query('SET CONSTRAINTS ALL IMMEDIATE');
        },
        '23514',
      );
      await owner.query('SET CONSTRAINTS ALL DEFERRED');
      await finishWalletUsage(owner, fixture, chargeId, turnId, 'answered');
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `UPDATE pending_usage_recoveries
                SET recovery_status = 'accepted', terminal_turn_id = $3,
                    accepted_at = now(), updated_at = now()
              WHERE owner_user_id = $1 AND usage_id = $2`,
            [fixture.ownerUserId, fixture.usageId, turnId],
          ),
        '23514',
        'ck_pending_usage_recovery_state',
      );
      await owner.query(
        `UPDATE pending_usage_recoveries
            SET recovery_status = 'accepted', request_text = NULL,
                terminal_turn_id = $3, accepted_at = now(), updated_at = now()
          WHERE owner_user_id = $1 AND usage_id = $2`,
        [fixture.ownerUserId, fixture.usageId, turnId],
      );
      await owner.query('SET CONSTRAINTS ALL IMMEDIATE');
      expect(
        (
          await owner.query<{ request_text: string | null; recovery_status: string }>(
            `SELECT request_text, recovery_status
               FROM pending_usage_recoveries
              WHERE owner_user_id = $1 AND usage_id = $2`,
            [fixture.ownerUserId, fixture.usageId],
          )
        ).rows[0],
      ).toEqual({ request_text: null, recovery_status: 'accepted' });
      const nextUsageId = await insertSiblingPending(owner, fixture);
      expect(nextUsageId).not.toBe(fixture.usageId);
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `UPDATE pending_usage_recoveries
                SET recovery_status = 'active', request_text = $3,
                    terminal_turn_id = NULL, accepted_at = NULL, updated_at = now()
              WHERE owner_user_id = $1 AND usage_id = $2`,
            [fixture.ownerUserId, fixture.usageId, fixture.requestText],
          ),
        '55000',
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it.each<TerminalOutcome>(['insufficient_evidence', 'failed', 'interrupted'])(
    'abandons an admitted %s retry only with its exact released receipt',
    async (outcome) => {
      await owner.query('BEGIN');
      try {
        const fixture = await seedPending(owner);
        const { chargeId, turnId } = await reserveWalletUsage(owner, fixture);
        await finishWalletUsage(owner, fixture, chargeId, turnId, outcome);
        await expectDatabaseError(
          owner,
          async () => {
            await owner.query(
              `UPDATE pending_usage_recoveries
                  SET recovery_status = 'abandoned', request_text = NULL,
                      abandoned_at = now(), updated_at = now()
                WHERE owner_user_id = $1 AND usage_id = $2`,
              [fixture.ownerUserId, fixture.usageId],
            );
            await owner.query('SET CONSTRAINTS ALL IMMEDIATE');
          },
          '23514',
        );
        await owner.query('SET CONSTRAINTS ALL DEFERRED');
        await owner.query(
          `UPDATE pending_usage_recoveries
              SET recovery_status = 'abandoned', request_text = NULL,
                  terminal_turn_id = $3, abandoned_at = now(), updated_at = now()
            WHERE owner_user_id = $1 AND usage_id = $2`,
          [fixture.ownerUserId, fixture.usageId, turnId],
        );
        await owner.query('SET CONSTRAINTS ALL IMMEDIATE');
        expect(
          (
            await owner.query<{
              request_text: string | null;
              recovery_status: string;
              terminal_turn_id: string;
            }>(
              `SELECT request_text, recovery_status, terminal_turn_id
                 FROM pending_usage_recoveries
                WHERE owner_user_id = $1 AND usage_id = $2`,
              [fixture.ownerUserId, fixture.usageId],
            )
          ).rows[0],
        ).toEqual({
          request_text: null,
          recovery_status: 'abandoned',
          terminal_turn_id: turnId,
        });
      } finally {
        await owner.query('ROLLBACK');
      }
    },
  );

  it('rejects expired intent replacement, permits unadmitted text clearing, and freezes order binding', async () => {
    await owner.query('BEGIN');
    try {
      const cancelled = await seedPending(owner);
      await owner.query(
        `UPDATE pending_usage_recoveries
            SET recovery_status = 'abandoned', request_text = NULL,
                abandoned_at = now(), updated_at = now()
          WHERE owner_user_id = $1 AND usage_id = $2`,
        [cancelled.ownerUserId, cancelled.usageId],
      );
      await owner.query('SET CONSTRAINTS ALL IMMEDIATE');
      await owner.query('SET CONSTRAINTS ALL DEFERRED');

      const fixture = await seedPending(owner, {
        createdAt: '2026-08-29T00:00:00.000Z',
        expiresAt: '2026-08-30T00:00:00.000Z',
      });
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `UPDATE pending_usage_recoveries
                SET active_recharge_intent_id = $3, updated_at = now()
              WHERE owner_user_id = $1 AND usage_id = $2`,
            [fixture.ownerUserId, fixture.usageId, randomUUID()],
          ),
        '23514',
      );
      await owner.query(
        `UPDATE pending_usage_recoveries
            SET recovery_status = 'abandoned', request_text = NULL,
                abandoned_at = now(), updated_at = now()
          WHERE owner_user_id = $1 AND usage_id = $2`,
        [fixture.ownerUserId, fixture.usageId],
      );
      expect(
        (
          await owner.query<{ request_text: string | null; recovery_status: string }>(
            `SELECT request_text, recovery_status
               FROM pending_usage_recoveries
              WHERE owner_user_id = $1 AND usage_id = $2`,
            [fixture.ownerUserId, fixture.usageId],
          )
        ).rows[0],
      ).toEqual({ request_text: null, recovery_status: 'abandoned' });

      const orderFixture = await seedPending(owner);
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `INSERT INTO recharge_orders (
               order_no, owner_user_id, client_idempotency_key, package_id, amount_cents,
               payment_method, pay_type, gateway_environment, institution_no, merchant_no,
               pay_trace_no, pay_time, recovery_usage_id
             ) VALUES (
               $1, $2, $3, 'manual', $4, 'qr', 'alipay', 'test', 'institution', 'merchant',
               $5, '20260901120000', $6
             )`,
            [
              `CBR${randomUUID().replaceAll('-', '')}`,
              orderFixture.ownerUserId,
              orderFixture.usageId,
              UNIT_PRICE_CENTS + 99,
              `CB${randomUUID().replaceAll('-', '')}`,
              orderFixture.usageId,
            ],
          ),
        '23514',
      );
      const orderId = (
        await owner.query<{ id: string }>(
          `INSERT INTO recharge_orders (
             order_no, owner_user_id, client_idempotency_key, package_id, amount_cents,
             payment_method, pay_type, gateway_environment, institution_no, merchant_no,
             pay_trace_no, pay_time, recovery_usage_id
           ) VALUES (
             $1, $2, $3, 'manual', 1, 'qr', 'alipay', 'test', 'institution', 'merchant',
             $4, '20260901120000', $5
           ) RETURNING id`,
          [
            `CBR${randomUUID().replaceAll('-', '')}`,
            orderFixture.ownerUserId,
            orderFixture.usageId,
            `CB${randomUUID().replaceAll('-', '')}`,
            orderFixture.usageId,
          ],
        )
      ).rows[0]!.id;
      await expectDatabaseError(
        owner,
        () =>
          owner.query(`UPDATE recharge_orders SET recovery_usage_id = NULL WHERE id = $1`, [
            orderId,
          ]),
        '55000',
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
