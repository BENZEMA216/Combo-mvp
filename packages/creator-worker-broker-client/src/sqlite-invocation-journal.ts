import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  CanonicalBase64UrlBytesSchema,
  BrokerEnvelopeSchema,
  BrokerSensitiveMessageSchema,
  ExecutionCapabilitySchema,
  UuidSchema,
  WorkerInvocationFactSchema,
  WorkerInvocationPreparedFactSchema,
  WorkerInvocationStartedFactSchema,
  WorkerInvocationSucceededFactSchema,
  canonicalSha256,
  canonicalizeJson,
  executionCapabilityBindingFrom,
  executionCapabilityDigest,
  workerInvocationFactDigest,
  type BrokerCommand,
  type BrokerEnvelope,
  type BrokerSensitiveMessage,
  type BrokerSensitiveMessageAad,
  type ExecutionCapability,
  type ExpectedExecutionCapabilityBinding,
  type WorkerInvocationFact,
} from '@cb/creator-agent-protocol';

export const WORKER_INVOCATION_SCHEMA_VERSION = 2;
export const WORKER_INVOCATION_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const LOCAL_INVOCATION_PROMPT_PROTOCOL = 'combo.local-invocation-prompt/1' as const;
export const LOCAL_INVOCATION_RESULT_PROTOCOL = 'combo.local-invocation-result/1' as const;

export type LocalInvocationPromptAad = Readonly<{
  schemaVersion: 1;
  installationId: string;
  invocationId: string;
  conversationId: string;
  agentVersionDigest: string;
  role: 'USER';
}>;

export type LocalInvocationPromptCiphertext = Readonly<{
  algorithm: 'aes-256-gcm/v1';
  keyScope: 'worker-keychain';
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
  cipherDigest: string;
  requestDigest: string;
  aad: LocalInvocationPromptAad;
  aadDigest: string;
  aadVersion: 1;
}>;

export const LocalInvocationPromptAadSchema = Object.freeze({
  parse(input: unknown): LocalInvocationPromptAad {
    const row = strictObject(input, [
      'schemaVersion',
      'installationId',
      'invocationId',
      'conversationId',
      'agentVersionDigest',
      'role',
    ]);
    if (row.schemaVersion !== 1 || row.role !== 'USER') throw new Error('local-prompt-aad');
    return Object.freeze({
      schemaVersion: 1,
      installationId: UuidSchema.parse(row.installationId),
      invocationId: UuidSchema.parse(row.invocationId),
      conversationId: UuidSchema.parse(row.conversationId),
      agentVersionDigest: parseSha256Hex(row.agentVersionDigest),
      role: 'USER',
    });
  },
});

export function localInvocationPromptAadBytes(aad: LocalInvocationPromptAad): Buffer {
  return Buffer.from(canonicalizeJson(LocalInvocationPromptAadSchema.parse(aad)), 'utf8');
}

export function localInvocationPromptAadDigest(aad: LocalInvocationPromptAad): string {
  return canonicalSha256(LocalInvocationPromptAadSchema.parse(aad));
}

export function localInvocationPromptCipherDigest(
  nonce: string,
  ciphertext: string,
  authTag: string,
): string {
  return canonicalSha256({
    protocol: LOCAL_INVOCATION_PROMPT_PROTOCOL,
    schemaVersion: 1,
    nonce: CanonicalBase64UrlBytesSchema(12, 12).parse(nonce),
    ciphertext: CanonicalBase64UrlBytesSchema(1, 49_152).parse(ciphertext),
    authTag: CanonicalBase64UrlBytesSchema(16, 16).parse(authTag),
  });
}

export const LocalInvocationPromptCiphertextSchema = Object.freeze({
  parse(input: unknown): LocalInvocationPromptCiphertext {
    const row = strictObject(input, [
      'algorithm',
      'keyScope',
      'keyId',
      'nonce',
      'ciphertext',
      'authTag',
      'cipherDigest',
      'requestDigest',
      'aad',
      'aadDigest',
      'aadVersion',
    ]);
    if (
      row.algorithm !== 'aes-256-gcm/v1' ||
      row.keyScope !== 'worker-keychain' ||
      row.aadVersion !== 1 ||
      typeof row.keyId !== 'string' ||
      !/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(row.keyId)
    ) {
      throw new Error('local-prompt-metadata');
    }
    const nonce = CanonicalBase64UrlBytesSchema(12, 12).parse(row.nonce);
    const ciphertext = CanonicalBase64UrlBytesSchema(1, 49_152).parse(row.ciphertext);
    const authTag = CanonicalBase64UrlBytesSchema(16, 16).parse(row.authTag);
    const aad = LocalInvocationPromptAadSchema.parse(row.aad);
    const parsed = Object.freeze({
      algorithm: 'aes-256-gcm/v1' as const,
      keyScope: 'worker-keychain' as const,
      keyId: row.keyId,
      nonce,
      ciphertext,
      authTag,
      cipherDigest: parseSha256Hex(row.cipherDigest),
      requestDigest: parseHmacSha256(row.requestDigest),
      aad,
      aadDigest: parseSha256Hex(row.aadDigest),
      aadVersion: 1 as const,
    });
    if (
      parsed.cipherDigest !== localInvocationPromptCipherDigest(nonce, ciphertext, authTag) ||
      parsed.aadDigest !== localInvocationPromptAadDigest(aad)
    ) {
      throw new Error('local-prompt-digest');
    }
    return parsed;
  },
});

export type LocalInvocationResultAad = Readonly<{
  schemaVersion: 1;
  installationId: string;
  invocationId: string;
  conversationId: string;
  agentVersionDigest: string;
  role: 'ASSISTANT';
}>;

export type LocalInvocationResultCiphertext = Readonly<{
  algorithm: 'aes-256-gcm/v1';
  keyScope: 'worker-keychain';
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
  cipherDigest: string;
  resultDigest: string;
  aad: LocalInvocationResultAad;
  aadDigest: string;
  aadVersion: 1;
}>;

/** Strict runtime schema without making this package depend directly on Zod internals. */
export const LocalInvocationResultAadSchema = Object.freeze({
  parse(input: unknown): LocalInvocationResultAad {
    const row = strictObject(input, [
      'schemaVersion',
      'installationId',
      'invocationId',
      'conversationId',
      'agentVersionDigest',
      'role',
    ]);
    if (row.schemaVersion !== 1 || row.role !== 'ASSISTANT') throw new Error('local-result-aad');
    return Object.freeze({
      schemaVersion: 1,
      installationId: UuidSchema.parse(row.installationId),
      invocationId: UuidSchema.parse(row.invocationId),
      conversationId: UuidSchema.parse(row.conversationId),
      agentVersionDigest: parseSha256Hex(row.agentVersionDigest),
      role: 'ASSISTANT',
    });
  },
});

export function localInvocationResultAadBytes(aad: LocalInvocationResultAad): Buffer {
  return Buffer.from(canonicalizeJson(LocalInvocationResultAadSchema.parse(aad)), 'utf8');
}

export function localInvocationResultAadDigest(aad: LocalInvocationResultAad): string {
  return canonicalSha256(LocalInvocationResultAadSchema.parse(aad));
}

export function localInvocationResultCipherDigest(
  nonce: string,
  ciphertext: string,
  authTag: string,
): string {
  return canonicalSha256({
    protocol: LOCAL_INVOCATION_RESULT_PROTOCOL,
    schemaVersion: 1,
    nonce: CanonicalBase64UrlBytesSchema(12, 12).parse(nonce),
    ciphertext: CanonicalBase64UrlBytesSchema(1, 49_152).parse(ciphertext),
    authTag: CanonicalBase64UrlBytesSchema(16, 16).parse(authTag),
  });
}

export const LocalInvocationResultCiphertextSchema = Object.freeze({
  parse(input: unknown): LocalInvocationResultCiphertext {
    const row = strictObject(input, [
      'algorithm',
      'keyScope',
      'keyId',
      'nonce',
      'ciphertext',
      'authTag',
      'cipherDigest',
      'resultDigest',
      'aad',
      'aadDigest',
      'aadVersion',
    ]);
    if (
      row.algorithm !== 'aes-256-gcm/v1' ||
      row.keyScope !== 'worker-keychain' ||
      row.aadVersion !== 1 ||
      typeof row.keyId !== 'string' ||
      !/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(row.keyId)
    ) {
      throw new Error('local-result-metadata');
    }
    const nonce = CanonicalBase64UrlBytesSchema(12, 12).parse(row.nonce);
    const ciphertext = CanonicalBase64UrlBytesSchema(1, 49_152).parse(row.ciphertext);
    const authTag = CanonicalBase64UrlBytesSchema(16, 16).parse(row.authTag);
    const aad = LocalInvocationResultAadSchema.parse(row.aad);
    const parsed = Object.freeze({
      algorithm: 'aes-256-gcm/v1' as const,
      keyScope: 'worker-keychain' as const,
      keyId: row.keyId,
      nonce,
      ciphertext,
      authTag,
      cipherDigest: parseSha256Hex(row.cipherDigest),
      resultDigest: parseHmacSha256(row.resultDigest),
      aad,
      aadDigest: parseSha256Hex(row.aadDigest),
      aadVersion: 1 as const,
    });
    if (
      parsed.cipherDigest !== localInvocationResultCipherDigest(nonce, ciphertext, authTag) ||
      parsed.aadDigest !== localInvocationResultAadDigest(aad)
    ) {
      throw new Error('local-result-digest');
    }
    return parsed;
  },
});

/**
 * Invocation facts live in the Broker transport database. Keeping these tables in the same
 * physical WAL is what makes command consumption and the corresponding local fact one commit.
 */
export const WORKER_INVOCATION_SCHEMA_SQL = `
  -- This table is intentionally empty at every logical boundary. The transport temporarily fills
  -- and deletes it to leave real freelist pages that only terminal/reconciliation transactions
  -- may consume when max_page_count or the filesystem is under pressure.
  CREATE TABLE local_recovery_reserve_pages (
    slot INTEGER PRIMARY KEY,
    payload BLOB NOT NULL
  ) STRICT;

  CREATE TABLE local_conversations (
    conversation_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES transport_installations(installation_id),
    deployment_id TEXT NOT NULL,
    agent_version_id TEXT NOT NULL,
    agent_version_digest TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    worker_session_id TEXT NOT NULL,
    fence TEXT NOT NULL,
    open_command_id TEXT NOT NULL UNIQUE,
    open_connection_id TEXT NOT NULL,
    open_sequence TEXT NOT NULL,
    sandbox_instance_id TEXT NOT NULL,
    runtime_thread_id TEXT,
    ready_evidence_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('READY', 'CLOSED', 'UNCERTAIN')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    row_digest TEXT NOT NULL,
    FOREIGN KEY (open_connection_id, open_sequence)
      REFERENCES transport_inbound_frames(connection_id, sequence)
  ) STRICT;

  CREATE INDEX local_conversation_installation_state
    ON local_conversations(installation_id, state, created_at_ms);

  CREATE TABLE local_invocations (
    invocation_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES local_conversations(conversation_id),
    installation_id TEXT NOT NULL REFERENCES transport_installations(installation_id),
    client_message_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    prompt_ciphertext TEXT,
    local_prompt_cipher_digest TEXT NOT NULL,
    prompt_released_at_ms INTEGER,
    prompt_purged_at_ms INTEGER,
    host_prompt_release_count INTEGER NOT NULL DEFAULT 0
      CHECK (host_prompt_release_count IN (0, 1)),
    agent_version_id TEXT NOT NULL,
    agent_version_digest TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    worker_session_id TEXT NOT NULL,
    fence TEXT NOT NULL,
    execution_capability_id TEXT NOT NULL UNIQUE,
    execution_capability_digest TEXT NOT NULL,
    execution_capability_json TEXT NOT NULL,
    execution_capability_binding_json TEXT NOT NULL,
    capability_not_before_ms INTEGER NOT NULL,
    capability_expires_at_ms INTEGER NOT NULL,
    command_deadline_at_ms INTEGER NOT NULL,
    prepare_command_id TEXT NOT NULL UNIQUE,
    prepare_connection_id TEXT NOT NULL,
    prepare_sequence TEXT NOT NULL,
    prepare_canonical_digest TEXT NOT NULL,
    prepare_semantic_digest TEXT NOT NULL,
    prepared_source_event_id TEXT NOT NULL UNIQUE,
    prepared_fact_digest TEXT NOT NULL,
    start_command_id TEXT UNIQUE,
    start_connection_id TEXT,
    start_sequence TEXT,
    start_canonical_digest TEXT,
    dispatch_nonce TEXT UNIQUE,
    dispatch_permit_issued_at_ms INTEGER,
    runtime_turn_id TEXT,
    dispatch_receipt_digest TEXT,
    sandbox_attestation_digest TEXT,
    started_source_event_id TEXT UNIQUE,
    started_fact_digest TEXT,
    result_digest TEXT,
    result_ciphertext TEXT,
    local_result_cipher_digest TEXT,
    result_source_event_id TEXT UNIQUE,
    result_fact_digest TEXT,
    terminal_source_event_id TEXT UNIQUE,
    terminal_fact_digest TEXT,
    state TEXT NOT NULL CHECK (
      state IN ('PREPARED', 'STARTING', 'RUNNING', 'FINAL_READY', 'CLOUD_COMMITTED',
                'FAILED', 'CANCELLED', 'UNCERTAIN')
    ),
    host_dispatch_intent_count INTEGER NOT NULL DEFAULT 0
      CHECK (host_dispatch_intent_count IN (0, 1)),
    host_dispatch_confirmed_count INTEGER NOT NULL DEFAULT 0
      CHECK (host_dispatch_confirmed_count IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    row_digest TEXT NOT NULL,
    UNIQUE (conversation_id, client_message_id),
    FOREIGN KEY (start_connection_id, start_sequence)
      REFERENCES transport_inbound_frames(connection_id, sequence),
    CHECK (
      (start_command_id IS NULL AND start_connection_id IS NULL AND start_sequence IS NULL
        AND start_canonical_digest IS NULL AND dispatch_nonce IS NULL
        AND dispatch_permit_issued_at_ms IS NULL AND host_dispatch_intent_count = 0)
      OR
      (start_command_id IS NOT NULL AND start_connection_id IS NOT NULL AND start_sequence IS NOT NULL
        AND start_canonical_digest IS NOT NULL AND dispatch_nonce IS NOT NULL
        AND dispatch_permit_issued_at_ms IS NOT NULL AND host_dispatch_intent_count = 1)
    ),
    CHECK (
      (runtime_turn_id IS NULL AND dispatch_receipt_digest IS NULL
        AND sandbox_attestation_digest IS NULL AND started_source_event_id IS NULL
        AND started_fact_digest IS NULL AND host_dispatch_confirmed_count = 0)
      OR
      (runtime_turn_id IS NOT NULL AND dispatch_receipt_digest IS NOT NULL
        AND sandbox_attestation_digest IS NOT NULL AND started_source_event_id IS NOT NULL
        AND started_fact_digest IS NOT NULL AND host_dispatch_confirmed_count = 1)
    ),
    CHECK (
      (result_digest IS NULL AND result_ciphertext IS NULL
        AND local_result_cipher_digest IS NULL AND result_source_event_id IS NULL
        AND result_fact_digest IS NULL)
      OR
      (result_digest IS NOT NULL AND result_ciphertext IS NOT NULL
        AND local_result_cipher_digest IS NOT NULL AND result_source_event_id IS NOT NULL
        AND result_fact_digest IS NOT NULL)
    ),
    CHECK (
      (prompt_ciphertext IS NOT NULL AND prompt_purged_at_ms IS NULL)
      OR (prompt_ciphertext IS NULL AND prompt_purged_at_ms IS NOT NULL)
    ),
    CHECK (
      (prompt_released_at_ms IS NULL AND host_prompt_release_count = 0)
      OR (prompt_released_at_ms IS NOT NULL AND host_prompt_release_count = 1)
    )
  ) STRICT;

  CREATE UNIQUE INDEX local_one_active_invocation
    ON local_invocations(installation_id)
    WHERE state IN ('PREPARED', 'STARTING', 'RUNNING', 'FINAL_READY');

  CREATE INDEX local_invocation_conversation_state
    ON local_invocations(conversation_id, state, created_at_ms);

  CREATE TABLE local_consumed_commands (
    command_id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    sequence TEXT NOT NULL,
    canonical_digest TEXT NOT NULL,
    semantic_digest TEXT NOT NULL,
    command_type TEXT NOT NULL,
    conversation_id TEXT,
    invocation_id TEXT,
    disposition TEXT NOT NULL CHECK (
      disposition IN ('APPLIED', 'IDEMPOTENT_REPLAY', 'SECURITY_BLOCK', 'EXPIRED')
    ),
    consumed_at_ms INTEGER NOT NULL,
    row_digest TEXT NOT NULL,
    UNIQUE (connection_id, sequence)
  ) STRICT;

  CREATE INDEX local_consumed_invocation_commands
    ON local_consumed_commands(invocation_id, consumed_at_ms);

  CREATE TABLE local_invocation_events (
    event_id INTEGER PRIMARY KEY,
    invocation_id TEXT NOT NULL REFERENCES local_invocations(invocation_id),
    command_id TEXT,
    source_event_id TEXT UNIQUE,
    event_type TEXT NOT NULL CHECK (
      event_type IN ('invocation.prepared', 'local.invocation.starting',
                     'invocation.started', 'invocation.succeeded', 'invocation.failed',
                     'invocation.cancelled', 'invocation.uncertain')
    ),
    from_state TEXT CHECK (
      from_state IS NULL OR from_state IN ('PREPARED', 'STARTING', 'RUNNING', 'FINAL_READY',
                                           'CLOUD_COMMITTED', 'FAILED', 'CANCELLED', 'UNCERTAIN')
    ),
    to_state TEXT NOT NULL CHECK (
      to_state IN ('PREPARED', 'STARTING', 'RUNNING', 'FINAL_READY', 'CLOUD_COMMITTED',
                   'FAILED', 'CANCELLED', 'UNCERTAIN')
    ),
    fact_json TEXT,
    fact_digest TEXT,
    occurred_at_ms INTEGER NOT NULL,
    event_digest TEXT NOT NULL,
    CHECK (
      (fact_json IS NULL AND fact_digest IS NULL)
      OR (fact_json IS NOT NULL AND fact_digest IS NOT NULL AND source_event_id IS NOT NULL)
    )
  ) STRICT;

  CREATE INDEX local_invocation_event_order
    ON local_invocation_events(invocation_id, event_id);

  CREATE TABLE local_invocation_outbox (
    source_event_id TEXT PRIMARY KEY,
    invocation_id TEXT NOT NULL REFERENCES local_invocations(invocation_id),
    event_type TEXT NOT NULL CHECK (
      event_type IN ('invocation.prepared', 'invocation.started', 'invocation.succeeded',
                     'invocation.failed', 'invocation.cancelled', 'invocation.uncertain')
    ),
    correlation_id TEXT NOT NULL,
    fact_json TEXT NOT NULL,
    fact_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    row_digest TEXT NOT NULL
  ) STRICT;

  CREATE INDEX local_invocation_pending_outbox
    ON local_invocation_outbox(invocation_id, created_at_ms);

  CREATE TABLE local_invocation_deliveries (
    delivery_message_id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL REFERENCES local_invocation_outbox(source_event_id),
    invocation_id TEXT NOT NULL REFERENCES local_invocations(invocation_id),
    connection_id TEXT NOT NULL,
    sequence TEXT NOT NULL,
    canonical_digest TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
      event_type IN ('invocation.prepared', 'invocation.started', 'invocation.succeeded',
                     'invocation.failed', 'invocation.cancelled', 'invocation.uncertain')
    ),
    fact_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    row_digest TEXT NOT NULL
  ) STRICT;

  CREATE INDEX local_invocation_delivery_source
    ON local_invocation_deliveries(source_event_id, created_at_ms);

  CREATE TABLE local_invocation_outbox_receipts (
    receipt_id INTEGER PRIMARY KEY,
    source_event_id TEXT NOT NULL UNIQUE
      REFERENCES local_invocation_outbox(source_event_id),
    fact_digest TEXT NOT NULL,
    delivery_message_id TEXT NOT NULL REFERENCES local_invocation_deliveries(delivery_message_id),
    ack_message_id TEXT NOT NULL UNIQUE,
    ack_connection_id TEXT NOT NULL,
    ack_sequence TEXT NOT NULL,
    ack_canonical_digest TEXT NOT NULL,
    cloud_evidence_digest TEXT NOT NULL,
    cloud_committed_at_ms INTEGER NOT NULL,
    row_digest TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER local_consumed_commands_no_update
    BEFORE UPDATE ON local_consumed_commands BEGIN
      SELECT RAISE(ABORT, 'local_consumed_commands is append-only');
    END;
  CREATE TRIGGER local_invocation_events_no_update
    BEFORE UPDATE ON local_invocation_events BEGIN
      SELECT RAISE(ABORT, 'local_invocation_events is append-only');
    END;
  CREATE TRIGGER local_invocation_outbox_no_update
    BEFORE UPDATE ON local_invocation_outbox BEGIN
      SELECT RAISE(ABORT, 'local_invocation_outbox is append-only');
    END;
  CREATE TRIGGER local_invocation_deliveries_no_update
    BEFORE UPDATE ON local_invocation_deliveries BEGIN
      SELECT RAISE(ABORT, 'local_invocation_deliveries is append-only');
    END;
  CREATE TRIGGER local_invocation_outbox_receipts_no_update
    BEFORE UPDATE ON local_invocation_outbox_receipts BEGIN
      SELECT RAISE(ABORT, 'local_invocation_outbox_receipts is append-only');
    END;
`;

const LOCAL_AUTHORITY_TABLES = [
  ['local_conversations', 'conversation_id'],
  ['local_invocations', 'invocation_id'],
  ['local_consumed_commands', 'command_id'],
  ['local_invocation_events', 'event_id'],
  ['local_invocation_outbox', 'source_event_id'],
  ['local_invocation_deliveries', 'delivery_message_id'],
  ['local_invocation_outbox_receipts', 'receipt_id'],
] as const;

export function workerInvocationTablesExist(database: DatabaseSync): boolean {
  const row = database
    .prepare(
      `SELECT count(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'local_conversations', 'local_invocations', 'local_consumed_commands',
         'local_invocation_events', 'local_invocation_outbox',
         'local_invocation_deliveries', 'local_invocation_outbox_receipts'
       )`,
    )
    .get() as { count: number };
  const reserve = database
    .prepare(
      `SELECT count(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name = 'local_recovery_reserve_pages'`,
    )
    .get() as { count: number };
  return row.count === LOCAL_AUTHORITY_TABLES.length && reserve.count === 1;
}

/** Rows folded into transport_meta.authority_digest and therefore the external watermark. */
export function workerInvocationAuthorityRows(database: DatabaseSync): unknown {
  if (!workerInvocationTablesExist(database)) return undefined;
  return Object.fromEntries(
    LOCAL_AUTHORITY_TABLES.map(([table, orderBy]) => [
      table,
      database.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all(),
    ]),
  );
}

export function sqliteInvocationRowDigest(domain: string, row: unknown): string {
  return createHash('sha256')
    .update(`combo:vnext:${domain}:v2\0`, 'utf8')
    .update(canonicalizeJson(row), 'utf8')
    .digest('hex');
}

/** Stable Cloud command identity; outer connection/sequence/Lease and fresh Prompt AEAD may vary. */
export function workerInvocationCommandSemanticDigest(command: BrokerCommand): string {
  const body =
    command.type === 'invocation.prepare'
      ? (({ userMessageCiphertext: _rewrapped, ...semanticBody }) => semanticBody)(command.body)
      : command.body;
  return canonicalSha256({
    protocol: command.protocol,
    schemaVersion: command.schemaVersion,
    kind: command.kind,
    type: command.type,
    messageId: command.messageId,
    correlationId: command.correlationId,
    body,
  });
}

/** Open-time validation is deliberately independent from transport_meta.authority_digest. */
export function assertWorkerInvocationIntegrity(database: DatabaseSync): void {
  if (!workerInvocationTablesExist(database)) throw new Error('missing-local-invocation-schema');
  const reserveRows = database
    .prepare('SELECT count(*) AS count FROM local_recovery_reserve_pages')
    .get() as { count: number };
  if (reserveRows.count !== 0) throw new Error('recovery-reserve-not-empty');
  const invocations = new Map(
    (database.prepare('SELECT * FROM local_invocations').all() as InvocationRow[]).map((row) => [
      row.invocation_id,
      row,
    ]),
  );
  const conversations = new Map(
    (
      database.prepare('SELECT * FROM local_conversations').all() as Array<Record<string, unknown>>
    ).map((row) => [String(row.conversation_id), row]),
  );
  for (const [table] of LOCAL_AUTHORITY_TABLES) {
    const rows = database.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const digestColumn = table === 'local_invocation_events' ? 'event_digest' : 'row_digest';
      if (typeof row[digestColumn] !== 'string') {
        throw new Error(`missing-${table}-row-digest`);
      }
      const storedDigest = row[digestColumn];
      const payload = { ...row };
      delete payload[digestColumn];
      if (table === 'local_invocation_events') delete payload.event_id;
      if (table === 'local_invocation_outbox_receipts') delete payload.receipt_id;
      if (storedDigest !== sqliteInvocationRowDigest(table, payload)) {
        throw new Error(`invalid-${table}-row-digest`);
      }
      if (table === 'local_invocation_events' && row.fact_json !== null) {
        const fact = WorkerInvocationFactSchema.parse(JSON.parse(String(row.fact_json)));
        const invocation = invocations.get(fact.invocationId);
        if (
          canonicalizeJson(fact) !== row.fact_json ||
          workerInvocationFactDigest(fact) !== row.fact_digest ||
          invocation === undefined ||
          fact.sourceEventId !== row.source_event_id ||
          fact.invocationId !== row.invocation_id ||
          fact.type !== row.event_type ||
          fact.agentVersionDigest !== invocation.agent_version_digest ||
          fact.snapshotDigest !== invocation.snapshot_digest ||
          fact.executionCapabilityDigest !== invocation.execution_capability_digest ||
          fact.leaseId !== invocation.lease_id ||
          fact.fence !== invocation.fence ||
          !eventFactMatchesInvocation(row, fact, invocation, conversations)
        ) {
          throw new Error('invalid-local-invocation-event-fact');
        }
      }
      if (table === 'local_invocation_outbox') {
        const fact = WorkerInvocationFactSchema.parse(JSON.parse(String(row.fact_json)));
        if (
          canonicalizeJson(fact) !== row.fact_json ||
          workerInvocationFactDigest(fact) !== row.fact_digest ||
          fact.sourceEventId !== row.source_event_id ||
          fact.invocationId !== row.invocation_id ||
          fact.type !== row.event_type ||
          !outboxCorrelationMatchesFact(String(row.correlation_id), fact) ||
          database
            .prepare(
              `SELECT 1 FROM local_invocation_events
               WHERE source_event_id = ? AND invocation_id = ? AND event_type = ?
                 AND fact_digest = ? AND fact_json = ?`,
            )
            .get(
              String(row.source_event_id),
              String(row.invocation_id),
              String(row.event_type),
              String(row.fact_digest),
              String(row.fact_json),
            ) === undefined
        ) {
          throw new Error('invalid-local-invocation-outbox-fact');
        }
      }
      if (table === 'local_invocation_deliveries') {
        const outbox = database
          .prepare(
            `SELECT invocation_id, event_type, fact_digest FROM local_invocation_outbox
             WHERE source_event_id = ?`,
          )
          .get(String(row.source_event_id)) as
          | { invocation_id: string; event_type: string; fact_digest: string }
          | undefined;
        const transport = database
          .prepare(
            `SELECT message_id, canonical_digest, envelope_json FROM transport_outbox
             WHERE message_id = ?`,
          )
          .get(String(row.delivery_message_id)) as
          | { message_id: string; canonical_digest: string; envelope_json: string }
          | undefined;
        if (
          outbox === undefined ||
          outbox.invocation_id !== row.invocation_id ||
          outbox.event_type !== row.event_type ||
          outbox.fact_digest !== row.fact_digest ||
          (transport !== undefined &&
            (transport.message_id !== row.delivery_message_id ||
              transport.canonical_digest !== row.canonical_digest ||
              !deliveryEnvelopeMatches(
                transport.envelope_json,
                transport.canonical_digest,
                row,
                outbox,
              )))
        ) {
          throw new Error('invalid-local-invocation-delivery');
        }
      }
      if (table === 'local_invocation_outbox_receipts') {
        const delivery = database
          .prepare(
            `SELECT source_event_id, fact_digest FROM local_invocation_deliveries
             WHERE delivery_message_id = ?`,
          )
          .get(String(row.delivery_message_id)) as
          | { source_event_id: string; fact_digest: string }
          | undefined;
        const ack = database
          .prepare(
            `SELECT message_id, canonical_digest, envelope_json FROM transport_inbound_frames
             WHERE connection_id = ? AND sequence = ?`,
          )
          .get(String(row.ack_connection_id), String(row.ack_sequence)) as
          | { message_id: string; canonical_digest: string; envelope_json: string }
          | undefined;
        if (
          delivery === undefined ||
          delivery.source_event_id !== row.source_event_id ||
          delivery.fact_digest !== row.fact_digest ||
          ack === undefined ||
          ack.message_id !== row.ack_message_id ||
          ack.canonical_digest !== row.ack_canonical_digest ||
          !cloudAckEnvelopeMatches(
            ack.envelope_json,
            ack.canonical_digest,
            String(row.delivery_message_id),
          )
        ) {
          throw new Error('invalid-local-invocation-outbox-receipt');
        }
      }
      if (table === 'local_consumed_commands') {
        const transport = database
          .prepare(
            `SELECT message_id, canonical_digest, envelope_json, envelope_kind, envelope_type
             FROM transport_inbound_frames WHERE connection_id = ? AND sequence = ?`,
          )
          .get(String(row.connection_id), String(row.sequence)) as
          | {
              message_id: string;
              canonical_digest: string;
              envelope_json: string;
              envelope_kind: string;
              envelope_type: string;
            }
          | undefined;
        if (transport === undefined) {
          const invocation =
            row.invocation_id === null ? undefined : invocations.get(String(row.invocation_id));
          if (
            row.command_type !== 'invocation.prepare' ||
            (row.disposition === 'SECURITY_BLOCK'
              ? row.invocation_id === null || row.conversation_id === null
              : invocation === undefined ||
                invocation.prepare_command_id !== row.command_id ||
                invocation.prepare_connection_id !== row.connection_id ||
                invocation.prepare_sequence !== row.sequence ||
                invocation.prepare_canonical_digest !== row.canonical_digest ||
                invocation.prepare_semantic_digest !== row.semantic_digest)
          ) {
            throw new Error('invalid-local-consumed-command-binding');
          }
          continue;
        }
        if (
          transport.message_id !== row.command_id ||
          transport.canonical_digest !== row.canonical_digest ||
          transport.envelope_kind !== 'command' ||
          transport.envelope_type !== row.command_type
        ) {
          throw new Error('invalid-local-consumed-command-binding');
        }
        const envelope = BrokerEnvelopeSchema.parse(JSON.parse(transport.envelope_json));
        if (
          canonicalizeJson(envelope) !== transport.envelope_json ||
          canonicalSha256(envelope) !== transport.canonical_digest ||
          envelope.kind !== 'command' ||
          workerInvocationCommandSemanticDigest(envelope) !== row.semantic_digest ||
          (row.invocation_id !== null &&
            (!('invocationId' in envelope.body) ||
              envelope.body.invocationId !== row.invocation_id)) ||
          (row.conversation_id !== null &&
            ('conversationId' in envelope.body
              ? envelope.body.conversationId !== row.conversation_id
              : row.invocation_id === null ||
                invocations.get(String(row.invocation_id))?.conversation_id !==
                  row.conversation_id))
        ) {
          throw new Error('invalid-local-consumed-command-envelope');
        }
      }
    }
  }
  for (const invocation of invocations.values()) {
    const capability = ExecutionCapabilitySchema.parse(
      JSON.parse(String(invocation.execution_capability_json)),
    );
    const binding = executionCapabilityBindingFrom(capability);
    if (
      canonicalizeJson(capability) !== invocation.execution_capability_json ||
      executionCapabilityDigest(capability) !== invocation.execution_capability_digest ||
      canonicalizeJson(binding) !== invocation.execution_capability_binding_json ||
      capability.capabilityId !== invocation.execution_capability_id ||
      capability.invocationId !== invocation.invocation_id ||
      capability.conversationId !== invocation.conversation_id ||
      capability.workerInstallationId !== invocation.installation_id ||
      capability.agentVersionId !== invocation.agent_version_id ||
      capability.agentVersionDigest !== invocation.agent_version_digest ||
      capability.leaseId !== invocation.lease_id ||
      capability.fence !== invocation.fence ||
      capability.requestDigest !== invocation.request_digest
    ) {
      throw new Error('invalid-local-invocation-capability');
    }
    const prepared = database
      .prepare(
        `SELECT fact_digest FROM local_invocation_events
         WHERE invocation_id = ? AND event_type = 'invocation.prepared'`,
      )
      .get(invocation.invocation_id) as { fact_digest: string } | undefined;
    if (
      prepared?.fact_digest !== invocation.prepared_fact_digest ||
      !invocationStateColumnsAreValid(invocation)
    ) {
      throw new Error('invalid-local-invocation-state-binding');
    }
  }
}

function eventFactMatchesInvocation(
  event: Record<string, unknown>,
  fact: WorkerInvocationFact,
  invocation: InvocationRow,
  conversations: ReadonlyMap<string, Record<string, unknown>>,
): boolean {
  if (fact.type === 'invocation.prepared') {
    return (
      event.command_id === fact.prepareCommandId &&
      event.from_state === null &&
      event.to_state === 'PREPARED' &&
      fact.sourceEventId === fact.prepareCommandId &&
      fact.prepareCommandId === invocation.prepare_command_id &&
      fact.requestDigest === invocation.request_digest
    );
  }
  if (fact.type === 'invocation.started') {
    const conversation = conversations.get(invocation.conversation_id);
    return (
      event.command_id === fact.startCommandId &&
      event.from_state === 'STARTING' &&
      event.to_state === 'RUNNING' &&
      fact.sourceEventId === fact.startCommandId &&
      fact.startCommandId === invocation.start_command_id &&
      fact.runtimeThreadId === conversation?.runtime_thread_id &&
      fact.runtimeTurnId === invocation.runtime_turn_id &&
      fact.dispatchReceiptDigest === invocation.dispatch_receipt_digest &&
      fact.sandboxAttestationDigest === invocation.sandbox_attestation_digest
    );
  }
  if (fact.type === 'invocation.succeeded') {
    const conversation = conversations.get(invocation.conversation_id);
    return (
      event.from_state === 'RUNNING' &&
      event.to_state === 'FINAL_READY' &&
      fact.sourceEventId === invocation.invocation_id &&
      fact.runtimeThreadId === conversation?.runtime_thread_id &&
      fact.runtimeTurnId === invocation.runtime_turn_id &&
      fact.startedFactDigest === invocation.started_fact_digest &&
      fact.resultDigest === invocation.result_digest &&
      fact.localResultCipherDigest === invocation.local_result_cipher_digest
    );
  }
  if (fact.type === 'invocation.uncertain') {
    return (
      fact.sourceEventId === invocation.invocation_id &&
      event.from_state === 'STARTING' &&
      event.to_state === 'UNCERTAIN' &&
      invocation.terminal_source_event_id === fact.sourceEventId &&
      invocation.terminal_fact_digest === workerInvocationFactDigest(fact)
    );
  }
  return fact.sourceEventId === invocation.invocation_id;
}

function outboxCorrelationMatchesFact(correlationId: string, fact: WorkerInvocationFact): boolean {
  if (fact.type === 'invocation.prepared') return correlationId === fact.prepareCommandId;
  if (fact.type === 'invocation.started') return correlationId === fact.startCommandId;
  return correlationId === fact.invocationId;
}

function deliveryEnvelopeMatches(
  envelopeJson: unknown,
  canonicalDigest: unknown,
  delivery: Record<string, unknown>,
  outbox: Readonly<{ invocation_id: string; event_type: string; fact_digest: string }>,
): boolean {
  try {
    const envelope = BrokerEnvelopeSchema.parse(JSON.parse(String(envelopeJson)));
    if (
      canonicalizeJson(envelope) !== envelopeJson ||
      canonicalSha256(envelope) !== canonicalDigest ||
      envelope.kind !== 'event' ||
      envelope.messageId !== delivery.delivery_message_id ||
      envelope.connectionId !== delivery.connection_id ||
      envelope.sequence !== delivery.sequence ||
      envelope.type !== delivery.event_type ||
      envelope.type !== outbox.event_type
    ) {
      return false;
    }
    const fact = factFromBrokerEvent(envelope);
    return (
      fact.invocationId === outbox.invocation_id &&
      fact.sourceEventId === delivery.source_event_id &&
      workerInvocationFactDigest(fact) === outbox.fact_digest &&
      (envelope.body as Record<string, unknown>).factDigest === outbox.fact_digest
    );
  } catch {
    return false;
  }
}

function factFromBrokerEvent(envelope: BrokerEnvelope): WorkerInvocationFact {
  if (
    envelope.kind !== 'event' ||
    !(
      envelope.type === 'invocation.prepared' ||
      envelope.type === 'invocation.started' ||
      envelope.type === 'invocation.succeeded' ||
      envelope.type === 'invocation.failed' ||
      envelope.type === 'invocation.cancelled' ||
      envelope.type === 'invocation.uncertain'
    )
  ) {
    throw new Error('not-invocation-fact');
  }
  const body = { ...envelope.body } as Record<string, unknown>;
  delete body.factDigest;
  if (envelope.type === 'invocation.succeeded') {
    delete body.conversationId;
    delete body.resultCiphertext;
  }
  return WorkerInvocationFactSchema.parse(body);
}

function cloudAckEnvelopeMatches(
  envelopeJson: unknown,
  canonicalDigest: unknown,
  deliveryMessageId: string,
): boolean {
  try {
    const envelope = BrokerEnvelopeSchema.parse(JSON.parse(String(envelopeJson)));
    return (
      canonicalizeJson(envelope) === envelopeJson &&
      canonicalSha256(envelope) === canonicalDigest &&
      envelope.kind === 'ack' &&
      envelope.type === 'message.ack' &&
      envelope.body.acknowledgedMessageId === deliveryMessageId &&
      envelope.body.level === 'CLOUD_COMMITTED' &&
      (envelope.body.decision === 'APPLIED' || envelope.body.decision === 'IDEMPOTENT_REPLAY')
    );
  } catch {
    return false;
  }
}

type StoredPendingOutbox = Readonly<{
  source_event_id: string;
  invocation_id: string;
  event_type: WorkerInvocationFact['type'];
  correlation_id: string;
  fact_json: string;
  fact_digest: string;
}>;

function loadExactPendingOutbox(
  database: DatabaseSync,
  installationId: string,
  reference: PendingInvocationFactReference,
): StoredPendingOutbox {
  const row = database
    .prepare(
      `SELECT o.source_event_id, o.invocation_id, o.event_type, o.correlation_id,
              o.fact_json, o.fact_digest
       FROM local_invocation_outbox AS o
       JOIN local_invocations AS i ON i.invocation_id = o.invocation_id
       LEFT JOIN local_invocation_outbox_receipts AS r
         ON r.source_event_id = o.source_event_id
       WHERE i.installation_id = ? AND o.source_event_id = ? AND o.invocation_id = ?
         AND o.event_type = ? AND o.correlation_id = ? AND o.fact_digest = ?
         AND r.source_event_id IS NULL`,
    )
    .get(
      installationId,
      reference.sourceEventId,
      reference.invocationId,
      reference.eventType,
      reference.correlationId,
      reference.factDigest,
    ) as StoredPendingOutbox | undefined;
  if (row === undefined) throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
  const fact = WorkerInvocationFactSchema.parse(JSON.parse(row.fact_json));
  if (
    canonicalizeJson(fact) !== row.fact_json ||
    workerInvocationFactDigest(fact) !== row.fact_digest
  ) {
    throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
  }
  return row;
}

function activeDeliveryForSource(
  database: DatabaseSync,
  sourceEventId: string,
): DurableInvocationFactDelivery | undefined {
  const row = database
    .prepare(
      `SELECT d.delivery_message_id, d.source_event_id, d.invocation_id, d.event_type,
              d.connection_id, d.sequence, d.canonical_digest, d.fact_digest
       FROM local_invocation_deliveries AS d
       JOIN transport_outbox AS t ON t.message_id = d.delivery_message_id
       WHERE d.source_event_id = ? AND t.state IN ('PENDING', 'WRITTEN', 'ACKED')
       ORDER BY d.created_at_ms DESC LIMIT 1`,
    )
    .get(sourceEventId) as
    | {
        delivery_message_id: string;
        source_event_id: string;
        invocation_id: string;
        event_type: WorkerInvocationFact['type'];
        connection_id: string;
        sequence: string;
        canonical_digest: string;
        fact_digest: string;
      }
    | undefined;
  return row === undefined
    ? undefined
    : Object.freeze({
        deliveryMessageId: row.delivery_message_id,
        sourceEventId: row.source_event_id,
        invocationId: row.invocation_id,
        eventType: row.event_type,
        connectionId: row.connection_id,
        sequence: row.sequence,
        canonicalDigest: row.canonical_digest,
        factDigest: row.fact_digest,
      });
}

function currentConnectionForDelivery(
  database: DatabaseSync,
  installationId: string,
  connectionId: string,
  ownerEpoch: number,
  cloudNow: Date,
): ConnectionAuthorityRow {
  const row = database
    .prepare(
      `SELECT installation_id, connection_id, owner_epoch, deployment_id, lease_id,
              worker_session_id, fence, lease_state, lease_expires_at, status
       FROM transport_connections WHERE installation_id = ? AND connection_id = ?
         AND owner_epoch = ?`,
    )
    .get(installationId, connectionId, ownerEpoch) as ConnectionAuthorityRow | undefined;
  if (
    row === undefined ||
    row.status !== 'ACTIVE' ||
    row.lease_state !== 'ACTIVE' ||
    !Number.isFinite(Date.parse(row.lease_expires_at)) ||
    Date.parse(row.lease_expires_at) <= cloudNow.getTime()
  ) {
    throw new WorkerInvocationJournalError('STALE_LEASE');
  }
  return row;
}

function loadExactCloudAck(
  database: DatabaseSync,
  installationId: string,
  reference: OpaqueInvocationCloudAckReference,
): Readonly<{ messageId: string; canonicalDigest: string }> {
  const row = database
    .prepare(
      `SELECT f.message_id, f.canonical_digest, f.envelope_json, f.acknowledged_message_id
       FROM transport_inbound_frames AS f
       JOIN transport_connections AS c ON c.connection_id = f.connection_id
       WHERE c.installation_id = ? AND f.connection_id = ? AND f.sequence = ?`,
    )
    .get(installationId, reference.connectionId, reference.sequence) as
    | {
        message_id: string;
        canonical_digest: string;
        envelope_json: string;
        acknowledged_message_id: string;
      }
    | undefined;
  if (
    row === undefined ||
    row.message_id !== reference.messageId ||
    row.canonical_digest !== reference.canonicalDigest ||
    row.acknowledged_message_id !== reference.acknowledgedDeliveryMessageId ||
    !cloudAckEnvelopeMatches(
      row.envelope_json,
      row.canonical_digest,
      reference.acknowledgedDeliveryMessageId,
    )
  ) {
    throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
  }
  return Object.freeze({ messageId: row.message_id, canonicalDigest: row.canonical_digest });
}

function invocationStateColumnsAreValid(row: InvocationRow): boolean {
  const promptRetained = row.prompt_ciphertext !== null && row.prompt_purged_at_ms === null;
  const promptPurged = row.prompt_ciphertext === null && row.prompt_purged_at_ms !== null;
  const promptUnreleased =
    row.prompt_released_at_ms === null && row.host_prompt_release_count === 0;
  const promptReleased = row.prompt_released_at_ms !== null && row.host_prompt_release_count === 1;
  if (!SHA256_HEX.test(row.local_prompt_cipher_digest)) return false;
  const hasStart =
    row.start_command_id !== null &&
    row.dispatch_nonce !== null &&
    row.host_dispatch_intent_count === 1;
  const hasHostReceipt =
    row.runtime_turn_id !== null &&
    row.started_source_event_id !== null &&
    row.started_fact_digest !== null &&
    row.host_dispatch_confirmed_count === 1;
  const hasResult =
    row.result_digest !== null &&
    row.result_ciphertext !== null &&
    row.local_result_cipher_digest !== null &&
    row.result_source_event_id === row.invocation_id &&
    row.result_fact_digest !== null;
  if (row.state === 'PREPARED') {
    return promptRetained && promptUnreleased && !hasStart && !hasHostReceipt && !hasResult;
  }
  if (row.state === 'STARTING') {
    return (
      promptRetained &&
      (promptUnreleased || promptReleased) &&
      hasStart &&
      !hasHostReceipt &&
      !hasResult
    );
  }
  if (row.state === 'RUNNING') {
    return promptPurged && promptReleased && hasStart && hasHostReceipt && !hasResult;
  }
  if (row.state === 'FINAL_READY' || row.state === 'CLOUD_COMMITTED') {
    return (
      promptPurged &&
      promptReleased &&
      hasStart &&
      hasHostReceipt &&
      hasResult &&
      row.terminal_source_event_id === row.invocation_id &&
      row.terminal_fact_digest === row.result_fact_digest
    );
  }
  if (row.state === 'UNCERTAIN') {
    return (
      promptPurged &&
      (promptUnreleased || promptReleased) &&
      hasStart &&
      !hasHostReceipt &&
      !hasResult &&
      row.terminal_source_event_id === row.invocation_id &&
      row.terminal_fact_digest !== null
    );
  }
  return (
    promptPurged &&
    row.terminal_source_event_id === row.invocation_id &&
    row.terminal_fact_digest !== null
  );
}

export type OpaqueInvocationCommandReference = Readonly<{
  connectionId: string;
  sequence: string;
  messageId: string;
  type: BrokerCommand['type'];
  canonicalDigest: string;
  effectState: 'PERSISTED';
}>;

export type WorkerInvocationJournalErrorCode =
  | 'COMMAND_REFERENCE_INVALID'
  | 'COMMAND_ALREADY_CONSUMED'
  | 'COMMAND_TYPE_INVALID'
  | 'CONVERSATION_NOT_READY'
  | 'CONVERSATION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CLIENT_MESSAGE_CONFLICT'
  | 'WORKER_BUSY'
  | 'INVOCATION_NOT_FOUND'
  | 'STALE_LEASE'
  | 'STALE_FENCE'
  | 'INVOCATION_DEADLINE_EXPIRED'
  | 'EXECUTION_CAPABILITY_INVALID'
  | 'START_COMMAND_CONFLICT'
  | 'ILLEGAL_LOCAL_TRANSITION'
  | 'PROMPT_AEAD_INVALID'
  | 'HOST_RECEIPT_INVALID'
  | 'FINAL_AEAD_INVALID'
  | 'FINAL_CONFLICT'
  | 'OUTBOX_CONFLICT'
  | 'JOURNAL_CAPACITY';

export class WorkerInvocationJournalError extends Error {
  constructor(readonly code: WorkerInvocationJournalErrorCode) {
    super(code);
    this.name = 'WorkerInvocationJournalError';
  }
}

export interface WorkerInvocationCapabilityAuthorityPort {
  verify(
    input: unknown,
    expected: ExpectedExecutionCapabilityBinding,
    now: Date,
  ): Readonly<{ capability: ExecutionCapability; capabilityDigest: string }>;
  verifyPreviouslyCommitted(
    input: unknown,
    expected: ExpectedExecutionCapabilityBinding,
    committedCapabilityDigest: string,
    committedAt: Date,
  ): Readonly<{ capability: ExecutionCapability; capabilityDigest: string }>;
}

export type ReadyConversationExpectedBinding = Readonly<{
  installationId: string;
  deploymentId: string;
  leaseId: string;
  workerSessionId: string;
  fence: string;
  conversationId: string;
  agentVersionId: string;
  agentVersionDigest: string;
  snapshotDigest: string;
  openCommandId: string;
}>;

export type VerifiedReadyConversationEvidence = Readonly<{
  sandboxInstanceId: string;
  runtimeThreadId: string;
  evidenceDigest: string;
}>;

export interface ReadyConversationAuthorityPort {
  verify(
    input: unknown,
    expected: ReadyConversationExpectedBinding,
    cloudNow: Date,
  ): VerifiedReadyConversationEvidence;
}

export type HostDispatchExpectedBinding = Readonly<{
  installationId: string;
  invocationId: string;
  conversationId: string;
  startCommandId: string;
  dispatchNonce: string;
  agentVersionId: string;
  agentVersionDigest: string;
  snapshotDigest: string;
  sandboxInstanceId: string;
}>;

export type VerifiedHostDispatchReceipt = Readonly<{
  runtimeTurnId: string;
  dispatchReceiptDigest: string;
  sandboxAttestationDigest: string;
}>;

export interface HostDispatchReceiptAuthorityPort {
  verify(
    input: unknown,
    expected: HostDispatchExpectedBinding,
    cloudNow: Date,
  ): VerifiedHostDispatchReceipt;
}

export interface TrustedHostDispatchPort {
  /** The only API allowed to observe authenticated prompt bytes. Never persists or logs them. */
  dispatchOnce(
    input: Readonly<{
      permit: OpaqueHostDispatchPermit;
      userMessage: Uint8Array;
    }>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface LocalPromptAeadAuthorityPort {
  /** Decrypts the request-lifetime Broker envelope and re-encrypts it under Worker Keychain. */
  rewrap(
    input: Readonly<{
      brokerCiphertext: BrokerSensitiveMessage;
      brokerAad: BrokerSensitiveMessageAad;
      localAad: LocalInvocationPromptAad;
      expectedRequestDigest: string;
    }>,
  ): Readonly<{
    ciphertext: LocalInvocationPromptCiphertext;
    requestDigest: string;
  }>;

  /** Exact one-use Host handoff; plaintext must never be persisted or logged. */
  open(
    input: Readonly<{
      ciphertext: LocalInvocationPromptCiphertext;
      expectedAad: LocalInvocationPromptAad;
      expectedRequestDigest: string;
    }>,
  ): Readonly<{
    plaintext: Uint8Array;
    requestDigest: string;
  }>;
}

export interface LocalResultAeadAuthorityPort {
  /** Decrypt/authenticate with the durable Worker-Keychain key and recompute result-domain HMAC. */
  verify(
    ciphertext: LocalInvocationResultCiphertext,
    expectedAad: LocalInvocationResultAad,
  ): Readonly<{ resultDigest: string }>;
}

export interface BrokerResultReencryptAuthorityPort {
  /** Re-encrypts authenticated local plaintext under the current request-lifetime session key. */
  reencrypt(
    input: Readonly<{
      localCiphertext: LocalInvocationResultCiphertext;
      localAad: LocalInvocationResultAad;
      brokerAad: BrokerSensitiveMessageAad;
    }>,
  ): Readonly<{ ciphertext: BrokerSensitiveMessage; resultDigest: string }>;
}

export type CloudInvocationAckExpectedBinding = Readonly<{
  installationId: string;
  invocationId: string;
  sourceEventId: string;
  factDigest: string;
  deliveryMessageId: string;
  ackMessageId: string;
  ackCanonicalDigest: string;
}>;

export interface CloudInvocationAckAuthorityPort {
  verify(
    input: unknown,
    expected: CloudInvocationAckExpectedBinding,
    cloudNow: Date,
  ): Readonly<{ evidenceDigest: string }>;
}

export interface TrustedCloudClockPort {
  now(): Date;
}

export type SqliteWorkerInvocationJournalOptions = Readonly<{
  capabilityAuthority: WorkerInvocationCapabilityAuthorityPort;
  readyConversationAuthority: ReadyConversationAuthorityPort;
  hostDispatchPort: TrustedHostDispatchPort;
  hostDispatchReceiptAuthority: HostDispatchReceiptAuthorityPort;
  localPromptAeadAuthority: LocalPromptAeadAuthorityPort;
  localResultAeadAuthority: LocalResultAeadAuthorityPort;
  brokerResultReencryptAuthority: BrokerResultReencryptAuthorityPort;
  cloudAckAuthority: CloudInvocationAckAuthorityPort;
  cloudClock: TrustedCloudClockPort;
  dispatchNonceFactory?: () => string;
  maxInvocations?: number;
  maxPendingFacts?: number;
}>;

export type WorkerInvocationJournalTransactionContext = Readonly<{
  database: DatabaseSync;
  ownerEpoch: number;
  localNowMs: number;
  markTransportCommandApplied(reference: OpaqueInvocationCommandReference): void;
  enqueueInvocationEvent(
    input: Readonly<{
      connectionId: string;
      messageId: string;
      correlationId: string;
      type: WorkerInvocationFact['type'];
      body: unknown;
    }>,
  ): DurableInvocationFactDelivery;
  purgeInvocationPrepareTransportPayload(commandId: string): void;
  purgeInvocationCommandResponse(commandId: string): void;
  purgeInvocationDeliveryWire(deliveryMessageId: string): void;
}>;

export interface WorkerInvocationJournalHost {
  transact<T>(
    input: Readonly<{
      name: string;
      installationId: string;
      ownerToken: string;
      signal: AbortSignal;
    }>,
    operation: (context: WorkerInvocationJournalTransactionContext) => T,
  ): T;
  inspect<T>(operation: (database: DatabaseSync) => T): T;
  checkpointSensitivePrune(): void;
}

export type DurablePreparedInvocation = Readonly<{
  invocationId: string;
  conversationId: string;
  prepareCommandId: string;
  sourceEventId: string;
  factDigest: string;
  state: 'PREPARED';
}>;

export type OpaqueHostDispatchPermit = Readonly<{
  invocationId: string;
  conversationId: string;
  startCommandId: string;
  dispatchNonce: string;
  agentVersionId: string;
  agentVersionDigest: string;
  snapshotDigest: string;
  requestDigest: string;
  executionCapabilityDigest: string;
  deadlineAt: string;
}>;

type OneUseHostInvocationInput = Readonly<{
  invocationId: string;
  conversationId: string;
  startCommandId: string;
  dispatchNonce: string;
  requestDigest: string;
  executionCapability: ExecutionCapability;
  executionCapabilityBinding: ExpectedExecutionCapabilityBinding;
  executionCapabilityDigest: string;
  capabilityNotBeforeMs: number;
  capabilityExpiresAtMs: number;
  commandDeadlineAtMs: number;
  takeCloudNowMs: number;
  userMessage: Uint8Array;
}>;

type PreHostDispatchAuthorization =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code: 'EXECUTION_CAPABILITY_INVALID' | 'INVOCATION_DEADLINE_EXPIRED';
      cloudNow: Date;
    }>;

type PermanentStartRejection = Readonly<{
  action: 'REJECT_PERMANENT';
  code: 'INVOCATION_DEADLINE_EXPIRED' | 'EXECUTION_CAPABILITY_INVALID' | 'START_COMMAND_CONFLICT';
  disposition: 'EXPIRED' | 'SECURITY_BLOCK';
}>;

export type StartInvocationDecision =
  | Readonly<{ action: 'DISPATCH_ONCE'; permit: OpaqueHostDispatchPermit }>
  | Readonly<{ action: 'RETURN_IN_PROGRESS'; state: string }>
  | Readonly<{ action: 'UNCERTAIN'; sourceEventId: string; factDigest: string }>;

export type PendingInvocationFactReference = Readonly<{
  sourceEventId: string;
  invocationId: string;
  eventType: WorkerInvocationFact['type'];
  correlationId: string;
  factDigest: string;
}>;

export type DurableInvocationFactDelivery = Readonly<{
  deliveryMessageId: string;
  sourceEventId: string;
  invocationId: string;
  eventType: WorkerInvocationFact['type'];
  connectionId: string;
  sequence: string;
  canonicalDigest: string;
  factDigest: string;
}>;

export type OpaqueInvocationCloudAckReference = Readonly<{
  connectionId: string;
  sequence: string;
  messageId: string;
  canonicalDigest: string;
  acknowledgedDeliveryMessageId: string;
}>;

type StoredCommand = Readonly<{
  envelope: BrokerCommand;
  effectState: 'PERSISTED' | 'APPLIED';
  connection: ConnectionAuthorityRow;
}>;

type ConnectionAuthorityRow = Readonly<{
  installation_id: string;
  connection_id: string;
  owner_epoch: number;
  deployment_id: string;
  lease_id: string;
  worker_session_id: string;
  fence: string;
  lease_state: 'ACTIVE' | 'REVOKED';
  lease_expires_at: string;
  status: 'ACTIVE' | 'RELEASED';
}>;

type InvocationRow = Record<string, unknown> & {
  invocation_id: string;
  conversation_id: string;
  installation_id: string;
  client_message_id: string;
  request_digest: string;
  prompt_ciphertext: string | null;
  local_prompt_cipher_digest: string;
  prompt_released_at_ms: number | null;
  prompt_purged_at_ms: number | null;
  host_prompt_release_count: number;
  agent_version_id: string;
  agent_version_digest: string;
  snapshot_digest: string;
  deployment_id: string;
  lease_id: string;
  worker_session_id: string;
  fence: string;
  execution_capability_id: string;
  execution_capability_digest: string;
  execution_capability_json: string;
  execution_capability_binding_json: string;
  capability_not_before_ms: number;
  capability_expires_at_ms: number;
  command_deadline_at_ms: number;
  prepare_command_id: string;
  prepare_semantic_digest: string;
  prepared_source_event_id: string;
  prepared_fact_digest: string;
  start_command_id: string | null;
  dispatch_nonce: string | null;
  runtime_turn_id: string | null;
  dispatch_receipt_digest: string | null;
  sandbox_attestation_digest: string | null;
  started_source_event_id: string | null;
  started_fact_digest: string | null;
  result_digest: string | null;
  result_ciphertext: string | null;
  local_result_cipher_digest: string | null;
  result_source_event_id: string | null;
  result_fact_digest: string | null;
  terminal_source_event_id: string | null;
  terminal_fact_digest: string | null;
  state: string;
  created_at_ms: number;
  updated_at_ms: number;
};

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_MAX_INVOCATIONS = 10_000;
const DEFAULT_MAX_PENDING_FACTS = 2_000;
const MAX_RETAINED_CONSUMED_COMMANDS = 100_000;
const MAX_RETAINED_INVOCATION_DELIVERIES = 100_000;

/**
 * Capability-bound business journal. It never opens SQLite itself; its host is the already-open
 * Broker durable transport, so every command effect and business fact shares one transaction.
 */
export class SqliteWorkerInvocationJournal {
  readonly #capabilityAuthority: WorkerInvocationCapabilityAuthorityPort;
  readonly #readyConversationAuthority: ReadyConversationAuthorityPort;
  readonly #hostDispatchPort: TrustedHostDispatchPort;
  readonly #hostDispatchReceiptAuthority: HostDispatchReceiptAuthorityPort;
  readonly #localPromptAeadAuthority: LocalPromptAeadAuthorityPort;
  readonly #localResultAeadAuthority: LocalResultAeadAuthorityPort;
  readonly #brokerResultReencryptAuthority: BrokerResultReencryptAuthorityPort;
  readonly #cloudAckAuthority: CloudInvocationAckAuthorityPort;
  readonly #cloudClock: TrustedCloudClockPort;
  readonly #dispatchNonceFactory: () => string;
  readonly #maxInvocations: number;
  readonly #maxPendingFacts: number;

  constructor(
    private readonly host: WorkerInvocationJournalHost,
    options: SqliteWorkerInvocationJournalOptions,
  ) {
    this.#capabilityAuthority = options.capabilityAuthority;
    this.#readyConversationAuthority = options.readyConversationAuthority;
    this.#hostDispatchPort = options.hostDispatchPort;
    this.#hostDispatchReceiptAuthority = options.hostDispatchReceiptAuthority;
    this.#localPromptAeadAuthority = options.localPromptAeadAuthority;
    this.#localResultAeadAuthority = options.localResultAeadAuthority;
    this.#brokerResultReencryptAuthority = options.brokerResultReencryptAuthority;
    this.#cloudAckAuthority = options.cloudAckAuthority;
    this.#cloudClock = options.cloudClock;
    this.#dispatchNonceFactory = options.dispatchNonceFactory ?? uuidV7;
    this.#maxInvocations = boundedCapacity(
      options.maxInvocations ?? DEFAULT_MAX_INVOCATIONS,
      1,
      100_000,
    );
    this.#maxPendingFacts = boundedCapacity(
      options.maxPendingFacts ?? DEFAULT_MAX_PENDING_FACTS,
      3,
      10_000,
    );
    this.host.inspect((database) => this.#verifyPersistedCapabilities(database));
    this.host.inspect((database) => this.#verifyPersistedPromptAead(database));
    this.host.inspect((database) => this.#verifyPersistedResultAead(database));
  }

  async bindReadyConversation(input: {
    installationId: string;
    ownerToken: string;
    command: OpaqueInvocationCommandReference;
    evidence: unknown;
    signal: AbortSignal;
  }): Promise<ReadyConversationExpectedBinding> {
    return this.host.transact(
      { ...input, name: 'invocation_bind_ready_conversation' },
      (context) => {
        const now = this.#cloudNow();
        const stored = loadStoredCommand(context, input.installationId, input.command);
        if (stored.envelope.type !== 'conversation.open') {
          throw new WorkerInvocationJournalError('COMMAND_TYPE_INVALID');
        }
        assertLiveCommand(stored, now);
        const expected = Object.freeze({
          installationId: input.installationId,
          deploymentId: stored.envelope.lease.deploymentId,
          leaseId: stored.envelope.lease.leaseId,
          workerSessionId: stored.envelope.lease.workerSessionId,
          fence: stored.envelope.lease.fence,
          conversationId: stored.envelope.body.conversationId,
          agentVersionId: stored.envelope.body.agentVersionId,
          agentVersionDigest: stored.envelope.body.agentVersionDigest,
          snapshotDigest: stored.envelope.body.snapshotDigest,
          openCommandId: stored.envelope.messageId,
        });
        let evidence: VerifiedReadyConversationEvidence;
        try {
          evidence = this.#readyConversationAuthority.verify(input.evidence, expected, now);
          assertUuid(evidence.sandboxInstanceId);
          assertNonSecretIdentifier(evidence.runtimeThreadId);
          assertSha256Digest(evidence.evidenceDigest);
        } catch {
          throw new WorkerInvocationJournalError('CONVERSATION_CONFLICT');
        }
        const existing = context.database
          .prepare('SELECT * FROM local_conversations WHERE conversation_id = ?')
          .get(expected.conversationId) as Record<string, unknown> | undefined;
        if (existing !== undefined) {
          if (
            existing.installation_id !== expected.installationId ||
            existing.deployment_id !== expected.deploymentId ||
            existing.agent_version_id !== expected.agentVersionId ||
            existing.agent_version_digest !== expected.agentVersionDigest ||
            existing.snapshot_digest !== expected.snapshotDigest ||
            existing.lease_id !== expected.leaseId ||
            existing.worker_session_id !== expected.workerSessionId ||
            existing.fence !== expected.fence ||
            existing.open_command_id !== expected.openCommandId ||
            existing.sandbox_instance_id !== evidence.sandboxInstanceId ||
            existing.runtime_thread_id !== evidence.runtimeThreadId ||
            existing.ready_evidence_digest !== evidence.evidenceDigest ||
            existing.state !== 'READY'
          ) {
            throw new WorkerInvocationJournalError('CONVERSATION_CONFLICT');
          }
          assertExactConsumedCommand(context.database, input.command, stored.envelope);
          return expected;
        }
        assertCommandPersisted(stored);
        const row = {
          conversation_id: expected.conversationId,
          installation_id: expected.installationId,
          deployment_id: expected.deploymentId,
          agent_version_id: expected.agentVersionId,
          agent_version_digest: expected.agentVersionDigest,
          snapshot_digest: expected.snapshotDigest,
          lease_id: expected.leaseId,
          worker_session_id: expected.workerSessionId,
          fence: expected.fence,
          open_command_id: expected.openCommandId,
          open_connection_id: input.command.connectionId,
          open_sequence: input.command.sequence,
          sandbox_instance_id: evidence.sandboxInstanceId,
          runtime_thread_id: evidence.runtimeThreadId,
          ready_evidence_digest: evidence.evidenceDigest,
          state: 'READY',
          created_at_ms: now.getTime(),
          updated_at_ms: now.getTime(),
        };
        context.database
          .prepare(
            `INSERT INTO local_conversations(
               conversation_id, installation_id, deployment_id, agent_version_id,
               agent_version_digest, snapshot_digest, lease_id, worker_session_id, fence,
               open_command_id, open_connection_id, open_sequence, sandbox_instance_id,
               runtime_thread_id, ready_evidence_digest, state, created_at_ms, updated_at_ms,
               row_digest
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...Object.values(row), sqliteInvocationRowDigest('local_conversations', row));
        insertConsumedCommand(context.database, input.command, stored.envelope, {
          conversationId: expected.conversationId,
          disposition: 'APPLIED',
          consumedAtMs: now.getTime(),
        });
        context.markTransportCommandApplied(input.command);
        return expected;
      },
    );
  }

  async prepare(input: {
    installationId: string;
    ownerToken: string;
    command: OpaqueInvocationCommandReference;
    signal: AbortSignal;
  }): Promise<DurablePreparedInvocation> {
    const result = this.host.transact(
      { ...input, name: 'invocation_prepare' },
      (context): DurablePreparedInvocation | WorkerInvocationJournalErrorCode => {
        const now = this.#cloudNow();
        const retainedReplay = loadPurgedPrepareReplay(
          context.database,
          input.installationId,
          input.command,
        );
        if (retainedReplay !== undefined) {
          this.#verifyPersistedCapability(retainedReplay, new Date(retainedReplay.created_at_ms));
          return preparedReceipt(retainedReplay);
        }
        const stored = loadStoredCommand(context, input.installationId, input.command);
        if (stored.envelope.type !== 'invocation.prepare') return 'COMMAND_TYPE_INVALID';
        try {
          assertCurrentTransportEnvelope(stored, now);
        } catch (error) {
          return journalCode(error);
        }
        const command = stored.envelope;
        const capability = command.body.executionCapability;
        const expected = executionCapabilityBindingFrom(capability);
        const existing = loadInvocation(context.database, command.body.invocationId);
        if (existing !== undefined) {
          if (!samePreparedInvocation(existing, command, executionCapabilityDigest(capability))) {
            consumeSecurityBlocked(context, input.command, command, now.getTime());
            return 'IDEMPOTENCY_CONFLICT';
          }
          try {
            this.#capabilityAuthority.verifyPreviouslyCommitted(
              capability,
              expected,
              existing.execution_capability_digest,
              new Date(existing.created_at_ms),
            );
          } catch {
            return 'EXECUTION_CAPABILITY_INVALID';
          }
          try {
            this.#rewrapPromptCiphertext(command, input.installationId);
          } catch {
            consumeSecurityBlocked(context, input.command, command, now.getTime());
            return 'PROMPT_AEAD_INVALID';
          }
          assertExactConsumedCommand(context.database, input.command, command);
          context.markTransportCommandApplied(input.command);
          context.purgeInvocationPrepareTransportPayload(command.messageId);
          return preparedReceipt(existing);
        }
        try {
          assertLiveCommand(stored, now);
        } catch (error) {
          const code = journalCode(error);
          if (code === 'INVOCATION_DEADLINE_EXPIRED') {
            consumeTerminalCommand(context, input.command, command, now.getTime(), 'EXPIRED');
          }
          return code;
        }
        const conversation = context.database
          .prepare('SELECT * FROM local_conversations WHERE conversation_id = ?')
          .get(command.body.conversationId) as Record<string, unknown> | undefined;
        if (
          conversation === undefined ||
          conversation.state !== 'READY' ||
          conversation.installation_id !== input.installationId ||
          conversation.deployment_id !== command.lease.deploymentId ||
          conversation.agent_version_id !== command.body.agentVersionId ||
          conversation.agent_version_digest !== command.body.agentVersionDigest ||
          conversation.snapshot_digest !== command.body.snapshotDigest
        ) {
          return 'CONVERSATION_NOT_READY';
        }
        if (
          capability.invocationId !== command.body.invocationId ||
          capability.conversationId !== command.body.conversationId ||
          capability.deploymentId !== command.lease.deploymentId ||
          capability.agentVersionId !== command.body.agentVersionId ||
          capability.agentVersionDigest !== command.body.agentVersionDigest ||
          capability.workerInstallationId !== input.installationId ||
          capability.leaseId !== conversation.lease_id ||
          capability.fence !== conversation.fence ||
          capability.requestDigest !== command.body.requestDigest ||
          Date.parse(command.body.deadlineAt) > Date.parse(capability.expiresAt) ||
          Date.parse(command.body.deadlineAt) > Date.parse(stored.connection.lease_expires_at)
        ) {
          consumeSecurityBlocked(context, input.command, command, now.getTime());
          return 'EXECUTION_CAPABILITY_INVALID';
        }
        let verified: Readonly<{ capability: ExecutionCapability; capabilityDigest: string }>;
        try {
          verified = this.#capabilityAuthority.verify(capability, expected, now);
        } catch {
          consumeSecurityBlocked(context, input.command, command, now.getTime());
          return 'EXECUTION_CAPABILITY_INVALID';
        }
        const clientReplay = context.database
          .prepare(
            `SELECT invocation_id FROM local_invocations
             WHERE conversation_id = ? AND client_message_id = ?`,
          )
          .get(command.body.conversationId, command.body.clientMessageId);
        if (clientReplay !== undefined) {
          consumeSecurityBlocked(context, input.command, command, now.getTime());
          return 'CLIENT_MESSAGE_CONFLICT';
        }
        const active = context.database
          .prepare(
            `SELECT invocation_id FROM local_invocations WHERE installation_id = ?
             AND state IN ('PREPARED', 'STARTING', 'RUNNING', 'FINAL_READY') LIMIT 1`,
          )
          .get(input.installationId);
        if (active !== undefined) return 'WORKER_BUSY';
        assertInvocationAdmission(context.database, this.#maxInvocations, this.#maxPendingFacts);
        let promptCiphertext: LocalInvocationPromptCiphertext;
        try {
          promptCiphertext = this.#rewrapPromptCiphertext(command, input.installationId);
        } catch {
          consumeSecurityBlocked(context, input.command, command, now.getTime());
          return 'PROMPT_AEAD_INVALID';
        }
        const sourceEventId = command.messageId;
        const fact = WorkerInvocationPreparedFactSchema.parse({
          protocol: 'combo.worker-invocation-fact/1',
          schemaVersion: 1,
          sourceEventId,
          invocationId: command.body.invocationId,
          agentVersionDigest: command.body.agentVersionDigest,
          snapshotDigest: command.body.snapshotDigest,
          executionCapabilityDigest: verified.capabilityDigest,
          leaseId: capability.leaseId,
          fence: capability.fence,
          type: 'invocation.prepared',
          requestDigest: command.body.requestDigest,
          prepareCommandId: command.messageId,
        });
        const factDigest = workerInvocationFactDigest(fact);
        const row = initialInvocationRow({
          installationId: input.installationId,
          reference: input.command,
          command,
          promptCiphertext,
          capability: verified.capability,
          capabilityDigest: verified.capabilityDigest,
          expected,
          sourceEventId,
          factDigest,
          nowMs: now.getTime(),
        });
        insertInvocation(context.database, row);
        appendFact(context.database, row.invocation_id, command.messageId, null, 'PREPARED', fact, {
          correlationId: command.messageId,
          occurredAtMs: now.getTime(),
        });
        insertConsumedCommand(context.database, input.command, command, {
          conversationId: command.body.conversationId,
          invocationId: command.body.invocationId,
          disposition: 'APPLIED',
          consumedAtMs: now.getTime(),
        });
        context.markTransportCommandApplied(input.command);
        context.purgeInvocationPrepareTransportPayload(command.messageId);
        return preparedReceipt(row);
      },
    );
    if (typeof result === 'string') throw new WorkerInvocationJournalError(result);
    return result;
  }

  async start(input: {
    installationId: string;
    ownerToken: string;
    command: OpaqueInvocationCommandReference;
    signal: AbortSignal;
  }): Promise<StartInvocationDecision> {
    const result = this.host.transact(
      { ...input, name: 'invocation_start' },
      (
        context,
      ): StartInvocationDecision | WorkerInvocationJournalErrorCode | PermanentStartRejection => {
        const now = this.#cloudNow();
        const stored = loadStoredCommand(context, input.installationId, input.command);
        if (stored.envelope.type !== 'invocation.start') return 'COMMAND_TYPE_INVALID';
        const command = stored.envelope;
        const invocation = loadInvocation(context.database, command.body.invocationId);
        if (invocation === undefined) return 'INVOCATION_NOT_FOUND';
        if (
          invocation.installation_id !== input.installationId ||
          invocation.prepare_command_id !== command.body.prepareCommandId ||
          invocation.execution_capability_id !== command.body.executionCapabilityId
        ) {
          consumeSecurityBlocked(context, input.command, command, now.getTime());
          return 'START_COMMAND_CONFLICT';
        }
        if (invocation.start_command_id === null && invocation.state !== 'PREPARED') {
          const consumed = context.database
            .prepare('SELECT 1 FROM local_consumed_commands WHERE command_id = ?')
            .get(command.messageId);
          if (consumed !== undefined) {
            assertExactConsumedCommand(context.database, input.command, command);
            context.markTransportCommandApplied(input.command);
            return Object.freeze({ action: 'RETURN_IN_PROGRESS', state: invocation.state });
          }
          return 'ILLEGAL_LOCAL_TRANSITION';
        }
        if (
          stored.connection.deployment_id !== invocation.deployment_id ||
          command.lease.deploymentId !== invocation.deployment_id
        ) {
          return Object.freeze({
            action: 'REJECT_PERMANENT',
            code: 'START_COMMAND_CONFLICT',
            disposition: 'SECURITY_BLOCK',
          });
        }
        try {
          assertCurrentTransportEnvelope(stored, now);
        } catch (error) {
          const code = journalCode(error);
          if (code === 'STALE_LEASE' || code === 'STALE_FENCE') return code;
          return Object.freeze({
            action: 'REJECT_PERMANENT',
            code: 'INVOCATION_DEADLINE_EXPIRED',
            disposition: 'EXPIRED',
          });
        }
        // A legitimate reconnect inside the same Deployment may use a different outer Lease/Fence.
        // Durable facts keep the original capability Lease/Fence and never rewrite that authority.
        if (invocation.start_command_id !== null) {
          if (invocation.start_command_id !== command.messageId) {
            consumeSecurityBlocked(context, input.command, command, now.getTime());
            return 'START_COMMAND_CONFLICT';
          }
          assertExactConsumedCommand(context.database, input.command, command);
          this.#verifyPersistedCapability(invocation, new Date(invocation.created_at_ms));
          context.markTransportCommandApplied(input.command);
          if (invocation.state === 'STARTING') {
            return this.#markStartUnknown(context.database, invocation, now);
          }
          return Object.freeze({ action: 'RETURN_IN_PROGRESS', state: invocation.state });
        }
        if (invocation.state !== 'PREPARED') return 'ILLEGAL_LOCAL_TRANSITION';
        try {
          assertLiveCommand(stored, now);
          assertInvocationDeadline(invocation, now);
          this.#verifyCurrentPersistedCapability(invocation, now);
        } catch (error) {
          const code = journalCode(error);
          if (code === 'STALE_LEASE' || code === 'STALE_FENCE') return code;
          return Object.freeze({
            action: 'REJECT_PERMANENT',
            code:
              code === 'EXECUTION_CAPABILITY_INVALID'
                ? 'EXECUTION_CAPABILITY_INVALID'
                : 'INVOCATION_DEADLINE_EXPIRED',
            disposition: code === 'EXECUTION_CAPABILITY_INVALID' ? 'SECURITY_BLOCK' : 'EXPIRED',
          });
        }
        if (
          invocation.prompt_ciphertext === null ||
          invocation.prompt_purged_at_ms !== null ||
          invocation.prompt_released_at_ms !== null ||
          invocation.host_prompt_release_count !== 0
        ) {
          return 'PROMPT_AEAD_INVALID';
        }
        assertCommandPersisted(stored);
        const dispatchNonce = this.#dispatchNonce();
        context.database
          .prepare(
            `UPDATE local_invocations SET
               start_command_id = ?, start_connection_id = ?, start_sequence = ?,
               start_canonical_digest = ?, dispatch_nonce = ?, dispatch_permit_issued_at_ms = ?,
               host_dispatch_intent_count = 1, state = 'STARTING', updated_at_ms = ?
             WHERE invocation_id = ? AND state = 'PREPARED' AND start_command_id IS NULL`,
          )
          .run(
            command.messageId,
            input.command.connectionId,
            input.command.sequence,
            input.command.canonicalDigest,
            dispatchNonce,
            now.getTime(),
            now.getTime(),
            invocation.invocation_id,
          );
        refreshMutableRowDigest(
          context.database,
          'local_invocations',
          'invocation_id',
          invocation.invocation_id,
        );
        appendLocalEvent(context.database, {
          invocationId: invocation.invocation_id,
          commandId: command.messageId,
          eventType: 'local.invocation.starting',
          fromState: 'PREPARED',
          toState: 'STARTING',
          occurredAtMs: now.getTime(),
        });
        insertConsumedCommand(context.database, input.command, command, {
          conversationId: invocation.conversation_id,
          invocationId: invocation.invocation_id,
          disposition: 'APPLIED',
          consumedAtMs: now.getTime(),
        });
        context.markTransportCommandApplied(input.command);
        return Object.freeze({
          action: 'DISPATCH_ONCE',
          permit: Object.freeze({
            invocationId: invocation.invocation_id,
            conversationId: invocation.conversation_id,
            startCommandId: command.messageId,
            dispatchNonce,
            agentVersionId: invocation.agent_version_id,
            agentVersionDigest: invocation.agent_version_digest,
            snapshotDigest: invocation.snapshot_digest,
            requestDigest: invocation.request_digest,
            executionCapabilityDigest: invocation.execution_capability_digest,
            deadlineAt: new Date(invocation.command_deadline_at_ms).toISOString(),
          }),
        });
      },
    );
    if (typeof result === 'object' && result.action === 'REJECT_PERMANENT') {
      this.#rejectStartPermanently(input, result);
      throw new WorkerInvocationJournalError(result.code);
    }
    if (typeof result === 'string') throw new WorkerInvocationJournalError(result);
    return result;
  }

  #rejectStartPermanently(
    input: Readonly<{
      installationId: string;
      ownerToken: string;
      command: OpaqueInvocationCommandReference;
      signal: AbortSignal;
    }>,
    rejection: PermanentStartRejection,
  ): void {
    const result = this.host.transact(
      {
        ...input,
        name: 'invocation_reject_start_permanently',
        signal: new AbortController().signal,
      },
      (context): WorkerInvocationJournalErrorCode | undefined => {
        const now = this.#cloudNow();
        const stored = loadStoredCommand(context, input.installationId, input.command);
        if (stored.envelope.type !== 'invocation.start') return 'COMMAND_TYPE_INVALID';
        const command = stored.envelope;
        const invocation = loadInvocation(context.database, command.body.invocationId);
        if (invocation === undefined) return 'INVOCATION_NOT_FOUND';
        try {
          assertCurrentTransportEnvelope(stored, now);
        } catch (error) {
          const code = journalCode(error);
          if (code === 'STALE_LEASE' || code === 'STALE_FENCE') return code;
        }
        if (
          invocation.installation_id !== input.installationId ||
          invocation.prepare_command_id !== command.body.prepareCommandId ||
          invocation.execution_capability_id !== command.body.executionCapabilityId
        ) {
          consumeSecurityBlocked(context, input.command, command, now.getTime());
          return 'START_COMMAND_CONFLICT';
        }
        if (invocation.state !== 'PREPARED') return 'ILLEGAL_LOCAL_TRANSITION';
        const sourceEventId = invocation.invocation_id;
        const fact = WorkerInvocationFactSchema.parse({
          ...factBase(invocation, sourceEventId),
          type: 'invocation.failed',
          errorCode: rejection.code,
        });
        const factDigest = workerInvocationFactDigest(fact);
        const nowMs = now.getTime();
        const updated = context.database
          .prepare(
            `UPDATE local_invocations SET terminal_source_event_id = ?, terminal_fact_digest = ?,
                 prompt_ciphertext = NULL, prompt_purged_at_ms = COALESCE(prompt_purged_at_ms, ?),
                 state = 'FAILED', updated_at_ms = ?
               WHERE invocation_id = ? AND state = 'PREPARED' AND start_command_id IS NULL`,
          )
          .run(sourceEventId, factDigest, nowMs, nowMs, invocation.invocation_id);
        if (Number(updated.changes) !== 1) return 'ILLEGAL_LOCAL_TRANSITION';
        refreshMutableRowDigest(
          context.database,
          'local_invocations',
          'invocation_id',
          invocation.invocation_id,
        );
        appendFact(
          context.database,
          invocation.invocation_id,
          command.messageId,
          'PREPARED',
          'FAILED',
          fact,
          { correlationId: invocation.invocation_id, occurredAtMs: nowMs },
        );
        consumeTerminalCommand(context, input.command, command, nowMs, rejection.disposition);
        return undefined;
      },
    );
    if (result !== undefined) throw new WorkerInvocationJournalError(result);
  }

  /**
   * The only public Host boundary. Plaintext is passed directly to the injected trusted Host port,
   * never returned to callers; a failed/ambiguous Host call is terminally UNCERTAIN and not retried.
   */
  async dispatchOnce(input: {
    installationId: string;
    ownerToken: string;
    permit: OpaqueHostDispatchPermit;
    signal: AbortSignal;
  }): Promise<Readonly<{ sourceEventId: string; factDigest: string; runtimeTurnId: string }>> {
    // `#takeHostInvocationInput` is deliberately synchronous: it includes SQLite COMMIT, the
    // external watermark fsync and sensitive checkpoint. The fresh Cloud-time/capability check
    // below and the call into the trusted Host therefore share one JavaScript turn with no await
    // or microtask boundary in between.
    const hostInput = this.#takeHostInvocationInput(input);
    const authorization = this.#authorizeImmediateHostDispatch(hostInput);
    if (!authorization.ok) {
      try {
        this.#recordPreHostDispatchRejection(input, hostInput, authorization);
      } finally {
        hostInput.userMessage.fill(0);
      }
      throw new WorkerInvocationJournalError(authorization.code);
    }
    try {
      // Calling the port (and thus crossing the Host boundary) happens synchronously here. Only
      // the returned receipt promise is awaited; any failure from this point is conservatively
      // ambiguous and becomes UNCERTAIN.
      const receiptPromise = this.#hostDispatchPort.dispatchOnce(
        { permit: input.permit, userMessage: hostInput.userMessage },
        input.signal,
      );
      const receipt = await receiptPromise;
      return await this.confirmHostDispatch({
        installationId: input.installationId,
        ownerToken: input.ownerToken,
        invocationId: hostInput.invocationId,
        dispatchNonce: hostInput.dispatchNonce,
        sourceEventId: hostInput.startCommandId,
        receipt,
        signal: input.signal,
      });
    } catch (error) {
      await this.#recordDispatchUnknown(
        { ...input, signal: new AbortController().signal },
        hostInput,
      );
      throw error;
    } finally {
      hostInput.userMessage.fill(0);
    }
  }

  /** CAS phase preceding the external Host call; never exposed outside this class. */
  #takeHostInvocationInput(input: {
    installationId: string;
    ownerToken: string;
    permit: OpaqueHostDispatchPermit;
    signal: AbortSignal;
  }): OneUseHostInvocationInput {
    let releasedPlaintext: Uint8Array | undefined;
    try {
      return this.host.transact(
        { ...input, name: 'invocation_take_host_prompt' },
        (context): OneUseHostInvocationInput => {
          const now = this.#cloudNow();
          const invocation = loadInvocation(context.database, input.permit.invocationId);
          if (invocation === undefined) {
            throw new WorkerInvocationJournalError('INVOCATION_NOT_FOUND');
          }
          if (
            invocation.installation_id !== input.installationId ||
            invocation.state !== 'STARTING' ||
            invocation.prompt_ciphertext === null ||
            invocation.prompt_purged_at_ms !== null ||
            invocation.prompt_released_at_ms !== null ||
            invocation.host_prompt_release_count !== 0 ||
            !hostDispatchPermitMatches(input.permit, invocation)
          ) {
            throw new WorkerInvocationJournalError('PROMPT_AEAD_INVALID');
          }
          const persistedCapability = this.#verifyCurrentPersistedCapability(invocation, now);
          assertInvocationDeadline(invocation, now);
          let opened: Readonly<{
            ciphertext: LocalInvocationPromptCiphertext;
            plaintext: Uint8Array;
            requestDigest: string;
          }>;
          try {
            opened = this.#openPromptCiphertext(
              JSON.parse(invocation.prompt_ciphertext) as LocalInvocationPromptCiphertext,
              localPromptAadFromInvocation(invocation),
              invocation.request_digest,
            );
            if (opened.ciphertext.cipherDigest !== invocation.local_prompt_cipher_digest) {
              throw new Error('local-prompt-cipher-digest');
            }
          } catch {
            throw new WorkerInvocationJournalError('PROMPT_AEAD_INVALID');
          }
          const updated = context.database
            .prepare(
              `UPDATE local_invocations SET prompt_released_at_ms = ?,
               host_prompt_release_count = 1, updated_at_ms = ?
             WHERE invocation_id = ? AND state = 'STARTING'
               AND prompt_ciphertext IS NOT NULL AND prompt_released_at_ms IS NULL
               AND host_prompt_release_count = 0`,
            )
            .run(now.getTime(), now.getTime(), invocation.invocation_id);
          if (Number(updated.changes) !== 1) {
            opened.plaintext.fill(0);
            throw new WorkerInvocationJournalError('PROMPT_AEAD_INVALID');
          }
          refreshMutableRowDigest(
            context.database,
            'local_invocations',
            'invocation_id',
            invocation.invocation_id,
          );
          releasedPlaintext = opened.plaintext;
          return Object.freeze({
            invocationId: invocation.invocation_id,
            conversationId: invocation.conversation_id,
            startCommandId: String(invocation.start_command_id),
            dispatchNonce: String(invocation.dispatch_nonce),
            requestDigest: opened.requestDigest,
            executionCapability: persistedCapability.capability,
            executionCapabilityBinding: persistedCapability.binding,
            executionCapabilityDigest: invocation.execution_capability_digest,
            capabilityNotBeforeMs: invocation.capability_not_before_ms,
            capabilityExpiresAtMs: invocation.capability_expires_at_ms,
            commandDeadlineAtMs: invocation.command_deadline_at_ms,
            takeCloudNowMs: now.getTime(),
            userMessage: opened.plaintext,
          });
        },
      );
    } catch (error) {
      // The callback can return plaintext before the host transaction finishes its watermark fsync
      // and post-COMMIT checkpoint. If either later step fails, no caller receives the object, so
      // this outer catch is the only deterministic place to zero those bytes.
      releasedPlaintext?.fill(0);
      throw error;
    }
  }

  #authorizeImmediateHostDispatch(
    hostInput: OneUseHostInvocationInput,
  ): PreHostDispatchAuthorization {
    let cloudNow: Date;
    try {
      cloudNow = this.#cloudNow();
    } catch {
      return Object.freeze({
        ok: false,
        code: 'INVOCATION_DEADLINE_EXPIRED',
        cloudNow: new Date(hostInput.takeCloudNowMs),
      });
    }
    try {
      const verified = this.#capabilityAuthority.verify(
        hostInput.executionCapability,
        hostInput.executionCapabilityBinding,
        cloudNow,
      );
      if (
        verified.capabilityDigest !== hostInput.executionCapabilityDigest ||
        canonicalizeJson(verified.capability) !== canonicalizeJson(hostInput.executionCapability) ||
        canonicalizeJson(executionCapabilityBindingFrom(verified.capability)) !==
          canonicalizeJson(hostInput.executionCapabilityBinding)
      ) {
        throw new Error('capability-recheck-binding');
      }
    } catch {
      return Object.freeze({ ok: false, code: 'EXECUTION_CAPABILITY_INVALID', cloudNow });
    }
    if (
      hostInput.capabilityNotBeforeMs > cloudNow.getTime() ||
      hostInput.capabilityExpiresAtMs <= cloudNow.getTime() ||
      hostInput.commandDeadlineAtMs <= cloudNow.getTime()
    ) {
      return Object.freeze({ ok: false, code: 'INVOCATION_DEADLINE_EXPIRED', cloudNow });
    }
    return Object.freeze({ ok: true });
  }

  #recordPreHostDispatchRejection(
    input: Readonly<{
      installationId: string;
      ownerToken: string;
      permit: OpaqueHostDispatchPermit;
      signal: AbortSignal;
    }>,
    hostInput: OneUseHostInvocationInput,
    authorization: Extract<PreHostDispatchAuthorization, { ok: false }>,
  ): void {
    this.host.transact(
      {
        ...input,
        name: 'invocation_reject_host_dispatch',
        // Authorization failure is a required local cleanup even if the caller's request signal
        // raced with the durable one-use CAS.
        signal: new AbortController().signal,
      },
      (context): void => {
        const invocation = loadInvocation(context.database, hostInput.invocationId);
        if (invocation === undefined) {
          throw new WorkerInvocationJournalError('INVOCATION_NOT_FOUND');
        }
        if (
          invocation.installation_id !== input.installationId ||
          invocation.dispatch_nonce !== hostInput.dispatchNonce ||
          invocation.start_command_id !== hostInput.startCommandId ||
          invocation.state !== 'STARTING' ||
          invocation.runtime_turn_id !== null ||
          invocation.host_prompt_release_count !== 1 ||
          invocation.prompt_released_at_ms === null
        ) {
          throw new WorkerInvocationJournalError('ILLEGAL_LOCAL_TRANSITION');
        }
        const sourceEventId = invocation.invocation_id;
        const fact = WorkerInvocationFactSchema.parse({
          ...factBase(invocation, sourceEventId),
          type: 'invocation.failed',
          errorCode: authorization.code,
        });
        const factDigest = workerInvocationFactDigest(fact);
        const nowMs = authorization.cloudNow.getTime();
        const updated = context.database
          .prepare(
            `UPDATE local_invocations SET terminal_source_event_id = ?, terminal_fact_digest = ?,
                 prompt_ciphertext = NULL, prompt_purged_at_ms = COALESCE(prompt_purged_at_ms, ?),
                 state = 'FAILED', updated_at_ms = ?
               WHERE invocation_id = ? AND state = 'STARTING' AND runtime_turn_id IS NULL`,
          )
          .run(sourceEventId, factDigest, nowMs, nowMs, invocation.invocation_id);
        if (Number(updated.changes) !== 1) {
          throw new WorkerInvocationJournalError('ILLEGAL_LOCAL_TRANSITION');
        }
        refreshMutableRowDigest(
          context.database,
          'local_invocations',
          'invocation_id',
          invocation.invocation_id,
        );
        appendFact(
          context.database,
          invocation.invocation_id,
          invocation.start_command_id,
          'STARTING',
          'FAILED',
          fact,
          { correlationId: invocation.invocation_id, occurredAtMs: nowMs },
        );
      },
    );
  }

  async #recordDispatchUnknown(
    input: Readonly<{
      installationId: string;
      ownerToken: string;
      permit: OpaqueHostDispatchPermit;
      signal: AbortSignal;
    }>,
    hostInput: OneUseHostInvocationInput,
  ): Promise<void> {
    this.host.transact(
      { ...input, name: 'invocation_record_dispatch_unknown' },
      (context): void => {
        const invocation = loadInvocation(context.database, hostInput.invocationId);
        if (invocation === undefined) {
          throw new WorkerInvocationJournalError('INVOCATION_NOT_FOUND');
        }
        if (
          invocation.installation_id !== input.installationId ||
          invocation.dispatch_nonce !== hostInput.dispatchNonce ||
          invocation.start_command_id !== hostInput.startCommandId
        ) {
          throw new WorkerInvocationJournalError('HOST_RECEIPT_INVALID');
        }
        if (invocation.state === 'RUNNING' || invocation.state === 'UNCERTAIN') return;
        if (invocation.state !== 'STARTING') {
          throw new WorkerInvocationJournalError('ILLEGAL_LOCAL_TRANSITION');
        }
        this.#markStartUnknown(context.database, invocation, this.#cloudNow());
      },
    );
  }

  async recoverUnconfirmedStarts(input: {
    installationId: string;
    ownerToken: string;
    signal: AbortSignal;
  }): Promise<number> {
    return this.host.transact(
      { ...input, name: 'invocation_recover_unconfirmed_start' },
      (context) => {
        const rows = context.database
          .prepare(
            `SELECT * FROM local_invocations
             WHERE installation_id = ? AND state = 'STARTING' AND runtime_turn_id IS NULL`,
          )
          .all(input.installationId) as InvocationRow[];
        for (const row of rows) this.#markStartUnknown(context.database, row, this.#cloudNow());
        return rows.length;
      },
    );
  }

  async confirmHostDispatch(input: {
    installationId: string;
    ownerToken: string;
    invocationId: string;
    dispatchNonce: string;
    sourceEventId: string;
    receipt: unknown;
    signal: AbortSignal;
  }): Promise<Readonly<{ sourceEventId: string; factDigest: string; runtimeTurnId: string }>> {
    return this.host.transact({ ...input, name: 'invocation_confirm_host_dispatch' }, (context) => {
      const now = this.#cloudNow();
      assertUuid(input.invocationId);
      assertUuid(input.dispatchNonce);
      assertUuid(input.sourceEventId);
      const invocation = loadInvocation(context.database, input.invocationId);
      if (invocation === undefined) throw new WorkerInvocationJournalError('INVOCATION_NOT_FOUND');
      if (
        invocation.installation_id !== input.installationId ||
        invocation.dispatch_nonce !== input.dispatchNonce ||
        invocation.start_command_id === null ||
        input.sourceEventId !== invocation.start_command_id ||
        invocation.host_prompt_release_count !== 1 ||
        invocation.prompt_released_at_ms === null
      ) {
        throw new WorkerInvocationJournalError('HOST_RECEIPT_INVALID');
      }
      const conversation = requireConversation(context.database, invocation.conversation_id);
      const verifyReceipt = (at: Date): VerifiedHostDispatchReceipt => {
        try {
          const receipt = this.#hostDispatchReceiptAuthority.verify(
            input.receipt,
            {
              installationId: input.installationId,
              invocationId: invocation.invocation_id,
              conversationId: invocation.conversation_id,
              startCommandId: String(invocation.start_command_id),
              dispatchNonce: input.dispatchNonce,
              agentVersionId: invocation.agent_version_id,
              agentVersionDigest: invocation.agent_version_digest,
              snapshotDigest: invocation.snapshot_digest,
              sandboxInstanceId: String(conversation.sandbox_instance_id),
            },
            at,
          );
          assertNonSecretIdentifier(receipt.runtimeTurnId);
          assertSha256Digest(receipt.dispatchReceiptDigest);
          assertSha256Digest(receipt.sandboxAttestationDigest);
          return receipt;
        } catch {
          throw new WorkerInvocationJournalError('HOST_RECEIPT_INVALID');
        }
      };
      if (invocation.runtime_turn_id !== null) {
        this.#verifyPersistedCapability(invocation, new Date(invocation.created_at_ms));
        const receipt = verifyReceipt(new Date(Number(invocation.prompt_released_at_ms)));
        if (
          invocation.started_source_event_id !== input.sourceEventId ||
          invocation.runtime_turn_id !== receipt.runtimeTurnId ||
          invocation.dispatch_receipt_digest !== receipt.dispatchReceiptDigest ||
          invocation.sandbox_attestation_digest !== receipt.sandboxAttestationDigest
        ) {
          throw new WorkerInvocationJournalError('HOST_RECEIPT_INVALID');
        }
        return Object.freeze({
          sourceEventId: input.sourceEventId,
          factDigest: String(invocation.started_fact_digest),
          runtimeTurnId: invocation.runtime_turn_id,
        });
      }
      this.#verifyCurrentPersistedCapability(invocation, now);
      const receipt = verifyReceipt(now);
      if (invocation.state !== 'STARTING') {
        throw new WorkerInvocationJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      const fact = WorkerInvocationStartedFactSchema.parse({
        ...factBase(invocation, input.sourceEventId),
        type: 'invocation.started',
        startCommandId: invocation.start_command_id,
        runtimeThreadId: String(conversation.runtime_thread_id),
        runtimeTurnId: receipt.runtimeTurnId,
        dispatchReceiptDigest: receipt.dispatchReceiptDigest,
        sandboxAttestationDigest: receipt.sandboxAttestationDigest,
      });
      const factDigest = workerInvocationFactDigest(fact);
      context.database
        .prepare(
          `UPDATE local_invocations SET runtime_turn_id = ?, dispatch_receipt_digest = ?,
               sandbox_attestation_digest = ?, started_source_event_id = ?, started_fact_digest = ?,
               prompt_ciphertext = NULL, prompt_purged_at_ms = ?,
               host_dispatch_confirmed_count = 1, state = 'RUNNING', updated_at_ms = ?
             WHERE invocation_id = ? AND state = 'STARTING' AND runtime_turn_id IS NULL`,
        )
        .run(
          receipt.runtimeTurnId,
          receipt.dispatchReceiptDigest,
          receipt.sandboxAttestationDigest,
          input.sourceEventId,
          factDigest,
          now.getTime(),
          now.getTime(),
          invocation.invocation_id,
        );
      refreshMutableRowDigest(
        context.database,
        'local_invocations',
        'invocation_id',
        invocation.invocation_id,
      );
      appendFact(
        context.database,
        invocation.invocation_id,
        invocation.start_command_id,
        'STARTING',
        'RUNNING',
        fact,
        { correlationId: invocation.start_command_id, occurredAtMs: now.getTime() },
      );
      return Object.freeze({
        sourceEventId: input.sourceEventId,
        factDigest,
        runtimeTurnId: receipt.runtimeTurnId,
      });
    });
  }

  async writeSucceeded(input: {
    installationId: string;
    ownerToken: string;
    invocationId: string;
    dispatchNonce: string;
    sourceEventId: string;
    resultCiphertext: LocalInvocationResultCiphertext;
    signal: AbortSignal;
  }): Promise<Readonly<{ sourceEventId: string; factDigest: string }>> {
    return this.host.transact({ ...input, name: 'invocation_write_succeeded' }, (context) => {
      const now = this.#cloudNow();
      assertUuid(input.invocationId);
      assertUuid(input.dispatchNonce);
      assertUuid(input.sourceEventId);
      if ('resultDigest' in input) throw new WorkerInvocationJournalError('FINAL_CONFLICT');
      const invocation = loadInvocation(context.database, input.invocationId);
      if (invocation === undefined) throw new WorkerInvocationJournalError('INVOCATION_NOT_FOUND');
      if (
        invocation.installation_id !== input.installationId ||
        invocation.dispatch_nonce !== input.dispatchNonce ||
        input.sourceEventId !== invocation.invocation_id
      ) {
        throw new WorkerInvocationJournalError('FINAL_CONFLICT');
      }
      const verified = this.#verifyResultCiphertext(
        input.resultCiphertext,
        invocation,
        input.sourceEventId,
      );
      if (invocation.result_digest !== null) {
        this.#verifyPersistedCapability(invocation, new Date(invocation.created_at_ms));
        if (
          invocation.result_digest !== verified.resultDigest ||
          invocation.result_source_event_id !== input.sourceEventId ||
          invocation.result_ciphertext !== canonicalizeJson(verified.ciphertext) ||
          invocation.local_result_cipher_digest !== verified.ciphertext.cipherDigest
        ) {
          throw new WorkerInvocationJournalError('FINAL_CONFLICT');
        }
        return Object.freeze({
          sourceEventId: input.sourceEventId,
          factDigest: String(invocation.result_fact_digest),
        });
      }
      this.#verifyCurrentPersistedCapability(invocation, now);
      if (invocation.state !== 'RUNNING') {
        throw new WorkerInvocationJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      const fact = WorkerInvocationSucceededFactSchema.parse({
        ...factBase(invocation, input.sourceEventId),
        type: 'invocation.succeeded',
        runtimeThreadId: String(
          requireConversation(context.database, invocation.conversation_id).runtime_thread_id,
        ),
        runtimeTurnId: String(invocation.runtime_turn_id),
        startedFactDigest: String(invocation.started_fact_digest),
        resultDigest: verified.resultDigest,
        localResultCipherDigest: verified.ciphertext.cipherDigest,
      });
      const factDigest = workerInvocationFactDigest(fact);
      context.database
        .prepare(
          `UPDATE local_invocations SET result_digest = ?, result_ciphertext = ?,
               local_result_cipher_digest = ?, result_source_event_id = ?, result_fact_digest = ?,
               terminal_source_event_id = ?, terminal_fact_digest = ?, state = 'FINAL_READY',
               updated_at_ms = ?
             WHERE invocation_id = ? AND state = 'RUNNING' AND result_digest IS NULL`,
        )
        .run(
          verified.resultDigest,
          canonicalizeJson(verified.ciphertext),
          verified.ciphertext.cipherDigest,
          input.sourceEventId,
          factDigest,
          input.sourceEventId,
          factDigest,
          now.getTime(),
          invocation.invocation_id,
        );
      refreshMutableRowDigest(
        context.database,
        'local_invocations',
        'invocation_id',
        invocation.invocation_id,
      );
      appendFact(
        context.database,
        invocation.invocation_id,
        invocation.start_command_id,
        'RUNNING',
        'FINAL_READY',
        fact,
        { correlationId: invocation.invocation_id, occurredAtMs: now.getTime() },
      );
      return Object.freeze({ sourceEventId: input.sourceEventId, factDigest });
    });
  }

  /**
   * Exact-read a pending durable fact, re-encrypt a local result only for the current Broker
   * session, and enqueue the wire event in the same SQLite transaction as its delivery binding.
   */
  async enqueuePendingFact(input: {
    installationId: string;
    ownerToken: string;
    reference: PendingInvocationFactReference;
    connectionId: string;
    deliveryMessageId: string;
    brokerKeyId?: string;
    signal: AbortSignal;
  }): Promise<DurableInvocationFactDelivery> {
    return this.host.transact({ ...input, name: 'invocation_enqueue_pending_fact' }, (context) => {
      assertUuid(input.connectionId);
      assertUuid(input.deliveryMessageId);
      if (input.deliveryMessageId === input.reference.sourceEventId) {
        throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
      }
      const outbox = loadExactPendingOutbox(
        context.database,
        input.installationId,
        input.reference,
      );
      const existing = activeDeliveryForSource(context.database, outbox.source_event_id);
      if (existing !== undefined) return existing;
      assertRetainedRowCapacity(
        context.database,
        'local_invocation_deliveries',
        MAX_RETAINED_INVOCATION_DELIVERIES,
      );
      const fact = WorkerInvocationFactSchema.parse(JSON.parse(outbox.fact_json));
      const invocation = loadInvocation(context.database, fact.invocationId);
      if (invocation === undefined) throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
      const cloudNow = this.#cloudNow();
      const connection = currentConnectionForDelivery(
        context.database,
        input.installationId,
        input.connectionId,
        context.ownerEpoch,
        cloudNow,
      );
      if (connection.deployment_id !== invocation.deployment_id) {
        throw new WorkerInvocationJournalError('STALE_LEASE');
      }
      let body: Record<string, unknown> = { ...fact, factDigest: outbox.fact_digest };
      if (fact.type === 'invocation.succeeded') {
        if (input.brokerKeyId === undefined) {
          throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
        }
        if (invocation.result_ciphertext === null) {
          throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
        }
        const local = this.#verifyResultCiphertext(
          JSON.parse(invocation.result_ciphertext) as LocalInvocationResultCiphertext,
          invocation,
          fact.sourceEventId,
        );
        if (local.resultDigest !== fact.resultDigest) {
          throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
        }
        const brokerAad: BrokerSensitiveMessageAad = {
          protocol: 'combo.creator-broker/1',
          schemaVersion: 1,
          envelopeType: 'invocation.succeeded',
          messageId: input.deliveryMessageId,
          conversationId: invocation.conversation_id,
          invocationId: invocation.invocation_id,
          workerSessionId: connection.worker_session_id,
          role: 'ASSISTANT',
          keyId: input.brokerKeyId,
        };
        let brokerCiphertext: BrokerSensitiveMessage;
        try {
          const reencrypted = this.#brokerResultReencryptAuthority.reencrypt({
            localCiphertext: local.ciphertext,
            localAad: local.ciphertext.aad,
            brokerAad,
          });
          brokerCiphertext = BrokerSensitiveMessageSchema.parse(reencrypted.ciphertext);
          if (
            canonicalizeJson(brokerCiphertext.aad) !== canonicalizeJson(brokerAad) ||
            parseHmacSha256(reencrypted.resultDigest) !== local.resultDigest
          ) {
            throw new Error('broker-aad');
          }
        } catch {
          throw new WorkerInvocationJournalError('FINAL_AEAD_INVALID');
        }
        body = {
          ...body,
          conversationId: invocation.conversation_id,
          resultCiphertext: brokerCiphertext,
        };
      } else if (input.brokerKeyId !== undefined) {
        throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
      }
      const delivery = context.enqueueInvocationEvent({
        connectionId: input.connectionId,
        messageId: input.deliveryMessageId,
        correlationId: outbox.correlation_id,
        type: fact.type,
        body,
      });
      const row = {
        delivery_message_id: delivery.deliveryMessageId,
        source_event_id: fact.sourceEventId,
        invocation_id: fact.invocationId,
        connection_id: delivery.connectionId,
        sequence: delivery.sequence,
        canonical_digest: delivery.canonicalDigest,
        event_type: fact.type,
        fact_digest: outbox.fact_digest,
        created_at_ms: cloudNow.getTime(),
      };
      context.database
        .prepare(
          `INSERT INTO local_invocation_deliveries(
             delivery_message_id, source_event_id, invocation_id, connection_id, sequence,
             canonical_digest, event_type, fact_digest, created_at_ms, row_digest
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...Object.values(row), sqliteInvocationRowDigest('local_invocation_deliveries', row));
      return Object.freeze({
        ...delivery,
        sourceEventId: fact.sourceEventId,
        factDigest: outbox.fact_digest,
      });
    });
  }

  async readPendingCloudAcks(input: {
    installationId: string;
    ownerToken: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly OpaqueInvocationCloudAckReference[]> {
    const limit = boundedCapacity(input.limit, 1, 128);
    return this.host.transact(
      { ...input, name: 'invocation_read_pending_cloud_acks' },
      (context) => {
        const rows = context.database
          .prepare(
            `SELECT f.connection_id, f.sequence, f.message_id, f.canonical_digest,
                  f.envelope_json, f.acknowledged_message_id
           FROM transport_inbound_frames AS f
           JOIN transport_connections AS c ON c.connection_id = f.connection_id
           JOIN local_invocation_deliveries AS d
             ON d.delivery_message_id = f.acknowledged_message_id
           LEFT JOIN local_invocation_outbox_receipts AS r
             ON r.source_event_id = d.source_event_id
           WHERE c.installation_id = ? AND f.envelope_kind = 'ack'
             AND f.envelope_type = 'message.ack' AND r.source_event_id IS NULL
           ORDER BY f.recorded_at_ms, f.message_id LIMIT ?`,
          )
          .all(input.installationId, limit) as Array<{
          connection_id: string;
          sequence: string;
          message_id: string;
          canonical_digest: string;
          envelope_json: string;
          acknowledged_message_id: string;
        }>;
        return rows.flatMap((row) => {
          if (
            !cloudAckEnvelopeMatches(
              row.envelope_json,
              row.canonical_digest,
              row.acknowledged_message_id,
            )
          ) {
            throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
          }
          const envelope = BrokerEnvelopeSchema.parse(JSON.parse(row.envelope_json));
          if (envelope.kind !== 'ack' || envelope.body.level !== 'CLOUD_COMMITTED') return [];
          return [
            Object.freeze({
              connectionId: row.connection_id,
              sequence: row.sequence,
              messageId: row.message_id,
              canonicalDigest: row.canonical_digest,
              acknowledgedDeliveryMessageId: row.acknowledged_message_id,
            }),
          ];
        });
      },
    );
  }

  async markCloudCommitted(input: {
    installationId: string;
    ownerToken: string;
    ack: OpaqueInvocationCloudAckReference;
    evidence: unknown;
    signal: AbortSignal;
  }): Promise<void> {
    this.host.transact({ ...input, name: 'invocation_mark_cloud_committed' }, (context) => {
      const now = this.#cloudNow();
      const ack = loadExactCloudAck(context.database, input.installationId, input.ack);
      const delivery = context.database
        .prepare(`SELECT * FROM local_invocation_deliveries WHERE delivery_message_id = ?`)
        .get(input.ack.acknowledgedDeliveryMessageId) as Record<string, unknown> | undefined;
      if (delivery === undefined) throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
      const outbox = context.database
        .prepare('SELECT * FROM local_invocation_outbox WHERE source_event_id = ?')
        .get(String(delivery.source_event_id)) as Record<string, unknown> | undefined;
      if (outbox === undefined) throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
      const expected: CloudInvocationAckExpectedBinding = {
        installationId: input.installationId,
        invocationId: String(outbox.invocation_id),
        sourceEventId: String(outbox.source_event_id),
        factDigest: String(outbox.fact_digest),
        deliveryMessageId: String(delivery.delivery_message_id),
        ackMessageId: ack.messageId,
        ackCanonicalDigest: ack.canonicalDigest,
      };
      let evidenceDigest: string;
      try {
        evidenceDigest = this.#cloudAckAuthority.verify(
          input.evidence,
          expected,
          now,
        ).evidenceDigest;
        assertSha256Digest(evidenceDigest);
      } catch {
        throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
      }
      const existing = context.database
        .prepare('SELECT * FROM local_invocation_outbox_receipts WHERE source_event_id = ?')
        .get(expected.sourceEventId) as Record<string, unknown> | undefined;
      if (existing !== undefined) {
        if (
          existing.fact_digest !== expected.factDigest ||
          existing.delivery_message_id !== expected.deliveryMessageId ||
          existing.ack_message_id !== expected.ackMessageId ||
          existing.ack_connection_id !== input.ack.connectionId ||
          existing.ack_sequence !== input.ack.sequence ||
          existing.ack_canonical_digest !== input.ack.canonicalDigest ||
          existing.cloud_evidence_digest !== evidenceDigest
        ) {
          throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
        }
        return;
      }
      const receipt = {
        source_event_id: expected.sourceEventId,
        fact_digest: expected.factDigest,
        delivery_message_id: expected.deliveryMessageId,
        ack_message_id: expected.ackMessageId,
        ack_connection_id: input.ack.connectionId,
        ack_sequence: input.ack.sequence,
        ack_canonical_digest: input.ack.canonicalDigest,
        cloud_evidence_digest: evidenceDigest,
        cloud_committed_at_ms: now.getTime(),
      };
      context.database
        .prepare(
          `INSERT INTO local_invocation_outbox_receipts(
             source_event_id, fact_digest, delivery_message_id, ack_message_id,
             ack_connection_id, ack_sequence, ack_canonical_digest, cloud_evidence_digest,
             cloud_committed_at_ms, row_digest
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ...Object.values(receipt),
          sqliteInvocationRowDigest('local_invocation_outbox_receipts', receipt),
        );
      const invocation = loadInvocation(context.database, expected.invocationId);
      if (
        invocation !== undefined &&
        invocation.terminal_source_event_id === expected.sourceEventId &&
        invocation.terminal_fact_digest === expected.factDigest
      ) {
        context.database
          .prepare(
            `UPDATE local_invocations SET state = 'CLOUD_COMMITTED', updated_at_ms = ?
             WHERE invocation_id = ? AND state IN ('FINAL_READY', 'FAILED', 'CANCELLED', 'UNCERTAIN')`,
          )
          .run(now.getTime(), expected.invocationId);
        refreshMutableRowDigest(
          context.database,
          'local_invocations',
          'invocation_id',
          expected.invocationId,
        );
      } else if (invocation?.state === 'CLOUD_COMMITTED') {
        // Retention starts after the last fact has its own exact Cloud receipt, not merely after
        // whichever fact happened to establish the terminal projection first.
        context.database
          .prepare(
            `UPDATE local_invocations SET updated_at_ms = ?
             WHERE invocation_id = ? AND state = 'CLOUD_COMMITTED'`,
          )
          .run(now.getTime(), expected.invocationId);
        refreshMutableRowDigest(
          context.database,
          'local_invocations',
          'invocation_id',
          expected.invocationId,
        );
      }
      context.purgeInvocationDeliveryWire(expected.deliveryMessageId);
    });
  }

  async readPendingFacts(input: {
    installationId: string;
    ownerToken: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly PendingInvocationFactReference[]> {
    const limit = boundedCapacity(input.limit, 1, 128);
    return this.host.transact({ ...input, name: 'invocation_read_pending_facts' }, (context) => {
      const rows = context.database
        .prepare(
          `SELECT o.source_event_id, o.invocation_id, o.event_type, o.correlation_id,
                  o.fact_digest
           FROM local_invocation_outbox AS o
           JOIN local_invocations AS i ON i.invocation_id = o.invocation_id
           LEFT JOIN local_invocation_outbox_receipts AS r
             ON r.source_event_id = o.source_event_id
           WHERE i.installation_id = ? AND r.source_event_id IS NULL
           ORDER BY o.created_at_ms, o.source_event_id LIMIT ?`,
        )
        .all(input.installationId, limit) as Array<{
        source_event_id: string;
        invocation_id: string;
        event_type: WorkerInvocationFact['type'];
        correlation_id: string;
        fact_digest: string;
      }>;
      return rows.map((row) =>
        Object.freeze({
          sourceEventId: row.source_event_id,
          invocationId: row.invocation_id,
          eventType: row.event_type,
          correlationId: row.correlation_id,
          factDigest: row.fact_digest,
        }),
      );
    });
  }

  /**
   * Bounded retention prune. Rows stay immutable while retained; only a terminal Invocation whose
   * every fact has an exact Cloud receipt can be removed after seven Cloud-time days.
   */
  async pruneCommittedRetention(input: {
    installationId: string;
    ownerToken: string;
    signal: AbortSignal;
  }): Promise<number> {
    const pruned = this.host.transact(
      { ...input, name: 'invocation_prune_committed_retention' },
      (context) => {
        const cutoff = this.#cloudNow().getTime() - WORKER_INVOCATION_TERMINAL_RETENTION_MS;
        const rows = context.database
          .prepare(
            `SELECT i.invocation_id, i.conversation_id, i.prepare_command_id
             FROM local_invocations AS i
             WHERE i.installation_id = ? AND i.state = 'CLOUD_COMMITTED'
               AND i.updated_at_ms <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM local_invocation_outbox AS o
                 LEFT JOIN local_invocation_outbox_receipts AS r
                   ON r.source_event_id = o.source_event_id
                 WHERE o.invocation_id = i.invocation_id AND r.source_event_id IS NULL
               )
             ORDER BY i.updated_at_ms, i.invocation_id LIMIT 128`,
          )
          .all(input.installationId, cutoff) as Array<{
          invocation_id: string;
          conversation_id: string;
          prepare_command_id: string;
        }>;
        for (const row of rows) {
          context.purgeInvocationCommandResponse(row.prepare_command_id);
          context.database
            .prepare(
              `DELETE FROM local_invocation_outbox_receipts WHERE source_event_id IN (
                 SELECT source_event_id FROM local_invocation_outbox WHERE invocation_id = ?
               )`,
            )
            .run(row.invocation_id);
          context.database
            .prepare('DELETE FROM local_invocation_deliveries WHERE invocation_id = ?')
            .run(row.invocation_id);
          context.database
            .prepare('DELETE FROM local_invocation_outbox WHERE invocation_id = ?')
            .run(row.invocation_id);
          context.database
            .prepare('DELETE FROM local_invocation_events WHERE invocation_id = ?')
            .run(row.invocation_id);
          context.database
            .prepare('DELETE FROM local_invocations WHERE invocation_id = ?')
            .run(row.invocation_id);
          context.database
            .prepare('DELETE FROM local_consumed_commands WHERE invocation_id = ?')
            .run(row.invocation_id);
        }
        const standaloneSecurityTombstones = context.database
          .prepare(
            `SELECT c.command_id FROM local_consumed_commands AS c
             WHERE c.disposition IN ('SECURITY_BLOCK', 'EXPIRED')
               AND c.consumed_at_ms <= ?
               AND (
                 c.invocation_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM local_invocations AS i
                   WHERE i.invocation_id = c.invocation_id
                 )
               )
             ORDER BY c.consumed_at_ms, c.command_id LIMIT 128`,
          )
          .all(cutoff) as Array<{ command_id: string }>;
        for (const tombstone of standaloneSecurityTombstones) {
          context.database
            .prepare(
              `DELETE FROM local_consumed_commands
               WHERE command_id = ? AND disposition IN ('SECURITY_BLOCK', 'EXPIRED')`,
            )
            .run(tombstone.command_id);
        }
        const supersededDeliveries = context.database
          .prepare(
            `SELECT d.delivery_message_id FROM local_invocation_deliveries AS d
             WHERE d.created_at_ms <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM transport_outbox AS t
                 WHERE t.message_id = d.delivery_message_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM local_invocation_outbox_receipts AS r
                 WHERE r.delivery_message_id = d.delivery_message_id
               )
             ORDER BY d.created_at_ms, d.delivery_message_id LIMIT 128`,
          )
          .all(cutoff) as Array<{ delivery_message_id: string }>;
        for (const delivery of supersededDeliveries) {
          context.database
            .prepare('DELETE FROM local_invocation_deliveries WHERE delivery_message_id = ?')
            .run(delivery.delivery_message_id);
        }
        return rows.length;
      },
    );
    this.host.checkpointSensitivePrune();
    return pruned;
  }

  #markStartUnknown(
    database: DatabaseSync,
    invocation: InvocationRow,
    now: Date,
  ): Readonly<{ action: 'UNCERTAIN'; sourceEventId: string; factDigest: string }> {
    const sourceEventId = invocation.invocation_id;
    const fact = WorkerInvocationFactSchema.parse({
      ...factBase(invocation, sourceEventId),
      type: 'invocation.uncertain',
      reason: 'START_DISPATCH_UNKNOWN',
    });
    const factDigest = workerInvocationFactDigest(fact);
    database
      .prepare(
        `UPDATE local_invocations SET terminal_source_event_id = ?, terminal_fact_digest = ?,
           prompt_ciphertext = NULL, prompt_purged_at_ms = COALESCE(prompt_purged_at_ms, ?),
           state = 'UNCERTAIN', updated_at_ms = ?
         WHERE invocation_id = ? AND state = 'STARTING' AND runtime_turn_id IS NULL`,
      )
      .run(sourceEventId, factDigest, now.getTime(), now.getTime(), invocation.invocation_id);
    refreshMutableRowDigest(
      database,
      'local_invocations',
      'invocation_id',
      invocation.invocation_id,
    );
    appendFact(
      database,
      invocation.invocation_id,
      invocation.start_command_id,
      'STARTING',
      'UNCERTAIN',
      fact,
      { correlationId: invocation.invocation_id, occurredAtMs: now.getTime() },
    );
    return Object.freeze({ action: 'UNCERTAIN', sourceEventId, factDigest });
  }

  #rewrapPromptCiphertext(
    command: Extract<BrokerCommand, { type: 'invocation.prepare' }>,
    installationId: string,
  ): LocalInvocationPromptCiphertext {
    const expectedAad: LocalInvocationPromptAad = {
      schemaVersion: 1,
      installationId,
      invocationId: command.body.invocationId,
      conversationId: command.body.conversationId,
      agentVersionDigest: command.body.agentVersionDigest,
      role: 'USER',
    };
    const rewrapped = this.#localPromptAeadAuthority.rewrap({
      brokerCiphertext: command.body.userMessageCiphertext,
      brokerAad: command.body.userMessageCiphertext.aad,
      localAad: expectedAad,
      expectedRequestDigest: command.body.requestDigest,
    });
    const ciphertext = LocalInvocationPromptCiphertextSchema.parse(rewrapped.ciphertext);
    if (
      canonicalizeJson(ciphertext.aad) !== canonicalizeJson(expectedAad) ||
      parseHmacSha256(rewrapped.requestDigest) !== command.body.requestDigest ||
      ciphertext.requestDigest !== command.body.requestDigest
    ) {
      throw new Error('local-prompt-rewrap-binding');
    }
    const opened = this.#openPromptCiphertext(ciphertext, expectedAad, command.body.requestDigest);
    opened.plaintext.fill(0);
    return ciphertext;
  }

  #openPromptCiphertext(
    input: LocalInvocationPromptCiphertext,
    expectedAad: LocalInvocationPromptAad,
    expectedRequestDigest: string,
  ): Readonly<{
    ciphertext: LocalInvocationPromptCiphertext;
    plaintext: Uint8Array;
    requestDigest: string;
  }> {
    const ciphertext = LocalInvocationPromptCiphertextSchema.parse(input);
    if (
      canonicalizeJson(ciphertext.aad) !== canonicalizeJson(expectedAad) ||
      ciphertext.requestDigest !== expectedRequestDigest
    ) {
      throw new Error('local-prompt-aad-binding');
    }
    const opened = this.#localPromptAeadAuthority.open({
      ciphertext,
      expectedAad,
      expectedRequestDigest,
    });
    if (!(opened.plaintext instanceof Uint8Array) || opened.plaintext.byteLength < 1) {
      throw new Error('local-prompt-plaintext');
    }
    const requestDigest = parseHmacSha256(opened.requestDigest);
    if (requestDigest !== expectedRequestDigest) throw new Error('local-prompt-request-digest');
    const plaintext = new Uint8Array(opened.plaintext);
    opened.plaintext.fill(0);
    return Object.freeze({ ciphertext, plaintext, requestDigest });
  }

  #verifyPersistedPromptAead(database: DatabaseSync): void {
    const rows = database.prepare('SELECT * FROM local_invocations').all() as InvocationRow[];
    for (const row of rows) {
      if (row.prompt_ciphertext === null) {
        if (row.prompt_purged_at_ms === null) {
          throw new WorkerInvocationJournalError('PROMPT_AEAD_INVALID');
        }
        continue;
      }
      try {
        const expectedAad: LocalInvocationPromptAad = {
          schemaVersion: 1,
          installationId: row.installation_id,
          invocationId: row.invocation_id,
          conversationId: row.conversation_id,
          agentVersionDigest: row.agent_version_digest,
          role: 'USER',
        };
        const opened = this.#openPromptCiphertext(
          JSON.parse(row.prompt_ciphertext) as LocalInvocationPromptCiphertext,
          expectedAad,
          row.request_digest,
        );
        opened.plaintext.fill(0);
        if (opened.ciphertext.cipherDigest !== row.local_prompt_cipher_digest) {
          throw new Error('local-prompt-cipher-digest');
        }
      } catch {
        throw new WorkerInvocationJournalError('PROMPT_AEAD_INVALID');
      }
    }
  }

  #verifyResultCiphertext(
    input: LocalInvocationResultCiphertext,
    invocation: InvocationRow,
    sourceEventId: string,
  ): Readonly<{ ciphertext: LocalInvocationResultCiphertext; resultDigest: string }> {
    let ciphertext: LocalInvocationResultCiphertext;
    try {
      ciphertext = LocalInvocationResultCiphertextSchema.parse(input);
      const expectedAad: LocalInvocationResultAad = {
        schemaVersion: 1,
        installationId: invocation.installation_id,
        invocationId: invocation.invocation_id,
        conversationId: invocation.conversation_id,
        agentVersionDigest: invocation.agent_version_digest,
        role: 'ASSISTANT',
      };
      if (canonicalizeJson(ciphertext.aad) !== canonicalizeJson(expectedAad)) {
        throw new Error('aad-binding');
      }
      if (sourceEventId !== invocation.invocation_id) throw new Error('source-binding');
      const verified = this.#localResultAeadAuthority.verify(ciphertext, expectedAad);
      const resultDigest = parseHmacSha256(verified.resultDigest);
      if (resultDigest !== ciphertext.resultDigest) throw new Error('result-digest-binding');
      return Object.freeze({ ciphertext, resultDigest });
    } catch {
      throw new WorkerInvocationJournalError('FINAL_AEAD_INVALID');
    }
  }

  #verifyPersistedResultAead(database: DatabaseSync): void {
    const rows = database
      .prepare(
        `SELECT * FROM local_invocations
         WHERE result_ciphertext IS NOT NULL OR result_digest IS NOT NULL`,
      )
      .all() as InvocationRow[];
    for (const row of rows) {
      if (row.result_ciphertext === null || row.result_source_event_id === null) {
        throw new WorkerInvocationJournalError('FINAL_AEAD_INVALID');
      }
      const verified = this.#verifyResultCiphertext(
        JSON.parse(String(row.result_ciphertext)) as LocalInvocationResultCiphertext,
        row,
        row.result_source_event_id,
      );
      if (
        verified.resultDigest !== row.result_digest ||
        verified.ciphertext.cipherDigest !== row.local_result_cipher_digest
      ) {
        throw new WorkerInvocationJournalError('FINAL_AEAD_INVALID');
      }
    }
  }

  #verifyPersistedCapabilities(database: DatabaseSync): void {
    const rows = database.prepare('SELECT * FROM local_invocations').all() as InvocationRow[];
    for (const row of rows) this.#verifyPersistedCapability(row, new Date(row.created_at_ms));
  }

  #verifyPersistedCapability(invocation: InvocationRow, at: Date): void {
    try {
      const capability = ExecutionCapabilitySchema.parse(
        JSON.parse(invocation.execution_capability_json),
      );
      const expected = executionCapabilityBindingFrom(capability);
      if (canonicalizeJson(expected) !== invocation.execution_capability_binding_json) {
        throw new Error('capability-binding');
      }
      const verified = this.#capabilityAuthority.verifyPreviouslyCommitted(
        capability,
        expected,
        invocation.execution_capability_digest,
        at,
      );
      if (verified.capabilityDigest !== invocation.execution_capability_digest) {
        throw new Error('capability-digest');
      }
    } catch {
      throw new WorkerInvocationJournalError('EXECUTION_CAPABILITY_INVALID');
    }
  }

  #verifyCurrentPersistedCapability(
    invocation: InvocationRow,
    now: Date,
  ): Readonly<{
    capability: ExecutionCapability;
    binding: ExpectedExecutionCapabilityBinding;
  }> {
    try {
      const capability = ExecutionCapabilitySchema.parse(
        JSON.parse(invocation.execution_capability_json),
      );
      const expected = executionCapabilityBindingFrom(capability);
      if (canonicalizeJson(expected) !== invocation.execution_capability_binding_json) {
        throw new Error('capability-binding');
      }
      const verified = this.#capabilityAuthority.verify(capability, expected, now);
      if (verified.capabilityDigest !== invocation.execution_capability_digest) {
        throw new Error('capability-digest');
      }
      return Object.freeze({ capability: verified.capability, binding: expected });
    } catch {
      throw new WorkerInvocationJournalError('EXECUTION_CAPABILITY_INVALID');
    }
  }

  #cloudNow(): Date {
    const now = this.#cloudClock.now();
    if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime()) || now.getTime() < 0) {
      throw new WorkerInvocationJournalError('INVOCATION_DEADLINE_EXPIRED');
    }
    return now;
  }

  #dispatchNonce(): string {
    return assertUuid(this.#dispatchNonceFactory());
  }
}

function loadStoredCommand(
  context: WorkerInvocationJournalTransactionContext,
  installationId: string,
  reference: OpaqueInvocationCommandReference,
): StoredCommand {
  assertUuid(installationId);
  assertUuid(reference.connectionId);
  assertUuid(reference.messageId);
  if (!/^(0|[1-9]\d*)$/u.test(reference.sequence) || !SHA256_HEX.test(reference.canonicalDigest)) {
    throw new WorkerInvocationJournalError('COMMAND_REFERENCE_INVALID');
  }
  const row = context.database
    .prepare(
      `SELECT f.message_id, f.canonical_digest, f.envelope_json, f.envelope_kind,
              f.envelope_type, f.effect_state,
              c.installation_id, c.connection_id, c.owner_epoch, c.deployment_id,
              c.lease_id, c.worker_session_id, c.fence, c.lease_state,
              c.lease_expires_at, c.status
       FROM transport_inbound_frames AS f
       JOIN transport_connections AS c ON c.connection_id = f.connection_id
       WHERE f.connection_id = ? AND f.sequence = ? AND c.installation_id = ?
         AND c.owner_epoch = ?`,
    )
    .get(reference.connectionId, reference.sequence, installationId, context.ownerEpoch) as
    | (ConnectionAuthorityRow & {
        message_id: string;
        canonical_digest: string;
        envelope_json: string;
        envelope_kind: string;
        envelope_type: string;
        effect_state: 'PERSISTED' | 'APPLIED';
      })
    | undefined;
  if (
    row === undefined ||
    row.message_id !== reference.messageId ||
    row.canonical_digest !== reference.canonicalDigest ||
    row.envelope_kind !== 'command' ||
    row.envelope_type !== reference.type
  ) {
    throw new WorkerInvocationJournalError('COMMAND_REFERENCE_INVALID');
  }
  try {
    const envelope = BrokerEnvelopeSchema.parse(JSON.parse(row.envelope_json));
    if (
      envelope.kind !== 'command' ||
      canonicalizeJson(envelope) !== row.envelope_json ||
      canonicalSha256(envelope) !== row.canonical_digest ||
      envelope.connectionId !== reference.connectionId ||
      envelope.sequence !== reference.sequence ||
      envelope.messageId !== reference.messageId ||
      envelope.type !== reference.type
    ) {
      throw new Error('stored-command-binding');
    }
    return Object.freeze({
      envelope,
      effectState: row.effect_state,
      connection: Object.freeze({
        installation_id: row.installation_id,
        connection_id: row.connection_id,
        owner_epoch: row.owner_epoch,
        deployment_id: row.deployment_id,
        lease_id: row.lease_id,
        worker_session_id: row.worker_session_id,
        fence: row.fence,
        lease_state: row.lease_state,
        lease_expires_at: row.lease_expires_at,
        status: row.status,
      }),
    });
  } catch (error) {
    if (error instanceof WorkerInvocationJournalError) throw error;
    throw new WorkerInvocationJournalError('COMMAND_REFERENCE_INVALID');
  }
}

function loadPurgedPrepareReplay(
  database: DatabaseSync,
  installationId: string,
  reference: OpaqueInvocationCommandReference,
): InvocationRow | undefined {
  assertUuid(installationId);
  assertUuid(reference.connectionId);
  assertUuid(reference.messageId);
  if (
    reference.type !== 'invocation.prepare' ||
    !/^(0|[1-9]\d*)$/u.test(reference.sequence) ||
    !SHA256_HEX.test(reference.canonicalDigest)
  ) {
    throw new WorkerInvocationJournalError('COMMAND_REFERENCE_INVALID');
  }
  const retainedFrame = database
    .prepare(
      `SELECT 1 AS present FROM transport_inbound_frames
       WHERE connection_id = ? AND sequence = ?`,
    )
    .get(reference.connectionId, reference.sequence);
  if (retainedFrame !== undefined) return undefined;
  const row = database
    .prepare(
      `SELECT i.*, c.connection_id AS consumed_connection_id,
              c.sequence AS consumed_sequence, c.canonical_digest AS consumed_canonical_digest,
              c.command_type AS consumed_command_type, c.invocation_id AS consumed_invocation_id
       FROM local_consumed_commands AS c
       JOIN local_invocations AS i ON i.invocation_id = c.invocation_id
       WHERE c.command_id = ? AND i.installation_id = ?`,
    )
    .get(reference.messageId, installationId) as
    | (InvocationRow & {
        consumed_connection_id: string;
        consumed_sequence: string;
        consumed_canonical_digest: string;
        consumed_command_type: string;
        consumed_invocation_id: string;
      })
    | undefined;
  if (row === undefined) return undefined;
  if (
    row.consumed_command_type !== 'invocation.prepare' ||
    row.consumed_connection_id !== reference.connectionId ||
    row.consumed_sequence !== reference.sequence ||
    row.consumed_canonical_digest !== reference.canonicalDigest ||
    row.consumed_invocation_id !== row.invocation_id ||
    row.prepare_command_id !== reference.messageId ||
    row.prepare_connection_id !== reference.connectionId ||
    row.prepare_sequence !== reference.sequence ||
    row.prepare_canonical_digest !== reference.canonicalDigest
  ) {
    throw new WorkerInvocationJournalError('COMMAND_REFERENCE_INVALID');
  }
  return row;
}

function assertLiveCommand(stored: StoredCommand, cloudNow: Date): void {
  assertCurrentTransportEnvelope(stored, cloudNow);
  if (
    'deadlineAt' in stored.envelope.body &&
    Date.parse(String(stored.envelope.body.deadlineAt)) <= cloudNow.getTime()
  ) {
    throw new WorkerInvocationJournalError('INVOCATION_DEADLINE_EXPIRED');
  }
}

function assertCurrentTransportEnvelope(stored: StoredCommand, cloudNow: Date): void {
  const { envelope, connection } = stored;
  if (
    connection.status !== 'ACTIVE' ||
    connection.lease_state !== 'ACTIVE' ||
    envelope.lease.deploymentId !== connection.deployment_id ||
    envelope.lease.leaseId !== connection.lease_id ||
    envelope.lease.workerSessionId !== connection.worker_session_id
  ) {
    throw new WorkerInvocationJournalError('STALE_LEASE');
  }
  if (envelope.lease.fence !== connection.fence) {
    throw new WorkerInvocationJournalError('STALE_FENCE');
  }
  const nowMs = cloudNow.getTime();
  if (Date.parse(connection.lease_expires_at) <= nowMs || Date.parse(envelope.expiresAt) <= nowMs) {
    throw new WorkerInvocationJournalError('INVOCATION_DEADLINE_EXPIRED');
  }
}

function assertCommandPersisted(stored: StoredCommand): void {
  if (stored.effectState !== 'PERSISTED') {
    throw new WorkerInvocationJournalError('COMMAND_ALREADY_CONSUMED');
  }
}

function insertConsumedCommand(
  database: DatabaseSync,
  reference: OpaqueInvocationCommandReference,
  command: BrokerCommand,
  input: Readonly<{
    conversationId?: string;
    invocationId?: string;
    disposition: 'APPLIED' | 'IDEMPOTENT_REPLAY' | 'SECURITY_BLOCK' | 'EXPIRED';
    consumedAtMs: number;
  }>,
): void {
  assertRetainedRowCapacity(database, 'local_consumed_commands', MAX_RETAINED_CONSUMED_COMMANDS);
  const row = {
    command_id: reference.messageId,
    connection_id: reference.connectionId,
    sequence: reference.sequence,
    canonical_digest: reference.canonicalDigest,
    semantic_digest: workerInvocationCommandSemanticDigest(command),
    command_type: command.type,
    conversation_id: input.conversationId ?? null,
    invocation_id: input.invocationId ?? null,
    disposition: input.disposition,
    consumed_at_ms: input.consumedAtMs,
  };
  database
    .prepare(
      `INSERT INTO local_consumed_commands(
         command_id, connection_id, sequence, canonical_digest, semantic_digest,
         command_type, conversation_id, invocation_id, disposition, consumed_at_ms, row_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...Object.values(row), sqliteInvocationRowDigest('local_consumed_commands', row));
}

function assertRetainedRowCapacity(
  database: DatabaseSync,
  table: 'local_consumed_commands' | 'local_invocation_deliveries',
  maximum: number,
): void {
  const retained = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  if (retained.count >= maximum) {
    throw new WorkerInvocationJournalError('JOURNAL_CAPACITY');
  }
}

function assertExactConsumedCommand(
  database: DatabaseSync,
  reference: OpaqueInvocationCommandReference,
  command: BrokerCommand,
): void {
  const row = database
    .prepare('SELECT * FROM local_consumed_commands WHERE command_id = ?')
    .get(reference.messageId) as Record<string, unknown> | undefined;
  if (
    row === undefined ||
    row.command_type !== command.type ||
    row.semantic_digest !== workerInvocationCommandSemanticDigest(command)
  ) {
    throw new WorkerInvocationJournalError('COMMAND_REFERENCE_INVALID');
  }
}

function consumeSecurityBlocked(
  context: WorkerInvocationJournalTransactionContext,
  reference: OpaqueInvocationCommandReference,
  command: BrokerCommand,
  nowMs: number,
): void {
  consumeTerminalCommand(context, reference, command, nowMs, 'SECURITY_BLOCK');
}

function consumeTerminalCommand(
  context: WorkerInvocationJournalTransactionContext,
  reference: OpaqueInvocationCommandReference,
  command: BrokerCommand,
  nowMs: number,
  disposition: 'SECURITY_BLOCK' | 'EXPIRED',
): void {
  if (
    context.database
      .prepare('SELECT 1 FROM local_consumed_commands WHERE command_id = ?')
      .get(command.messageId) !== undefined
  ) {
    assertExactConsumedCommand(context.database, reference, command);
    context.markTransportCommandApplied(reference);
    if (command.type === 'invocation.prepare') {
      context.purgeInvocationPrepareTransportPayload(command.messageId);
    }
    return;
  }
  insertConsumedCommand(context.database, reference, command, {
    ...('conversationId' in command.body
      ? { conversationId: String(command.body.conversationId) }
      : {}),
    ...('invocationId' in command.body ? { invocationId: String(command.body.invocationId) } : {}),
    disposition,
    consumedAtMs: nowMs,
  });
  context.markTransportCommandApplied(reference);
  if (command.type === 'invocation.prepare') {
    context.purgeInvocationPrepareTransportPayload(command.messageId);
  }
}

function initialInvocationRow(input: {
  installationId: string;
  reference: OpaqueInvocationCommandReference;
  command: Extract<BrokerCommand, { type: 'invocation.prepare' }>;
  promptCiphertext: LocalInvocationPromptCiphertext;
  capability: ExecutionCapability;
  capabilityDigest: string;
  expected: ExpectedExecutionCapabilityBinding;
  sourceEventId: string;
  factDigest: string;
  nowMs: number;
}): InvocationRow {
  return {
    invocation_id: input.command.body.invocationId,
    conversation_id: input.command.body.conversationId,
    installation_id: input.installationId,
    client_message_id: input.command.body.clientMessageId,
    request_digest: input.command.body.requestDigest,
    prompt_ciphertext: canonicalizeJson(input.promptCiphertext),
    local_prompt_cipher_digest: input.promptCiphertext.cipherDigest,
    prompt_released_at_ms: null,
    prompt_purged_at_ms: null,
    host_prompt_release_count: 0,
    agent_version_id: input.command.body.agentVersionId,
    agent_version_digest: input.command.body.agentVersionDigest,
    snapshot_digest: input.command.body.snapshotDigest,
    deployment_id: input.command.lease.deploymentId,
    lease_id: input.capability.leaseId,
    worker_session_id: input.command.lease.workerSessionId,
    fence: input.capability.fence,
    execution_capability_id: input.capability.capabilityId,
    execution_capability_digest: input.capabilityDigest,
    execution_capability_json: canonicalizeJson(input.capability),
    execution_capability_binding_json: canonicalizeJson(input.expected),
    capability_not_before_ms: Date.parse(input.capability.notBefore),
    capability_expires_at_ms: Date.parse(input.capability.expiresAt),
    command_deadline_at_ms: Date.parse(input.command.body.deadlineAt),
    prepare_command_id: input.command.messageId,
    prepare_connection_id: input.reference.connectionId,
    prepare_sequence: input.reference.sequence,
    prepare_canonical_digest: input.reference.canonicalDigest,
    prepare_semantic_digest: workerInvocationCommandSemanticDigest(input.command),
    prepared_source_event_id: input.sourceEventId,
    prepared_fact_digest: input.factDigest,
    start_command_id: null,
    start_connection_id: null,
    start_sequence: null,
    start_canonical_digest: null,
    dispatch_nonce: null,
    dispatch_permit_issued_at_ms: null,
    runtime_turn_id: null,
    dispatch_receipt_digest: null,
    sandbox_attestation_digest: null,
    started_source_event_id: null,
    started_fact_digest: null,
    result_digest: null,
    result_ciphertext: null,
    local_result_cipher_digest: null,
    result_source_event_id: null,
    result_fact_digest: null,
    terminal_source_event_id: null,
    terminal_fact_digest: null,
    state: 'PREPARED',
    host_dispatch_intent_count: 0,
    host_dispatch_confirmed_count: 0,
    created_at_ms: input.nowMs,
    updated_at_ms: input.nowMs,
    row_digest: '',
  };
}

function insertInvocation(database: DatabaseSync, input: InvocationRow): void {
  const { row_digest: _ignored, ...row } = input;
  const values = Object.values(row) as Array<string | number | bigint | Uint8Array | null>;
  database
    .prepare(
      `INSERT INTO local_invocations(
         invocation_id, conversation_id, installation_id, client_message_id, request_digest,
         prompt_ciphertext, local_prompt_cipher_digest, prompt_released_at_ms,
         prompt_purged_at_ms, host_prompt_release_count,
         agent_version_id, agent_version_digest, snapshot_digest, deployment_id, lease_id,
         worker_session_id, fence, execution_capability_id, execution_capability_digest,
         execution_capability_json, execution_capability_binding_json, capability_not_before_ms,
         capability_expires_at_ms,
         command_deadline_at_ms, prepare_command_id, prepare_connection_id, prepare_sequence,
         prepare_canonical_digest, prepare_semantic_digest, prepared_source_event_id,
         prepared_fact_digest,
         start_command_id, start_connection_id, start_sequence, start_canonical_digest,
         dispatch_nonce, dispatch_permit_issued_at_ms, runtime_turn_id, dispatch_receipt_digest,
         sandbox_attestation_digest, started_source_event_id, started_fact_digest, result_digest,
         result_ciphertext, local_result_cipher_digest, result_source_event_id,
         result_fact_digest, terminal_source_event_id, terminal_fact_digest, state,
         host_dispatch_intent_count, host_dispatch_confirmed_count, created_at_ms, updated_at_ms,
         row_digest
       ) VALUES (${Array.from({ length: 55 }, () => '?').join(', ')})`,
    )
    .run(...values, sqliteInvocationRowDigest('local_invocations', row));
}

function loadInvocation(database: DatabaseSync, invocationId: string): InvocationRow | undefined {
  return database
    .prepare('SELECT * FROM local_invocations WHERE invocation_id = ?')
    .get(invocationId) as InvocationRow | undefined;
}

function samePreparedInvocation(
  row: InvocationRow,
  command: Extract<BrokerCommand, { type: 'invocation.prepare' }>,
  capabilityDigest: string,
): boolean {
  return (
    row.conversation_id === command.body.conversationId &&
    row.client_message_id === command.body.clientMessageId &&
    row.request_digest === command.body.requestDigest &&
    row.agent_version_id === command.body.agentVersionId &&
    row.agent_version_digest === command.body.agentVersionDigest &&
    row.snapshot_digest === command.body.snapshotDigest &&
    row.deployment_id === command.lease.deploymentId &&
    row.lease_id === command.body.executionCapability.leaseId &&
    row.fence === command.body.executionCapability.fence &&
    row.prepare_command_id === command.messageId &&
    row.prepare_semantic_digest === workerInvocationCommandSemanticDigest(command) &&
    row.execution_capability_id === command.body.executionCapability.capabilityId &&
    row.execution_capability_digest === capabilityDigest
  );
}

function preparedReceipt(row: InvocationRow): DurablePreparedInvocation {
  return Object.freeze({
    invocationId: row.invocation_id,
    conversationId: row.conversation_id,
    prepareCommandId: row.prepare_command_id,
    sourceEventId: row.prepared_source_event_id,
    factDigest: row.prepared_fact_digest,
    state: 'PREPARED',
  });
}

function localPromptAadFromInvocation(invocation: InvocationRow): LocalInvocationPromptAad {
  return Object.freeze({
    schemaVersion: 1,
    installationId: invocation.installation_id,
    invocationId: invocation.invocation_id,
    conversationId: invocation.conversation_id,
    agentVersionDigest: invocation.agent_version_digest,
    role: 'USER',
  });
}

function hostDispatchPermitMatches(
  permit: OpaqueHostDispatchPermit,
  invocation: InvocationRow,
): boolean {
  try {
    const row = strictObject(permit, [
      'invocationId',
      'conversationId',
      'startCommandId',
      'dispatchNonce',
      'agentVersionId',
      'agentVersionDigest',
      'snapshotDigest',
      'requestDigest',
      'executionCapabilityDigest',
      'deadlineAt',
    ]);
    return (
      row.invocationId === invocation.invocation_id &&
      row.conversationId === invocation.conversation_id &&
      row.startCommandId === invocation.start_command_id &&
      row.dispatchNonce === invocation.dispatch_nonce &&
      row.agentVersionId === invocation.agent_version_id &&
      row.agentVersionDigest === invocation.agent_version_digest &&
      row.snapshotDigest === invocation.snapshot_digest &&
      row.requestDigest === invocation.request_digest &&
      row.executionCapabilityDigest === invocation.execution_capability_digest &&
      row.deadlineAt === new Date(invocation.command_deadline_at_ms).toISOString()
    );
  } catch {
    return false;
  }
}

function factBase(row: InvocationRow, sourceEventId: string) {
  return {
    protocol: 'combo.worker-invocation-fact/1' as const,
    schemaVersion: 1 as const,
    sourceEventId,
    invocationId: row.invocation_id,
    agentVersionDigest: row.agent_version_digest,
    snapshotDigest: row.snapshot_digest,
    executionCapabilityDigest: row.execution_capability_digest,
    leaseId: row.lease_id,
    fence: row.fence,
  };
}

function appendFact(
  database: DatabaseSync,
  invocationId: string,
  commandId: string | null,
  fromState: string | null,
  toState: string,
  fact: WorkerInvocationFact,
  input: Readonly<{ correlationId: string; occurredAtMs: number }>,
): void {
  const parsed = WorkerInvocationFactSchema.parse(fact);
  const factDigest = workerInvocationFactDigest(parsed);
  if (
    parsed.invocationId !== invocationId ||
    parsed.sourceEventId.length === 0 ||
    (parsed.type === 'invocation.prepared' && parsed.prepareCommandId !== commandId) ||
    (parsed.type === 'invocation.started' && parsed.startCommandId !== commandId)
  ) {
    throw new WorkerInvocationJournalError('OUTBOX_CONFLICT');
  }
  const factJson = canonicalizeJson(parsed);
  const event = {
    invocation_id: invocationId,
    command_id: commandId,
    source_event_id: parsed.sourceEventId,
    event_type: parsed.type,
    from_state: fromState,
    to_state: toState,
    fact_json: factJson,
    fact_digest: factDigest,
    occurred_at_ms: input.occurredAtMs,
  };
  database
    .prepare(
      `INSERT INTO local_invocation_events(
         invocation_id, command_id, source_event_id, event_type, from_state, to_state,
         fact_json, fact_digest, occurred_at_ms, event_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...Object.values(event), sqliteInvocationRowDigest('local_invocation_events', event));
  const outbox = {
    source_event_id: parsed.sourceEventId,
    invocation_id: invocationId,
    event_type: parsed.type,
    correlation_id: input.correlationId,
    fact_json: factJson,
    fact_digest: factDigest,
    created_at_ms: input.occurredAtMs,
  };
  database
    .prepare(
      `INSERT INTO local_invocation_outbox(
         source_event_id, invocation_id, event_type, correlation_id, fact_json, fact_digest,
         created_at_ms, row_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...Object.values(outbox), sqliteInvocationRowDigest('local_invocation_outbox', outbox));
}

function appendLocalEvent(
  database: DatabaseSync,
  input: Readonly<{
    invocationId: string;
    commandId: string;
    eventType: 'local.invocation.starting';
    fromState: 'PREPARED';
    toState: 'STARTING';
    occurredAtMs: number;
  }>,
): void {
  const row = {
    invocation_id: input.invocationId,
    command_id: input.commandId,
    source_event_id: null,
    event_type: input.eventType,
    from_state: input.fromState,
    to_state: input.toState,
    fact_json: null,
    fact_digest: null,
    occurred_at_ms: input.occurredAtMs,
  };
  database
    .prepare(
      `INSERT INTO local_invocation_events(
         invocation_id, command_id, source_event_id, event_type, from_state, to_state,
         fact_json, fact_digest, occurred_at_ms, event_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...Object.values(row), sqliteInvocationRowDigest('local_invocation_events', row));
}

function refreshMutableRowDigest(
  database: DatabaseSync,
  table: 'local_conversations' | 'local_invocations',
  key: 'conversation_id' | 'invocation_id',
  value: string,
): void {
  const row = database.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(value) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) throw new WorkerInvocationJournalError('INVOCATION_NOT_FOUND');
  const { row_digest: _stored, ...payload } = row;
  database
    .prepare(`UPDATE ${table} SET row_digest = ? WHERE ${key} = ?`)
    .run(sqliteInvocationRowDigest(table, payload), value);
}

function requireConversation(
  database: DatabaseSync,
  conversationId: string,
): Record<string, unknown> {
  const row = database
    .prepare('SELECT * FROM local_conversations WHERE conversation_id = ?')
    .get(conversationId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new WorkerInvocationJournalError('CONVERSATION_NOT_READY');
  return row;
}

function assertInvocationDeadline(invocation: InvocationRow, now: Date): void {
  if (
    invocation.capability_not_before_ms > now.getTime() ||
    invocation.capability_expires_at_ms <= now.getTime() ||
    invocation.command_deadline_at_ms <= now.getTime()
  ) {
    throw new WorkerInvocationJournalError('INVOCATION_DEADLINE_EXPIRED');
  }
}

function assertInvocationAdmission(
  database: DatabaseSync,
  maxInvocations: number,
  maxPendingFacts: number,
): void {
  const invocations = database.prepare('SELECT count(*) AS count FROM local_invocations').get() as {
    count: number;
  };
  if (invocations.count >= maxInvocations) {
    throw new WorkerInvocationJournalError('JOURNAL_CAPACITY');
  }
  const pending = pendingFactCount(database);
  if (pending + 3 > maxPendingFacts) {
    throw new WorkerInvocationJournalError('JOURNAL_CAPACITY');
  }
}

function pendingFactCount(database: DatabaseSync): number {
  return (
    database
      .prepare(
        `SELECT count(*) AS count FROM local_invocation_outbox AS o
       LEFT JOIN local_invocation_outbox_receipts AS r ON r.source_event_id = o.source_event_id
       WHERE r.source_event_id IS NULL`,
      )
      .get() as { count: number }
  ).count;
}

function journalCode(error: unknown): WorkerInvocationJournalErrorCode {
  return error instanceof WorkerInvocationJournalError ? error.code : 'COMMAND_REFERENCE_INVALID';
}

function boundedCapacity(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkerInvocationJournalError('JOURNAL_CAPACITY');
  }
  return value;
}

function strictObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('strict-object');
  }
  const row = input as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('strict-object-keys');
  }
  return row;
}

function parseSha256Hex(input: unknown): string {
  if (typeof input !== 'string' || !SHA256_HEX.test(input)) throw new Error('sha256-hex');
  return input;
}

function parseHmacSha256(input: unknown): string {
  if (typeof input !== 'string' || !/^hmac-sha256:[0-9a-f]{64}$/u.test(input)) {
    throw new Error('hmac-sha256');
  }
  return input;
}

function assertUuid(value: string): string {
  try {
    return UuidSchema.parse(value);
  } catch {
    throw new WorkerInvocationJournalError('COMMAND_REFERENCE_INVALID');
  }
}

function assertSha256Digest(value: string): void {
  if (!SHA256_DIGEST.test(value)) throw new Error('sha256-digest');
}

function assertNonSecretIdentifier(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 256) {
    throw new Error('identifier');
  }
}

function uuidV7(): string {
  const value = randomUUID().toLowerCase();
  return `${value.slice(0, 14)}7${value.slice(15, 19)}8${value.slice(20)}`;
}
