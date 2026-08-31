import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const databaseUrl = process.env.DATABASE_URL;
const runtimePassword = process.env.POSTGRES_RUNTIME_PASSWORD;
const enabled =
  process.env.AGENT_SESSION_RECEIPTS_PG_TEST === '1' &&
  Boolean(databaseUrl) &&
  Boolean(runtimePassword);
const pgDescribe = enabled ? describe : describe.skip;
const CAPABILITY_PROTOCOL = 'combo.agent-package-capability/2';
const PACKAGE_PROTOCOL = 'combo.agent-package/1';
const RELEASE_PROTOCOL = 'combo.agent-package-release/1';
const RECEIPT_PROTOCOL = 'combo.agent-usage-receipt/1';
const RELEASE_SCOPE = 'controlled_test';
const RESOURCE_PATH = 'skills/knowledge/references/knowledge-bundle.json';
const BILLING_POLICY = 'knowledge-billing-v1';
const VALIDATOR_POLICY = 'knowledge-citations-v1';
const RUNTIME_SOURCE_SHA = '1'.repeat(40);
const RUNTIME_RELEASE_ID = `release-${RUNTIME_SOURCE_SHA}`;
const CITATION_ID = `chunk.knowledge.${'2'.repeat(32)}`;
const ANSWER_TEXT = 'Combo 使用 exact Agent Package 作为唯一运行真相。';
const INSUFFICIENT_TEXT = '当前 Knowledge Bundle 没有足够证据回答这个问题。';
const ANSWER_DIGEST = responseDigest(ANSWER_TEXT);
const INSUFFICIENT_DIGEST = responseDigest(INSUFFICIENT_TEXT);
type Outcome = 'answered' | 'insufficient_evidence' | 'failed' | 'interrupted';
interface Fixture {
  ownerUserId: string;
  capabilityId: string;
  sessionId: string;
  turnId: string;
  chargeId: string;
  usageId: string;
  releaseId: string;
  packageDigest: string;
  resourceDigest: string;
  responseMessageId?: string;
}
interface DatabaseError {
  code?: string;
  constraint?: string;
}
let savepointSequence = 0;
function runtimeConnectionString(): string {
  const url = new URL(databaseUrl!);
  url.username = 'combo_runtime';
  url.password = runtimePassword!;
  return url.toString();
}
function responseDigest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
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
async function expectDatabaseError(
  client: Client,
  operation: () => Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  const savepoint = `knowledge_response_expect_${(savepointSequence += 1)}`;
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
async function seedKnowledgeUsage(owner: Client): Promise<Fixture> {
  const packageDigest = digest('response-package');
  const resourceDigest = digest('response-resource');
  const releaseId = `release.agent-package.${randomUUID().replaceAll('-', '')}`;
  const turnId = randomUUID();
  const usageId = randomUUID();
  await owner.query('BEGIN');
  try {
    const publisherUserId = (
      await owner.query<{ id: string }>('INSERT INTO users (account) VALUES ($1) RETURNING id', [
        creatorAccount(),
      ])
    ).rows[0]!.id;
    const ownerUserId = (
      await owner.query<{ id: string }>('INSERT INTO users (account) VALUES ($1) RETURNING id', [
        creatorAccount(),
      ])
    ).rows[0]!.id;
    const taskId = (
      await owner.query<{ id: string }>(
        'INSERT INTO tasks (owner_user_id, idempotency_key) VALUES ($1, $2) RETURNING id',
        [publisherUserId, `response-task-${randomUUID()}`],
      )
    ).rows[0]!.id;
    const capabilityId = (
      await owner.query<{ id: string }>(
        `INSERT INTO capabilities (task_id, owner_user_id, name, kind, storage_key, published)
         VALUES ($1, $2, 'Knowledge response', 'knowledge', $3, true)
         RETURNING id`,
        [taskId, publisherUserId, `knowledge-response/${randomUUID()}`],
      )
    ).rows[0]!.id;
    await owner.query(
      `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
       VALUES ($1, $2, $3)`,
      [packageDigest, PACKAGE_PROTOCOL, publisherUserId],
    );
    await owner.query(
      `INSERT INTO agent_package_releases (
         release_id, package_digest, owner_user_id, protocol, release_scope,
         idempotency_key, request_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        releaseId,
        packageDigest,
        publisherUserId,
        RELEASE_PROTOCOL,
        RELEASE_SCOPE,
        randomUUID(),
        createHash('sha256').update(randomUUID()).digest('hex'),
      ],
    );
    await owner.query('INSERT INTO billing_accounts (owner_user_id) VALUES ($1)', [ownerUserId]);
    await owner.query(
      `INSERT INTO billing_free_allowances (
         owner_user_id, capability_id, policy_version, free_limit_snapshot,
         free_used_count, free_reserved_count
       ) VALUES ($1, $2, $3, 3, 0, 1)`,
      [ownerUserId, capabilityId, BILLING_POLICY],
    );
    const sessionId = (
      await owner.query<{ id: string }>(
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
          releaseId,
          packageDigest,
          RELEASE_SCOPE,
          RESOURCE_PATH,
          resourceDigest,
        ],
      )
    ).rows[0]!.id;
    await owner.query(`INSERT INTO turns (id, session_id, status) VALUES ($1, $2, 'running')`, [
      turnId,
      sessionId,
    ]);
    const chargeId = (
      await owner.query<{ id: string }>(
        `INSERT INTO usage_charges (
           owner_user_id, usage_id, capability_id, session_id, turn_id,
           request_fingerprint, charge_source, status, unit_price_cents,
           free_limit_snapshot, reserved_cents, settled_cents,
           product_kind, capability_protocol, release_id, package_digest, release_scope,
           knowledge_resource_path, knowledge_resource_digest,
           billing_policy_version, validator_policy_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'free', 'reserved', 1, 3, 0, 0,
           'knowledge_agent_test', $7, $8, $9, $10, $11, $12, $13, $14
         ) RETURNING id`,
        [
          ownerUserId,
          usageId,
          capabilityId,
          sessionId,
          turnId,
          createHash('sha256').update(randomUUID()).digest('hex'),
          CAPABILITY_PROTOCOL,
          releaseId,
          packageDigest,
          RELEASE_SCOPE,
          RESOURCE_PATH,
          resourceDigest,
          BILLING_POLICY,
          VALIDATOR_POLICY,
        ],
      )
    ).rows[0]!.id;
    await owner.query('COMMIT');
    return {
      ownerUserId,
      capabilityId,
      sessionId,
      turnId,
      chargeId,
      usageId,
      releaseId,
      packageDigest,
      resourceDigest,
    };
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

function terminalShape(outcome: Outcome): {
  turnStatus: 'completed' | 'failed' | 'interrupted';
  chargeStatus: 'completed' | 'released';
  validationCode: string;
  responseDigest: string | null;
  citations: string[];
} {
  if (outcome === 'answered') {
    return {
      turnStatus: 'completed',
      chargeStatus: 'completed',
      validationCode: 'accepted',
      responseDigest: ANSWER_DIGEST,
      citations: [CITATION_ID],
    };
  }
  if (outcome === 'insufficient_evidence') {
    return {
      turnStatus: 'completed',
      chargeStatus: 'released',
      validationCode: 'insufficient_evidence',
      responseDigest: INSUFFICIENT_DIGEST,
      citations: [],
    };
  }
  return {
    turnStatus: outcome,
    chargeStatus: 'released',
    validationCode: 'not_run',
    responseDigest: null,
    citations: [],
  };
}

async function setTerminalState(client: Client, fixture: Fixture, outcome: Outcome): Promise<void> {
  const shape = terminalShape(outcome);
  await client.query('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE', [fixture.sessionId]);
  await client.query(
    `UPDATE turns SET status = $2, finished_at = now()
      WHERE id = $1 AND session_id = $3`,
    [fixture.turnId, shape.turnStatus, fixture.sessionId],
  );
  await client.query(
    `UPDATE billing_free_allowances
        SET free_used_count = free_used_count + $3,
            free_reserved_count = free_reserved_count - 1,
            updated_at = now()
      WHERE owner_user_id = $1 AND capability_id = $2`,
    [fixture.ownerUserId, fixture.capabilityId, outcome === 'answered' ? 1 : 0],
  );
  await client.query(
    `UPDATE usage_charges
        SET status = $2, settled_cents = 0, execution_outcome = $3,
            updated_at = now(), finished_at = now()
      WHERE id = $1`,
    [fixture.chargeId, shape.chargeStatus, outcome],
  );
}

async function insertMessage(
  client: Client,
  fixture: Pick<Fixture, 'sessionId' | 'turnId'>,
  options: {
    role?: 'user' | 'assistant' | 'tool';
    status?: 'completed' | 'failed';
    text?: string;
    sessionId?: string;
    turnId?: string;
  } = {},
): Promise<string> {
  const sessionId = options.sessionId ?? fixture.sessionId;
  const turnId = options.turnId ?? fixture.turnId;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO messages (session_id, turn_id, idx, seq, role, content, status)
     SELECT $1, $2, COALESCE(MAX(idx), 0) + 1, NULL, $3, $4::jsonb, $5
       FROM messages
      WHERE turn_id = $2
     RETURNING id`,
    [
      sessionId,
      turnId,
      options.role ?? 'assistant',
      JSON.stringify([{ type: 'text', text: options.text ?? ANSWER_TEXT }]),
      options.status ?? 'completed',
    ],
  );
  return inserted.rows[0]!.id;
}

async function insertLegacyResponse(
  client: Client,
  fixture: Fixture,
): Promise<{
  sessionId: string;
  turnId: string;
  messageId: string;
}> {
  const sessionId = (
    await client.query<{ id: string }>(
      `INSERT INTO sessions (capability_id, owner_user_id)
       VALUES ($1, $2) RETURNING id`,
      [fixture.capabilityId, fixture.ownerUserId],
    )
  ).rows[0]!.id;
  const turnId = randomUUID();
  await client.query(
    `INSERT INTO turns (id, session_id, status, finished_at)
     VALUES ($1, $2, 'completed', now())`,
    [turnId, sessionId],
  );
  const messageId = await insertMessage(client, { sessionId, turnId });
  return { sessionId, turnId, messageId };
}

async function insertReceipt(
  client: Client,
  fixture: Fixture,
  outcome: Outcome,
  options: {
    responseMessageId?: string | null;
    validationCode?: string;
    responseDigest?: string | null;
    citations?: string[];
  } = {},
): Promise<string> {
  const shape = terminalShape(outcome);
  const inserted = await client.query<{ id: string }>(
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
     WHERE id = $1
     RETURNING id`,
    [
      fixture.chargeId,
      RECEIPT_PROTOCOL,
      options.validationCode ?? shape.validationCode,
      options.responseMessageId === undefined
        ? (fixture.responseMessageId ?? null)
        : options.responseMessageId,
      options.responseDigest === undefined ? shape.responseDigest : options.responseDigest,
      options.citations ?? shape.citations,
      RUNTIME_RELEASE_ID,
      RUNTIME_SOURCE_SHA,
    ],
  );
  return inserted.rows[0]!.id;
}

async function insertMismatchedScopeReceipt(
  client: Client,
  fixture: Fixture,
  legacy: { sessionId: string; turnId: string; messageId: string },
): Promise<void> {
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
       $2, id, owner_user_id, usage_id, capability_id, $3::uuid, $4::uuid,
       product_kind, capability_protocol, release_id, package_digest, release_scope,
       knowledge_resource_path, knowledge_resource_digest,
       billing_policy_version, validator_policy_version,
       unit_price_cents, free_limit_snapshot, charge_source, settled_cents,
       execution_outcome, 'accepted', $5::uuid, $6, $7::text[], 'test', $8, $9
     FROM usage_charges
     WHERE id = $1`,
    [
      fixture.chargeId,
      RECEIPT_PROTOCOL,
      legacy.sessionId,
      legacy.turnId,
      legacy.messageId,
      ANSWER_DIGEST,
      [CITATION_ID],
      RUNTIME_RELEASE_ID,
      RUNTIME_SOURCE_SHA,
    ],
  );
}

async function insertFrozenReceipt(client: Client, fixture: Fixture): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO agent_usage_receipts (
       protocol, usage_charge_id, owner_user_id, usage_id, capability_id, session_id, turn_id,
       product_kind, capability_protocol, release_id, package_digest, release_scope,
       knowledge_resource_path, knowledge_resource_digest,
       billing_policy_version, validator_policy_version,
       unit_price_cents, free_limit_snapshot, charge_source, settled_cents,
       execution_outcome, validation_code, response_message_id, response_digest,
       citation_chunk_ids, execution_environment, runtime_release_id, runtime_source_sha
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       'knowledge_agent_test', $8, $9, $10, 'controlled_test', $11, $12,
       $13, $14, 1, 3, 'free', 0,
       'answered', 'accepted', $15, $16, $17, 'test', $18, $19
     ) RETURNING id`,
    [
      RECEIPT_PROTOCOL,
      fixture.chargeId,
      fixture.ownerUserId,
      fixture.usageId,
      fixture.capabilityId,
      fixture.sessionId,
      fixture.turnId,
      CAPABILITY_PROTOCOL,
      fixture.releaseId,
      fixture.packageDigest,
      RESOURCE_PATH,
      fixture.resourceDigest,
      BILLING_POLICY,
      VALIDATOR_POLICY,
      fixture.responseMessageId,
      ANSWER_DIGEST,
      [CITATION_ID],
      RUNTIME_RELEASE_ID,
      RUNTIME_SOURCE_SHA,
    ],
  );
  return inserted.rows[0]!.id;
}

pgDescribe('knowledge receipt authoritative response Message on PostgreSQL 16', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const runtime = new Client({
    connectionString: enabled ? runtimeConnectionString() : undefined,
  });
  beforeAll(async () => {
    await owner.connect();
    await runtime.connect();
    expect(
      (
        await owner.query<{ version: string }>(
          "SELECT current_setting('server_version') AS version",
        )
      ).rows[0]?.version,
    ).toMatch(/^16[.]/);
  });
  afterAll(async () => {
    await Promise.all([owner.end(), runtime.end()]);
  });
  it('has an exact response scope FK and indexed receipt lookup for Message immutability', async () => {
    const constraint = await owner.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'fk_agent_usage_receipt_response_scope'`,
    );
    expect(constraint.rows[0]?.definition).toContain(
      'FOREIGN KEY (response_message_id, session_id, turn_id) REFERENCES messages(id, session_id, turn_id)',
    );
    const index = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_agent_usage_receipts_response_message'`,
    );
    expect(index.rows[0]?.indexdef).toContain('USING btree (response_message_id)');
    expect(index.rows[0]?.indexdef).toContain('WHERE (response_message_id IS NOT NULL)');
  });
  it('rejects answered receipts with no bound response Message', async () => {
    const missingId = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    try {
      await setTerminalState(runtime, missingId, 'answered');
      await expectDatabaseError(
        runtime,
        () => insertReceipt(runtime, missingId, 'answered', { responseMessageId: null }),
        '23514',
        'ck_agent_usage_receipt_outcome',
      );
      await insertReceipt(runtime, missingId, 'answered', {
        responseMessageId: randomUUID(),
      });
      await expect(
        runtime.query('SET CONSTRAINTS fk_agent_usage_receipt_response_scope IMMEDIATE'),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_agent_usage_receipt_response_scope',
      });
    } finally {
      await runtime.query('ROLLBACK');
    }
  });
  it('rejects a response with the wrong role, status, or Turn', async () => {
    for (const options of [
      { role: 'user' as const, status: 'completed' as const },
      { role: 'assistant' as const, status: 'failed' as const },
    ]) {
      const fixture = await seedKnowledgeUsage(owner);
      await runtime.query('BEGIN');
      try {
        await setTerminalState(runtime, fixture, 'answered');
        fixture.responseMessageId = await insertMessage(runtime, fixture, options);
        await insertReceipt(runtime, fixture, 'answered');
        await expect(runtime.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
          code: '23514',
        });
      } finally {
        await runtime.query('ROLLBACK');
      }
    }
    const wrongTurn = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    try {
      await setTerminalState(runtime, wrongTurn, 'answered');
      const legacy = await insertLegacyResponse(runtime, wrongTurn);
      await insertReceipt(runtime, wrongTurn, 'answered', {
        responseMessageId: legacy.messageId,
      });
      await expect(
        runtime.query('SET CONSTRAINTS fk_agent_usage_receipt_response_scope IMMEDIATE'),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_agent_usage_receipt_response_scope',
      });
    } finally {
      await runtime.query('ROLLBACK');
    }
  });
  it('rejects multiple completed assistant responses for one knowledge Turn', async () => {
    const fixture = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    try {
      await setTerminalState(runtime, fixture, 'answered');
      fixture.responseMessageId = await insertMessage(runtime, fixture);
      await insertMessage(runtime, fixture, { text: '第二条会造成展示歧义的回答。' });
      await insertReceipt(runtime, fixture, 'answered');
      await expect(runtime.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
        code: '23514',
      });
    } finally {
      await runtime.query('ROLLBACK');
    }
  });
  it('keeps insufficient, failed, and interrupted response contracts unambiguous', async () => {
    const insufficient = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    try {
      await setTerminalState(runtime, insufficient, 'insufficient_evidence');
      insufficient.responseMessageId = await insertMessage(runtime, insufficient, {
        text: INSUFFICIENT_TEXT,
      });
      await expectDatabaseError(
        runtime,
        () =>
          insertReceipt(runtime, insufficient, 'insufficient_evidence', {
            citations: [CITATION_ID],
          }),
        '23514',
        'ck_agent_usage_receipt_outcome',
      );
    } finally {
      await runtime.query('ROLLBACK');
    }
    const failed = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    try {
      await setTerminalState(runtime, failed, 'failed');
      const failedMessageId = await insertMessage(runtime, failed, { status: 'failed' });
      await expectDatabaseError(
        runtime,
        () => insertReceipt(runtime, failed, 'failed', { responseMessageId: failedMessageId }),
        '23514',
        'ck_agent_usage_receipt_outcome',
      );
    } finally {
      await runtime.query('ROLLBACK');
    }
    const interrupted = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    try {
      await setTerminalState(runtime, interrupted, 'interrupted');
      await expectDatabaseError(
        runtime,
        () =>
          insertReceipt(runtime, interrupted, 'interrupted', {
            validationCode: 'rejected',
          }),
        '23514',
        'ck_agent_usage_receipt_outcome',
      );
    } finally {
      await runtime.query('ROLLBACK');
    }
  });
  it('derives receipt scope from usage_charge_id instead of caller-selected Message scope', async () => {
    const fixture = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    try {
      await setTerminalState(runtime, fixture, 'answered');
      const legacy = await insertLegacyResponse(runtime, fixture);
      await insertMismatchedScopeReceipt(runtime, fixture, legacy);
      await expect(runtime.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
        code: '23514',
      });
    } finally {
      await runtime.query('ROLLBACK');
    }
  });
  it('serializes concurrent receipt replay to one committed response-bound row', async () => {
    const peer = new Client({ connectionString: runtimeConnectionString() });
    await peer.connect();
    const fixture = await seedKnowledgeUsage(owner);
    try {
      await runtime.query('BEGIN');
      await setTerminalState(runtime, fixture, 'answered');
      fixture.responseMessageId = await insertMessage(runtime, fixture);
      const receiptId = await insertReceipt(runtime, fixture, 'answered');
      await peer.query('BEGIN');
      const competingInsert = insertFrozenReceipt(peer, fixture);
      const early = await Promise.race([
        competingInsert.then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise<'pending'>((resolvePending) =>
          setTimeout(() => resolvePending('pending'), 100),
        ),
      ]);
      expect(early).toBe('pending');
      await runtime.query('COMMIT');
      await expect(competingInsert).rejects.toMatchObject({ code: '23505' });
      await peer.query('ROLLBACK');
      expect(
        (
          await owner.query<{ id: string; count: string }>(
            `SELECT min(id::text) AS id, count(*)::text AS count
               FROM agent_usage_receipts
              WHERE owner_user_id = $1 AND usage_id = $2`,
            [fixture.ownerUserId, fixture.usageId],
          )
        ).rows[0],
      ).toEqual({ id: receiptId, count: '1' });
    } finally {
      await runtime.query('ROLLBACK').catch(() => undefined);
      await peer.query('ROLLBACK').catch(() => undefined);
      await peer.end();
    }
  });
  it('blocks response, binding, and receipt mutation even for migration-owner DML', async () => {
    const fixture = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    await setTerminalState(runtime, fixture, 'answered');
    fixture.responseMessageId = await insertMessage(runtime, fixture);
    await insertReceipt(runtime, fixture, 'answered');
    await runtime.query('COMMIT');
    await owner.query('BEGIN');
    try {
      for (const operation of [
        () =>
          owner.query('UPDATE messages SET content = $2::jsonb WHERE id = $1', [
            fixture.responseMessageId,
            JSON.stringify([{ type: 'text', text: 'drifted' }]),
          ]),
        () =>
          owner.query(`UPDATE messages SET role = 'user' WHERE id = $1`, [
            fixture.responseMessageId,
          ]),
        () =>
          owner.query(`UPDATE messages SET status = 'failed' WHERE id = $1`, [
            fixture.responseMessageId,
          ]),
        () =>
          owner.query('UPDATE messages SET turn_id = $2 WHERE id = $1', [
            fixture.responseMessageId,
            randomUUID(),
          ]),
        () =>
          owner.query('UPDATE messages SET session_id = $2 WHERE id = $1', [
            fixture.responseMessageId,
            randomUUID(),
          ]),
        () => owner.query('DELETE FROM messages WHERE id = $1', [fixture.responseMessageId]),
        () =>
          owner.query('UPDATE sessions SET knowledge_resource_digest = $2 WHERE id = $1', [
            fixture.sessionId,
            digest('owner-session-drift'),
          ]),
        () =>
          owner.query(`UPDATE usage_charges SET billing_policy_version = 'drifted' WHERE id = $1`, [
            fixture.chargeId,
          ]),
        () =>
          owner.query(
            'UPDATE agent_usage_receipts SET created_at = created_at WHERE usage_charge_id = $1',
            [fixture.chargeId],
          ),
        () =>
          owner.query('DELETE FROM agent_usage_receipts WHERE usage_charge_id = $1', [
            fixture.chargeId,
          ]),
        () => owner.query('TRUNCATE agent_usage_receipts'),
      ]) {
        await expectDatabaseError(owner, operation, '55000');
      }
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
