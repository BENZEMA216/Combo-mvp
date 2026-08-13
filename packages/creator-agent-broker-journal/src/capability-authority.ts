import {
  ExecutionCapabilityUseRecordSchema,
  decideExecutionCapabilityUse,
  validateExecutionCapabilityBinding,
  type ExecutionCapability,
  type ExecutionCapabilityUseDecision,
  type ExecutionCapabilityUseRecord,
  type ExpectedExecutionCapabilityBinding,
  type P256PublicKeyInput,
} from '@cb/creator-agent-protocol';
import { chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

interface NodeSqliteModule {
  readonly DatabaseSync: typeof DatabaseSync;
}

const loadNodeSqlite = (): NodeSqliteModule =>
  createRequire(import.meta.url)('node:sqlite') as NodeSqliteModule;

export interface VerifiedExecutionCapability {
  readonly capability: ExecutionCapability;
  readonly capabilityDigest: string;
}

const CAPABILITY_LEDGER_APPLICATION_ID = 0x43424c31;
const CAPABILITY_LEDGER_USER_VERSION = 1;

type CapabilityUseMutation<T> = {
  readonly value: T;
  readonly nextRecord?: ExecutionCapabilityUseRecord;
};

export interface ExecutionCapabilityUseStore {
  transact<T>(
    capabilityId: string,
    operation: (existing: ExecutionCapabilityUseRecord | null) => CapabilityUseMutation<T>,
  ): T;
  get(capabilityId: string): ExecutionCapabilityUseRecord | undefined;
}

/**
 * Explicit E1-only store. It is useful for reducer/property tests, but it is
 * not a durability boundary and must never be wired to the Provider Proxy.
 */
export class InMemoryExecutionCapabilityUseStore implements ExecutionCapabilityUseStore {
  private readonly records = new Map<string, ExecutionCapabilityUseRecord>();

  constructor(private readonly maxRecords = 10_000) {
    assertPositiveCapacity(maxRecords);
  }

  transact<T>(
    capabilityId: string,
    operation: (existing: ExecutionCapabilityUseRecord | null) => CapabilityUseMutation<T>,
  ): T {
    const existing = this.records.get(capabilityId) ?? null;
    const mutation = operation(existing ? { ...existing } : null);
    if (mutation.nextRecord) {
      if (!existing && this.records.size >= this.maxRecords) {
        throw new ExecutionCapabilityAuthorityError(['capability-ledger-capacity']);
      }
      this.records.set(capabilityId, ExecutionCapabilityUseRecordSchema.parse(mutation.nextRecord));
    }
    return mutation.value;
  }

  get(capabilityId: string): ExecutionCapabilityUseRecord | undefined {
    const record = this.records.get(capabilityId);
    return record ? { ...record } : undefined;
  }

  serialize(): string {
    return JSON.stringify({ schemaVersion: 1, records: [...this.records.values()] });
  }

  static restore(serialized: string, maxRecords = 10_000): InMemoryExecutionCapabilityUseStore {
    const parsed = JSON.parse(serialized) as { schemaVersion: number; records: unknown[] };
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.records) ||
      parsed.records.length > maxRecords
    ) {
      throw new ExecutionCapabilityAuthorityError(['capability-ledger-schema']);
    }
    const store = new InMemoryExecutionCapabilityUseStore(maxRecords);
    for (const input of parsed.records) {
      const record = ExecutionCapabilityUseRecordSchema.parse(input);
      if (store.records.has(record.capabilityId)) {
        throw new ExecutionCapabilityAuthorityError(['capability-ledger-duplicate']);
      }
      store.records.set(record.capabilityId, record);
    }
    return store;
  }
}

/**
 * Concrete durable one-use store for the Provider Proxy. `BEGIN IMMEDIATE`
 * serializes competing processes; the DISPATCH_ONCE decision is returned only
 * after the DISPATCHED row commits with synchronous=FULL.
 */
export class SqliteExecutionCapabilityUseStore implements ExecutionCapabilityUseStore {
  private readonly database: DatabaseSync;

  constructor(
    filename: string,
    private readonly maxRecords = 100_000,
  ) {
    assertPositiveCapacity(maxRecords);
    if (filename === ':memory:' || filename.length === 0) {
      throw new ExecutionCapabilityAuthorityError(['capability-ledger-not-durable']);
    }
    this.database = new (loadNodeSqlite().DatabaseSync)(filename);
    const existingApplicationId = this.database.prepare('PRAGMA application_id').get() as {
      application_id?: number;
    };
    const existingUserVersion = this.database.prepare('PRAGMA user_version').get() as {
      user_version?: number;
    };
    if (
      (existingApplicationId.application_id !== 0 &&
        existingApplicationId.application_id !== CAPABILITY_LEDGER_APPLICATION_ID) ||
      (existingUserVersion.user_version !== 0 &&
        existingUserVersion.user_version !== CAPABILITY_LEDGER_USER_VERSION)
    ) {
      this.database.close();
      throw new ExecutionCapabilityAuthorityError(['capability-ledger-schema']);
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA application_id = ${CAPABILITY_LEDGER_APPLICATION_ID};
      PRAGMA user_version = ${CAPABILITY_LEDGER_USER_VERSION};
      CREATE TABLE IF NOT EXISTS execution_capability_uses (
        capability_id TEXT PRIMARY KEY,
        capability_digest TEXT NOT NULL,
        provider_request_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('UNUSED', 'DISPATCHED', 'DURABLE_RESULT', 'REVOKED')),
        provider_upstream_request_count INTEGER NOT NULL CHECK (provider_upstream_request_count BETWEEN 0 AND 1),
        result_digest TEXT,
        record_json TEXT NOT NULL
      ) STRICT;
    `);
    chmodSync(filename, 0o600);
    const applicationId = this.database.prepare('PRAGMA application_id').get() as {
      application_id?: number;
    };
    const userVersion = this.database.prepare('PRAGMA user_version').get() as {
      user_version?: number;
    };
    if (
      applicationId.application_id !== CAPABILITY_LEDGER_APPLICATION_ID ||
      userVersion.user_version !== CAPABILITY_LEDGER_USER_VERSION
    ) {
      this.database.close();
      throw new ExecutionCapabilityAuthorityError(['capability-ledger-schema']);
    }
  }

  transact<T>(
    capabilityId: string,
    operation: (existing: ExecutionCapabilityUseRecord | null) => CapabilityUseMutation<T>,
  ): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.read(capabilityId);
      const mutation = operation(existing);
      if (mutation.nextRecord) {
        const next = ExecutionCapabilityUseRecordSchema.parse(mutation.nextRecord);
        if (next.capabilityId !== capabilityId) {
          throw new ExecutionCapabilityAuthorityError(['capability-ledger-binding']);
        }
        if (!existing) {
          const countRow = this.database
            .prepare('SELECT count(*) AS count FROM execution_capability_uses')
            .get() as { count?: number };
          if ((countRow.count ?? Number.POSITIVE_INFINITY) >= this.maxRecords) {
            throw new ExecutionCapabilityAuthorityError(['capability-ledger-capacity']);
          }
        }
        this.database
          .prepare(
            `
            INSERT INTO execution_capability_uses (
              capability_id, capability_digest, provider_request_id, request_digest,
              state, provider_upstream_request_count, result_digest, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(capability_id) DO UPDATE SET
              capability_digest = excluded.capability_digest,
              provider_request_id = excluded.provider_request_id,
              request_digest = excluded.request_digest,
              state = excluded.state,
              provider_upstream_request_count = excluded.provider_upstream_request_count,
              result_digest = excluded.result_digest,
              record_json = excluded.record_json
          `,
          )
          .run(
            next.capabilityId,
            next.capabilityDigest,
            next.providerRequestId,
            next.requestDigest,
            next.state,
            next.providerUpstreamRequestCount,
            next.resultDigest,
            JSON.stringify(next),
          );
      }
      this.database.exec('COMMIT');
      return mutation.value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(capabilityId: string): ExecutionCapabilityUseRecord | undefined {
    return this.read(capabilityId) ?? undefined;
  }

  close(): void {
    this.database.close();
  }

  private read(capabilityId: string): ExecutionCapabilityUseRecord | null {
    const row = this.database
      .prepare('SELECT record_json FROM execution_capability_uses WHERE capability_id = ?')
      .get(capabilityId) as { record_json?: string } | undefined;
    if (!row?.record_json) return null;
    return ExecutionCapabilityUseRecordSchema.parse(JSON.parse(row.record_json));
  }
}

/**
 * Frozen one-use reducer backed by an injected transactional store. Production
 * dispatch must use SqliteExecutionCapabilityUseStore (or an equivalent
 * durable CAS); the default in-memory store is intentionally E1-only.
 */
export class ExecutionCapabilityUseJournal {
  constructor(
    private readonly store: ExecutionCapabilityUseStore = new InMemoryExecutionCapabilityUseStore(),
  ) {}

  authorize(capability: ExecutionCapability): ExecutionCapabilityUseDecision {
    return this.store.transact(capability.capabilityId, (existing) => {
      const decision = decideExecutionCapabilityUse(capability, existing);
      return {
        value: cloneUseDecision(decision),
        ...(decision.action === 'DISPATCH_ONCE' ? { nextRecord: { ...decision.nextRecord } } : {}),
      };
    });
  }

  markDurableResult(capability: ExecutionCapability, resultDigest: string): void {
    this.store.transact(capability.capabilityId, (existing) => {
      const decision = decideExecutionCapabilityUse(capability, existing);
      if (decision.action === 'SECURITY_BLOCK' || decision.action === 'DISPATCH_ONCE') {
        throw new ExecutionCapabilityAuthorityError(['capability-use-ledger']);
      }
      if (decision.action === 'RETURN_DURABLE_RESULT') {
        if (decision.record.resultDigest !== resultDigest) {
          throw new ExecutionCapabilityAuthorityError(['capability-result-conflict']);
        }
        return { value: undefined };
      }
      const durable = ExecutionCapabilityUseRecordSchema.parse({
        ...decision.record,
        state: 'DURABLE_RESULT',
        resultDigest,
      });
      return { value: undefined, nextRecord: durable };
    });
  }

  get(capabilityId: string): ExecutionCapabilityUseRecord | undefined {
    return this.store.get(capabilityId);
  }

  serialize(): string {
    if (!(this.store instanceof InMemoryExecutionCapabilityUseStore)) {
      throw new ExecutionCapabilityAuthorityError(['capability-ledger-already-durable']);
    }
    return this.store.serialize();
  }

  static restore(serialized: string): ExecutionCapabilityUseJournal {
    return new ExecutionCapabilityUseJournal(
      InMemoryExecutionCapabilityUseStore.restore(serialized),
    );
  }
}

function assertPositiveCapacity(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ExecutionCapabilityAuthorityError(['capability-ledger-capacity']);
  }
}

function cloneUseDecision(
  decision: ExecutionCapabilityUseDecision,
): ExecutionCapabilityUseDecision {
  if (decision.action === 'DISPATCH_ONCE') {
    return { ...decision, nextRecord: { ...decision.nextRecord } };
  }
  if (decision.action === 'SECURITY_BLOCK') return { ...decision };
  if (decision.action === 'RETURN_DURABLE_RESULT') {
    return {
      action: decision.action,
      record: {
        ...decision.record,
        state: 'DURABLE_RESULT',
        resultDigest: decision.record.resultDigest,
      },
    };
  }
  return { action: decision.action, record: { ...decision.record } };
}

export interface ExecutionCapabilityAuthorityPort {
  verify(
    input: unknown,
    expected: ExpectedExecutionCapabilityBinding,
    now: Date,
  ): VerifiedExecutionCapability;
}

export class ExecutionCapabilityAuthorityError extends Error {
  readonly code = 'EXECUTION_CAPABILITY_INVALID' as const;

  constructor(readonly reasons: readonly string[]) {
    super(`EXECUTION_CAPABILITY_INVALID:${reasons.join(',')}`);
    this.name = 'ExecutionCapabilityAuthorityError';
  }
}

/**
 * Adapter around the frozen Contract Track verifier. The public key and
 * revocation set are authority-owned constructor dependencies, never values
 * supplied by an invocation caller.
 */
export class RegisteredExecutionCapabilityAuthority implements ExecutionCapabilityAuthorityPort {
  constructor(
    private readonly registeredCloudP256PublicKey: P256PublicKeyInput,
    private readonly revokedCapabilityIds: ReadonlySet<string> = new Set(),
  ) {}

  verify(
    input: unknown,
    expected: ExpectedExecutionCapabilityBinding,
    now: Date,
  ): VerifiedExecutionCapability {
    const result = validateExecutionCapabilityBinding(
      input,
      expected,
      now,
      this.revokedCapabilityIds,
      this.registeredCloudP256PublicKey,
    );
    if (!result.ok) throw new ExecutionCapabilityAuthorityError(result.reasons);
    return result;
  }
}
