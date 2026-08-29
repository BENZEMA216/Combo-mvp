import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PASSWORD_KEYS = {
  combo_api: 'POSTGRES_API_PASSWORD',
  combo_worker: 'POSTGRES_WORKER_PASSWORD',
  combo_runtime: 'POSTGRES_RUNTIME_PASSWORD',
} as const;

type ApplicationRole = keyof typeof PASSWORD_KEYS;
type KnowledgeOutcome = 'answered' | 'insufficient_evidence' | 'failed' | 'interrupted';
type ValidationCode =
  | 'accepted'
  | 'insufficient_evidence'
  | 'not_run'
  | 'rejected'
  | 'unavailable'
  | 'protocol_invalid';

const databaseUrl = process.env.DATABASE_URL;
const enabled =
  process.env.AGENT_SESSION_RECEIPTS_PG_TEST === '1' &&
  Boolean(databaseUrl) &&
  Object.values(PASSWORD_KEYS).every((key) => Boolean(process.env[key]));
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
const CITATION_ID_SECOND = `chunk.knowledge.${'3'.repeat(32)}`;
const ANSWER_TEXT = 'Combo 使用 exact Agent Package 作为唯一运行真相。';
const INSUFFICIENT_TEXT = '当前 Knowledge Bundle 没有足够证据回答这个问题。';
const ANSWER_RESPONSE_DIGEST = `sha256:${createHash('sha256').update(ANSWER_TEXT).digest('hex')}`;
const INSUFFICIENT_RESPONSE_DIGEST = `sha256:${createHash('sha256')
  .update(INSUFFICIENT_TEXT)
  .digest('hex')}`;

interface DatabaseError {
  code?: string;
  constraint?: string;
}

interface KnowledgeFixture {
  publisherUserId: string;
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

let savepointSequence = 0;

function roleConnectionString(role: ApplicationRole): string {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = process.env[PASSWORD_KEYS[role]]!;
  return url.toString();
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

function releaseId(): string {
  return `release.agent-package.${randomUUID().replaceAll('-', '')}`;
}

async function expectDatabaseError(
  client: Client,
  operation: () => Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  const savepoint = `knowledge_receipt_expect_${(savepointSequence += 1)}`;
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

async function seedKnowledgeUsage(
  owner: Client,
  options: {
    chargeBillingPolicy?: string | null;
    chargeValidatorPolicy?: string | null;
    chargeResourceDigest?: string | null;
  } = {},
): Promise<KnowledgeFixture> {
  const packageDigest = digest('package');
  const resourceDigest = digest('knowledge-resource');
  const exactReleaseId = releaseId();
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
        `INSERT INTO tasks (owner_user_id, idempotency_key)
         VALUES ($1, $2) RETURNING id`,
        [publisherUserId, `knowledge-task-${randomUUID()}`],
      )
    ).rows[0]!.id;
    const capabilityId = (
      await owner.query<{ id: string }>(
        `INSERT INTO capabilities (task_id, owner_user_id, name, kind, storage_key, published)
         VALUES ($1, $2, 'Controlled Knowledge', 'knowledge', $3, true)
         RETURNING id`,
        [taskId, publisherUserId, `knowledge/${randomUUID()}`],
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
        exactReleaseId,
        packageDigest,
        publisherUserId,
        RELEASE_PROTOCOL,
        RELEASE_SCOPE,
        randomUUID(),
        createHash('sha256').update(randomUUID()).digest('hex'),
      ],
    );
    await owner.query(`INSERT INTO billing_accounts (owner_user_id) VALUES ($1)`, [ownerUserId]);
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
          exactReleaseId,
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
          exactReleaseId,
          packageDigest,
          RELEASE_SCOPE,
          RESOURCE_PATH,
          options.chargeResourceDigest === undefined
            ? resourceDigest
            : options.chargeResourceDigest,
          options.chargeBillingPolicy === undefined ? BILLING_POLICY : options.chargeBillingPolicy,
          options.chargeValidatorPolicy === undefined
            ? VALIDATOR_POLICY
            : options.chargeValidatorPolicy,
        ],
      )
    ).rows[0]!.id;
    await owner.query('COMMIT');
    return {
      publisherUserId,
      ownerUserId,
      capabilityId,
      sessionId,
      turnId,
      chargeId,
      usageId,
      releaseId: exactReleaseId,
      packageDigest,
      resourceDigest,
    };
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

function terminalShape(outcome: KnowledgeOutcome): {
  turnStatus: 'completed' | 'failed' | 'interrupted';
  chargeStatus: 'completed' | 'released';
  validationCode: ValidationCode;
  responseDigest: string | null;
  citations: string[];
} {
  if (outcome === 'answered') {
    return {
      turnStatus: 'completed',
      chargeStatus: 'completed',
      validationCode: 'accepted',
      responseDigest: ANSWER_RESPONSE_DIGEST,
      citations: [CITATION_ID],
    };
  }
  if (outcome === 'insufficient_evidence') {
    return {
      turnStatus: 'completed',
      chargeStatus: 'released',
      validationCode: 'insufficient_evidence',
      responseDigest: INSUFFICIENT_RESPONSE_DIGEST,
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

async function insertTurnMessage(
  client: Client,
  fixture: Pick<KnowledgeFixture, 'sessionId' | 'turnId'>,
  options: {
    role?: 'user' | 'assistant' | 'tool';
    status?: 'completed' | 'failed';
    text?: string;
    sessionId?: string;
    turnId?: string;
  } = {},
): Promise<string> {
  const role = options.role ?? 'assistant';
  const status = options.status ?? 'completed';
  const sessionId = options.sessionId ?? fixture.sessionId;
  const turnId = options.turnId ?? fixture.turnId;
  const text = options.text ?? ANSWER_TEXT;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO messages (session_id, turn_id, idx, seq, role, content, status)
     SELECT $1, $2, COALESCE(MAX(idx), 0) + 1, NULL, $3, $4::jsonb, $5
       FROM messages
      WHERE turn_id = $2
     RETURNING id`,
    [sessionId, turnId, role, JSON.stringify([{ type: 'text', text }]), status],
  );
  return inserted.rows[0]!.id;
}

async function insertReceipt(
  client: Client,
  fixture: Pick<KnowledgeFixture, 'chargeId' | 'usageId' | 'responseMessageId'>,
  outcome: KnowledgeOutcome,
  options: {
    citationIds?: string[];
    usageId?: string;
    validationCode?: ValidationCode;
    responseMessageId?: string | null;
    responseDigest?: string | null;
    executionEnvironment?: string;
    runtimeReleaseId?: string;
    runtimeSourceSha?: string;
  } = {},
): Promise<string> {
  const shape = terminalShape(outcome);
  const receipt = await client.query<{ id: string }>(
    `INSERT INTO agent_usage_receipts (
       protocol, usage_charge_id, owner_user_id, usage_id, capability_id, session_id, turn_id,
       product_kind, capability_protocol, release_id, package_digest, release_scope,
       knowledge_resource_path, knowledge_resource_digest,
       billing_policy_version, validator_policy_version,
       unit_price_cents, free_limit_snapshot, charge_source, settled_cents,
       execution_outcome, validation_code, response_message_id, response_digest,
       citation_chunk_ids,
       execution_environment, runtime_release_id, runtime_source_sha
     )
     SELECT
       $2, id, owner_user_id, $3::uuid, capability_id, session_id, turn_id,
       product_kind, capability_protocol, release_id, package_digest, release_scope,
       knowledge_resource_path, knowledge_resource_digest,
       billing_policy_version, validator_policy_version,
       unit_price_cents, free_limit_snapshot, charge_source, settled_cents,
       execution_outcome, $4, $5::uuid, $6, $7::text[], $8, $9, $10
     FROM usage_charges
     WHERE id = $1
     RETURNING id`,
    [
      fixture.chargeId,
      RECEIPT_PROTOCOL,
      options.usageId ?? fixture.usageId,
      options.validationCode ?? shape.validationCode,
      options.responseMessageId === undefined
        ? outcome === 'answered' || outcome === 'insufficient_evidence'
          ? (fixture.responseMessageId ?? null)
          : null
        : options.responseMessageId,
      options.responseDigest === undefined ? shape.responseDigest : options.responseDigest,
      options.citationIds ?? shape.citations,
      options.executionEnvironment ?? 'test',
      options.runtimeReleaseId ?? RUNTIME_RELEASE_ID,
      options.runtimeSourceSha ?? RUNTIME_SOURCE_SHA,
    ],
  );
  return receipt.rows[0]!.id;
}

async function prepareTerminal(
  client: Client,
  fixture: KnowledgeFixture,
  outcome: KnowledgeOutcome,
  options: {
    insertReceipt?: boolean;
    receiptCitations?: string[];
    validationCode?: ValidationCode;
  } = {},
): Promise<string | null> {
  const shape = terminalShape(outcome);
  // Knowledge terminal writers follow the database lock contract before touching Turn/charge rows.
  await client.query('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE', [fixture.sessionId]);
  if (outcome === 'answered' || outcome === 'insufficient_evidence') {
    fixture.responseMessageId = await insertTurnMessage(client, fixture, {
      text: outcome === 'answered' ? ANSWER_TEXT : INSUFFICIENT_TEXT,
    });
  }
  await client.query(
    `UPDATE turns
        SET status = $2, finished_at = now()
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
  if (options.insertReceipt === false) return null;
  return insertReceipt(client, fixture, outcome, {
    citationIds: options.receiptCitations,
    validationCode: options.validationCode,
  });
}

async function completeTerminal(
  client: Client,
  fixture: KnowledgeFixture,
  outcome: KnowledgeOutcome,
  options: {
    validationCode?: ValidationCode;
  } = {},
): Promise<string> {
  await client.query('BEGIN');
  try {
    const receiptId = await prepareTerminal(client, fixture, outcome, options);
    await client.query('COMMIT');
    return receiptId!;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

pgDescribe('Agent Package Session and usage receipts on PostgreSQL 16', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const clients = new Map<ApplicationRole, Client>();

  beforeAll(async () => {
    await owner.connect();
    const version = await owner.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    expect(version.rows[0]?.version).toMatch(/^16[.]/);
    for (const role of Object.keys(PASSWORD_KEYS) as ApplicationRole[]) {
      const client = new Client({
        connectionString: roleConnectionString(role),
        application_name: `combo-knowledge-receipt-${role}`,
      });
      await client.connect();
      clients.set(role, client);
    }
  });

  afterAll(async () => {
    await Promise.all([owner.end(), ...[...clients.values()].map((client) => client.end())]);
  });

  it('keeps old Session and charge inserts valid as legacy rows after the expand migration', async () => {
    await owner.query('BEGIN');
    try {
      const userId = (
        await owner.query<{ id: string }>('INSERT INTO users (account) VALUES ($1) RETURNING id', [
          creatorAccount(),
        ])
      ).rows[0]!.id;
      const taskId = (
        await owner.query<{ id: string }>(
          'INSERT INTO tasks (owner_user_id, idempotency_key) VALUES ($1, $2) RETURNING id',
          [userId, `legacy-task-${randomUUID()}`],
        )
      ).rows[0]!.id;
      const capabilityId = (
        await owner.query<{ id: string }>(
          `INSERT INTO capabilities (task_id, owner_user_id, name, storage_key)
           VALUES ($1, $2, 'legacy', $3) RETURNING id`,
          [taskId, userId, `legacy/${randomUUID()}`],
        )
      ).rows[0]!.id;
      const sessionId = (
        await owner.query<{ id: string }>(
          `INSERT INTO sessions (capability_id, owner_user_id)
           VALUES ($1, $2) RETURNING id`,
          [capabilityId, userId],
        )
      ).rows[0]!.id;
      const turnId = randomUUID();
      const usageId = randomUUID();
      await owner.query(
        `INSERT INTO turns (id, session_id, status, finished_at)
         VALUES ($1, $2, 'completed', now())`,
        [turnId, sessionId],
      );
      await owner.query('INSERT INTO billing_accounts (owner_user_id) VALUES ($1)', [userId]);
      const chargeId = (
        await owner.query<{ id: string }>(
          `INSERT INTO usage_charges (
           owner_user_id, usage_id, capability_id, session_id, turn_id,
           request_fingerprint, charge_source, status, unit_price_cents,
           free_limit_snapshot, reserved_cents, settled_cents, finished_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'owner', 'completed', 1, 3, 0, 0, now())
         RETURNING id`,
          [
            userId,
            usageId,
            capabilityId,
            sessionId,
            turnId,
            createHash('sha256').update(randomUUID()).digest('hex'),
          ],
        )
      ).rows[0]!.id;
      await owner.query('SET CONSTRAINTS ALL IMMEDIATE');
      const legacy = await owner.query<{
        session_kind: string;
        charge_kind: string;
        session_release: string | null;
        charge_outcome: string | null;
      }>(
        `SELECT s.product_kind AS session_kind, c.product_kind AS charge_kind,
                s.release_id AS session_release, c.execution_outcome AS charge_outcome
           FROM sessions s
           JOIN usage_charges c ON c.session_id = s.id
          WHERE s.id = $1`,
        [sessionId],
      );
      expect(legacy.rows[0]).toEqual({
        session_kind: 'legacy_capability',
        charge_kind: 'legacy_capability',
        session_release: null,
        charge_outcome: null,
      });
      await expectDatabaseError(
        owner,
        () => insertReceipt(owner, { chargeId, usageId }, 'failed'),
        '23514',
      );
      await owner.query('ROLLBACK');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  });

  it('rejects partial, noncanonical, and post-insert Session binding changes', async () => {
    const fixture = await seedKnowledgeUsage(owner);
    await owner.query('BEGIN');
    try {
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `INSERT INTO sessions (capability_id, owner_user_id, product_kind)
             VALUES ($1, $2, 'knowledge_agent_test')`,
            [fixture.capabilityId, fixture.ownerUserId],
          ),
        '23514',
        'ck_sessions_agent_package_binding',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `INSERT INTO sessions (
               capability_id, owner_user_id, product_kind, capability_protocol
             ) VALUES ($1, $2, 'knowledge_agent_test', $3)`,
            [fixture.capabilityId, fixture.ownerUserId, CAPABILITY_PROTOCOL],
          ),
        '23514',
        'ck_sessions_agent_package_binding',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `INSERT INTO sessions (
               capability_id, owner_user_id, mode, product_kind, capability_protocol,
               release_id, package_digest, release_scope,
               knowledge_resource_path, knowledge_resource_digest
             ) VALUES (
               $1, $2, 'consume', 'knowledge_agent_test', $3, $4, $5, $6, $7, $8
             )`,
            [
              fixture.capabilityId,
              fixture.ownerUserId,
              CAPABILITY_PROTOCOL,
              fixture.releaseId,
              digest('not-the-release-package'),
              RELEASE_SCOPE,
              RESOURCE_PATH,
              fixture.resourceDigest,
            ],
          ),
        '23503',
        'fk_sessions_agent_package_release',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `INSERT INTO sessions (
               capability_id, owner_user_id, mode, product_kind, capability_protocol,
               release_id, package_digest, release_scope,
               knowledge_resource_path, knowledge_resource_digest,
               agent_project_id, agent_revision_id
             ) VALUES (
               $1, $2, 'consume', 'knowledge_agent_test', $3, $4, $5, $6, $7, $8, $9, $10
             )`,
            [
              fixture.capabilityId,
              fixture.ownerUserId,
              CAPABILITY_PROTOCOL,
              fixture.releaseId,
              fixture.packageDigest,
              RELEASE_SCOPE,
              RESOURCE_PATH,
              fixture.resourceDigest,
              randomUUID(),
              randomUUID(),
            ],
          ),
        '23514',
        'ck_sessions_agent_package_binding',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `INSERT INTO sessions (
               capability_id, owner_user_id, product_kind, capability_protocol,
               release_id, package_digest, release_scope,
               knowledge_resource_path, knowledge_resource_digest
             ) VALUES (
               $1, $2, 'knowledge_agent_test', $3, $4, $5, 'production', $6, $7
             )`,
            [
              fixture.capabilityId,
              fixture.ownerUserId,
              CAPABILITY_PROTOCOL,
              fixture.releaseId,
              fixture.packageDigest,
              RESOURCE_PATH,
              fixture.resourceDigest,
            ],
          ),
        '23514',
        'ck_sessions_agent_package_binding',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(`UPDATE sessions SET package_digest = $2 WHERE id = $1`, [
            fixture.sessionId,
            digest('rebind'),
          ]),
        '55000',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(`UPDATE sessions SET owner_user_id = $2 WHERE id = $1`, [
            fixture.sessionId,
            fixture.publisherUserId,
          ]),
        '55000',
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('rejects noncanonical policy IDs and any charge-to-Session resource drift', async () => {
    for (const options of [
      { chargeResourceDigest: null },
      { chargeBillingPolicy: null },
      { chargeValidatorPolicy: null },
      { chargeBillingPolicy: ' Knowledge-billing-v1' },
      { chargeBillingPolicy: 'knowledge-billing-v1 ' },
      { chargeValidatorPolicy: 'Knowledge-citations-v1' },
    ]) {
      await expect(seedKnowledgeUsage(owner, options)).rejects.toMatchObject({
        code: '23514',
        constraint: 'ck_usage_charge_agent_package_binding',
      });
    }

    await expect(
      seedKnowledgeUsage(owner, { chargeResourceDigest: digest('drifted-resource') }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('fails closed when a terminal charge outcome or required response digest is SQL NULL', async () => {
    const nullOutcome = await seedKnowledgeUsage(owner);
    await owner.query('BEGIN');
    try {
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `UPDATE usage_charges
                SET status = 'completed', finished_at = now(), updated_at = now()
              WHERE id = $1`,
            [nullOutcome.chargeId],
          ),
        '23514',
        'ck_usage_charge_agent_package_binding',
      );
    } finally {
      await owner.query('ROLLBACK');
    }

    const nullResponse = await seedKnowledgeUsage(owner);
    const runtime = clients.get('combo_runtime')!;
    await runtime.query('BEGIN');
    try {
      await prepareTerminal(runtime, nullResponse, 'answered', { insertReceipt: false });
      await expectDatabaseError(
        runtime,
        () => insertReceipt(runtime, nullResponse, 'answered', { responseDigest: null }),
        '23514',
        'ck_agent_usage_receipt_outcome',
      );
    } finally {
      await runtime.query('ROLLBACK');
    }
  });

  it.each<KnowledgeOutcome>(['answered', 'insufficient_evidence', 'failed', 'interrupted'])(
    'atomically commits the exact %s Turn, charge, and receipt state',
    async (outcome) => {
      const fixture = await seedKnowledgeUsage(owner);
      const runtime = clients.get('combo_runtime')!;
      const receiptId = await completeTerminal(runtime, fixture, outcome);
      const shape = terminalShape(outcome);

      const result = await owner.query<{
        turn_status: string;
        charge_status: string;
        execution_outcome: string;
        receipt_id: string;
        owner_user_id: string;
        usage_id: string;
        release_id: string;
        package_digest: string;
        resource_digest: string;
        billing_policy_version: string;
        validator_policy_version: string;
        charge_source: string;
        settled_cents: string;
        validation_code: string;
        response_message_id: string | null;
        response_digest: string | null;
        citation_chunk_ids: string[];
        execution_environment: string;
        runtime_release_id: string;
        runtime_source_sha: string;
      }>(
        `SELECT t.status AS turn_status, c.status AS charge_status, c.execution_outcome,
              r.id AS receipt_id, r.owner_user_id, r.usage_id, r.release_id,
              r.package_digest, r.knowledge_resource_digest AS resource_digest,
              r.billing_policy_version, r.validator_policy_version, r.charge_source,
              r.settled_cents::text, r.validation_code, r.response_message_id,
              r.response_digest,
              r.citation_chunk_ids, r.execution_environment, r.runtime_release_id,
              r.runtime_source_sha
         FROM turns t
         JOIN usage_charges c ON c.turn_id = t.id
         JOIN agent_usage_receipts r ON r.usage_charge_id = c.id
        WHERE t.id = $1`,
        [fixture.turnId],
      );
      expect(result.rows[0]).toMatchObject({
        turn_status: shape.turnStatus,
        charge_status: shape.chargeStatus,
        execution_outcome: outcome,
        receipt_id: receiptId,
        owner_user_id: fixture.ownerUserId,
        usage_id: fixture.usageId,
        release_id: fixture.releaseId,
        package_digest: fixture.packageDigest,
        resource_digest: fixture.resourceDigest,
        billing_policy_version: BILLING_POLICY,
        validator_policy_version: VALIDATOR_POLICY,
        charge_source: 'free',
        settled_cents: '0',
        validation_code: shape.validationCode,
        response_message_id:
          outcome === 'answered' || outcome === 'insufficient_evidence'
            ? fixture.responseMessageId
            : null,
        citation_chunk_ids: shape.citations,
        execution_environment: 'test',
        runtime_release_id: RUNTIME_RELEASE_ID,
        runtime_source_sha: RUNTIME_SOURCE_SHA,
      });
      expect(result.rows[0]?.response_digest).toBe(shape.responseDigest);
    },
  );

  it.each<ValidationCode>(['rejected', 'unavailable', 'protocol_invalid'])(
    'records failed platform validation as %s while releasing a zero-settlement charge',
    async (validationCode) => {
      const fixture = await seedKnowledgeUsage(owner);
      const runtime = clients.get('combo_runtime')!;
      await completeTerminal(runtime, fixture, 'failed', { validationCode });
      const terminal = await owner.query<{
        status: string;
        settled_cents: string;
        execution_outcome: string;
        validation_code: string;
      }>(
        `SELECT c.status, c.settled_cents::text, c.execution_outcome, r.validation_code
           FROM usage_charges c
           JOIN agent_usage_receipts r ON r.usage_charge_id = c.id
          WHERE c.id = $1`,
        [fixture.chargeId],
      );
      expect(terminal.rows[0]).toEqual({
        status: 'released',
        settled_cents: '0',
        execution_outcome: 'failed',
        validation_code: validationCode,
      });
    },
  );

  it('requires matching Test runtime evidence and a valid outcome-to-validator mapping', async () => {
    const fixture = await seedKnowledgeUsage(owner);
    const runtime = clients.get('combo_runtime')!;
    await runtime.query('BEGIN');
    try {
      await prepareTerminal(runtime, fixture, 'failed', { insertReceipt: false });
      await expectDatabaseError(
        runtime,
        () =>
          insertReceipt(runtime, fixture, 'failed', {
            executionEnvironment: 'production',
          }),
        '23514',
        'ck_agent_usage_receipt_environment',
      );
      await expectDatabaseError(
        runtime,
        () =>
          insertReceipt(runtime, fixture, 'failed', {
            runtimeReleaseId: `release-${'2'.repeat(40)}`,
          }),
        '23514',
        'ck_agent_usage_receipt_runtime_release',
      );
      await expectDatabaseError(
        runtime,
        () => insertReceipt(runtime, fixture, 'failed', { validationCode: 'accepted' }),
        '23514',
        'ck_agent_usage_receipt_outcome',
      );

      const receiptId = await insertReceipt(runtime, fixture, 'failed', {
        validationCode: 'rejected',
      });
      await runtime.query('SET CONSTRAINTS ALL IMMEDIATE');
      await runtime.query('COMMIT');
      expect(
        (
          await owner.query<{ id: string }>(
            'SELECT id FROM agent_usage_receipts WHERE usage_charge_id = $1',
            [fixture.chargeId],
          )
        ).rows[0]?.id,
      ).toBe(receiptId);
    } catch (error) {
      await runtime.query('ROLLBACK');
      throw error;
    }
  });

  it('rejects missing receipts, outcome drift, and invalid or duplicate citation references', async () => {
    const runtime = clients.get('combo_runtime')!;

    const missingReceipt = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    await prepareTerminal(runtime, missingReceipt, 'insufficient_evidence', {
      insertReceipt: false,
    });
    await expect(runtime.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
      code: '23514',
    });
    await runtime.query('ROLLBACK');

    const drifted = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    await runtime.query(
      `UPDATE turns SET status = 'completed', finished_at = now() WHERE id = $1`,
      [drifted.turnId],
    );
    await runtime.query(
      `UPDATE billing_free_allowances
          SET free_reserved_count = free_reserved_count - 1, updated_at = now()
        WHERE owner_user_id = $1 AND capability_id = $2`,
      [drifted.ownerUserId, drifted.capabilityId],
    );
    await runtime.query(
      `UPDATE usage_charges
          SET status = 'released', execution_outcome = 'failed',
              finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [drifted.chargeId],
    );
    await insertReceipt(runtime, drifted, 'failed');
    await expect(runtime.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
      code: '23514',
    });
    await runtime.query('ROLLBACK');

    for (const citations of [
      ['chunk.knowledge.not-a-digest'],
      [CITATION_ID, CITATION_ID],
      [CITATION_ID_SECOND, CITATION_ID],
    ]) {
      const invalidCitation = await seedKnowledgeUsage(owner);
      await runtime.query('BEGIN');
      await prepareTerminal(runtime, invalidCitation, 'answered', {
        receiptCitations: citations,
      });
      await expect(runtime.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
        code: '23514',
      });
      await runtime.query('ROLLBACK');
    }

    const overLimit = await seedKnowledgeUsage(owner);
    await runtime.query('BEGIN');
    try {
      await prepareTerminal(runtime, overLimit, 'answered', { insertReceipt: false });
      await expectDatabaseError(
        runtime,
        () =>
          insertReceipt(runtime, overLimit, 'answered', {
            citationIds: Array.from(
              { length: 33 },
              (_, index) => `chunk.knowledge.${index.toString(16).padStart(32, '0')}`,
            ),
          }),
        '23514',
        'ck_agent_usage_receipt_citations',
      );
    } finally {
      await runtime.query('ROLLBACK');
    }
  });
});
