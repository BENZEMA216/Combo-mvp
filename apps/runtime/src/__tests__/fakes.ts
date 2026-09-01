// 测试共用假件：忠实假 PG（按 repo 的真实 SQL 形态逐条模拟）+ 假对象存储 + 假 agent 工厂。
// 「忠实」指：守卫条件（owner/唯一约束/过滤）与真实 SQL 语义一致，命中/未命中行数可断言。
import type { Bucket } from '@cb/shared';
import type { Queryable, QueryResultLike, TxConn, TxPool } from '../platform/infra/db.js';
import { BoundedObjectReadError, type RuntimeObjectStore } from '../platform/infra/object-store.js';
import type { TurnAgent, TurnAgentFactory, TurnAgentInput } from '../modules/agent/run-turn.js';
import type { ArtifactAgentTool } from '../modules/artifact/tool.js';
import {
  compareStreamIds,
  EVENT_STREAM_MAXLEN,
  type SessionEventLog,
  type StreamEventEntry,
} from '../modules/agent/event-log.js';

let seq = 0;
/** 递增的假 UUID（保持 id 可比较排序，模拟 UUID v7 时间有序）。 */
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

function nextUuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface CapabilityRowF {
  id: string;
  task_id: string;
  owner_user_id: string;
  name: string;
  summary: string;
  kind: string;
  storage_key: string;
  published: boolean;
  ui_artifact_id: string | null;
  created_at: string;
}

export interface SessionRowF {
  id: string;
  capability_id: string;
  owner_user_id: string;
  mode: 'consume' | 'studio';
  product_kind: 'legacy_capability' | 'knowledge_agent_test';
  capability_protocol: string | null;
  release_id: string | null;
  package_digest: string | null;
  release_scope: string | null;
  knowledge_resource_path: string | null;
  knowledge_resource_digest: string | null;
  title: string | null;
  status: 'active' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface MessageRowF {
  id: string;
  session_id: string;
  seq: number | null;
  turn_id: string | null;
  idx: number | null;
  role: string;
  content: unknown[];
  status: string;
  created_at: string;
}

export interface TurnRowF {
  id: string;
  session_id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  last_error: { code: string; message: string } | null;
  created_at: string;
  finished_at: string | null;
}

export interface BillingAccountRowF {
  owner_user_id: string;
  balance_cents: bigint;
  reserved_cents: bigint;
  created_at: string;
  updated_at: string;
}

export interface BillingFreeAllowanceRowF {
  owner_user_id: string;
  capability_id: string;
  policy_version: string;
  free_limit_snapshot: number;
  free_used_count: number;
  free_reserved_count: number;
  created_at: string;
  updated_at: string;
}

export interface UsageChargeRowF {
  id: string;
  owner_user_id: string;
  usage_id: string;
  capability_id: string;
  session_id: string;
  turn_id: string;
  request_fingerprint: string;
  charge_source: 'owner' | 'free' | 'wallet';
  status: 'reserved' | 'completed' | 'released';
  unit_price_cents: bigint;
  free_limit_snapshot: number;
  reserved_cents: bigint;
  settled_cents: bigint;
  product_kind: 'legacy_capability' | 'knowledge_agent_test';
  capability_protocol: string | null;
  release_id: string | null;
  package_digest: string | null;
  release_scope: string | null;
  knowledge_resource_path: string | null;
  knowledge_resource_digest: string | null;
  billing_policy_version: string | null;
  validator_policy_version: string | null;
  execution_outcome: 'answered' | 'insufficient_evidence' | 'failed' | 'interrupted' | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface WalletLedgerRowF {
  id: string;
  owner_user_id: string;
  entry_type: 'usage_debit';
  amount_cents: bigint;
  recharge_order_id: null;
  usage_charge_id: string;
  created_at: string;
}

export interface AgentUsageReceiptRowF {
  id: string;
  protocol: 'combo.agent-usage-receipt/1';
  usage_charge_id: string;
  owner_user_id: string;
  usage_id: string;
  capability_id: string;
  session_id: string;
  turn_id: string;
  product_kind: 'knowledge_agent_test';
  capability_protocol: string;
  release_id: string;
  package_digest: string;
  release_scope: 'controlled_test';
  knowledge_resource_path: string;
  knowledge_resource_digest: string;
  billing_policy_version: string;
  validator_policy_version: string;
  unit_price_cents: bigint;
  free_limit_snapshot: number;
  charge_source: UsageChargeRowF['charge_source'];
  settled_cents: bigint;
  execution_outcome: NonNullable<UsageChargeRowF['execution_outcome']>;
  validation_code: string;
  response_message_id: string | null;
  response_digest: string | null;
  citation_chunk_ids: string[];
  execution_environment: 'test';
  runtime_release_id: string;
  runtime_source_sha: string;
  created_at: string;
}

export interface PendingUsageRecoveryRowF {
  owner_user_id: string;
  usage_id: string;
  session_id: string;
  capability_id: string;
  request_text: string | null;
  request_fingerprint: string;
  product_kind: 'knowledge_agent_test';
  capability_protocol: string;
  release_id: string;
  package_digest: string;
  release_scope: 'controlled_test';
  knowledge_resource_path: string;
  knowledge_resource_digest: string;
  billing_policy_version: string;
  validator_policy_version: string;
  unit_price_cents: bigint;
  free_limit_snapshot: number;
  active_recharge_intent_id: string;
  recovery_status: 'active' | 'accepted' | 'abandoned';
  terminal_turn_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface AgentPackageRowF {
  package_digest: string;
  protocol: 'combo.agent-package/1';
  owner_user_id: string;
}

export interface AgentPackageReleaseRowF {
  release_id: string;
  package_digest: string;
  owner_user_id: string;
  protocol: 'combo.agent-package-release/1';
  release_scope: 'controlled_test';
}

export interface ArtifactRowF {
  id: string;
  session_id: string;
  turn_id?: string | null;
  kind: string;
  title: string | null;
  storage_key: string;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export class FakeSessionEventLog implements SessionEventLog {
  private readonly streams = new Map<string, StreamEventEntry[]>();
  private readonly terminals = new Map<string, { encoded: string; id: string }>();
  private lastMilliseconds = -1;
  private sequence = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxlen = EVENT_STREAM_MAXLEN,
  ) {}

  async append(sessionId: string, event: Record<string, unknown>): Promise<string> {
    const runId = typeof event.runId === 'string' ? event.runId : undefined;
    if (runId && this.terminals.has(`${sessionId}:${runId}`)) {
      throw new Error('TERMINAL_ALREADY_APPENDED');
    }
    return this.appendUnfencedForTest(sessionId, event);
  }

  /** 只用于构造旧副本绕过终态 marker 的历史交错。 */
  appendUnfencedForTest(sessionId: string, event: Record<string, unknown>): string {
    const milliseconds = Math.max(this.now(), this.lastMilliseconds);
    this.sequence = milliseconds === this.lastMilliseconds ? this.sequence + 1 : 0;
    this.lastMilliseconds = milliseconds;
    const entry = { id: `${milliseconds}-${this.sequence}`, event };
    const stream = this.streams.get(sessionId) ?? [];
    stream.push(entry);
    if (stream.length > this.maxlen) stream.splice(0, stream.length - this.maxlen);
    this.streams.set(sessionId, stream);
    return entry.id;
  }

  async appendTerminal(
    sessionId: string,
    runId: string,
    event: Record<string, unknown>,
  ): Promise<string> {
    const key = `${sessionId}:${runId}`;
    const encoded = JSON.stringify(event);
    const existing = this.terminals.get(key);
    if (existing) {
      if (existing.encoded !== encoded) throw new Error('TERMINAL_EVENT_CONFLICT');
      return existing.id;
    }
    const id = await this.append(sessionId, event);
    this.terminals.set(key, { encoded, id });
    return id;
  }

  async repairTerminal(
    sessionId: string,
    runId: string,
    event: Record<string, unknown>,
  ): Promise<string> {
    const key = `${sessionId}:${runId}`;
    const encoded = JSON.stringify(event);
    const stream = this.streams.get(sessionId) ?? [];
    const terminals = stream.filter(
      (entry) =>
        entry.event.runId === runId &&
        (entry.event.type === 'RUN_FINISHED' || entry.event.type === 'RUN_ERROR'),
    );
    const conflicts = terminals.some((entry) => JSON.stringify(entry.event) !== encoded);
    const retained = terminals.at(-1);
    const retainedIndex = retained ? stream.indexOf(retained) : -1;
    const ordinaryAfterTerminal =
      retainedIndex >= 0 &&
      stream
        .slice(retainedIndex + 1)
        .some(
          (entry) =>
            entry.event.runId === runId &&
            entry.event.type !== 'RUN_FINISHED' &&
            entry.event.type !== 'RUN_ERROR',
        );
    if (conflicts || ordinaryAfterTerminal) {
      this.streams.set(
        sessionId,
        stream.filter((entry) => !terminals.includes(entry)),
      );
      this.terminals.delete(key);
      return this.appendTerminal(sessionId, runId, event);
    }
    if (retained) {
      this.streams.set(
        sessionId,
        stream.filter((entry) => !terminals.includes(entry) || entry === retained),
      );
      this.terminals.set(key, { encoded, id: retained.id });
      return retained.id;
    }
    this.terminals.delete(key);
    return this.appendTerminal(sessionId, runId, event);
  }

  async rangeAfter(sessionId: string, afterId: string, count: number): Promise<StreamEventEntry[]> {
    return (this.streams.get(sessionId) ?? [])
      .filter((entry) => compareStreamIds(entry.id, afterId) > 0)
      .slice(0, count);
  }

  entries(sessionId: string): StreamEventEntry[] {
    return [...(this.streams.get(sessionId) ?? [])];
  }
}

/** 忠实假 PG（capabilities / sessions / messages / artifacts）。也可当 TxPool 用。 */
export class FakeDb implements Queryable, TxPool {
  capabilities = new Map<string, CapabilityRowF>();
  sessions = new Map<string, SessionRowF>();
  messages: MessageRowF[] = [];
  turns = new Map<string, TurnRowF>();
  artifacts = new Map<string, ArtifactRowF>();
  billingAccounts = new Map<string, BillingAccountRowF>();
  billingFreeAllowances = new Map<string, BillingFreeAllowanceRowF>();
  usageCharges = new Map<string, UsageChargeRowF>();
  walletLedger = new Map<string, WalletLedgerRowF>();
  agentUsageReceipts = new Map<string, AgentUsageReceiptRowF>();
  pendingUsageRecoveries = new Map<string, PendingUsageRecoveryRowF>();
  agentPackages = new Map<string, AgentPackageRowF>();
  agentPackageReleases = new Map<string, AgentPackageReleaseRowF>();
  /** 事务轨迹（断言 BEGIN/COMMIT/ROLLBACK 收口）。 */
  txLog: string[] = [];
  queries: string[] = [];

  seedCapability(input: Partial<CapabilityRowF> & { owner_user_id: string }): CapabilityRowF {
    const id = input.id ?? nextId('cap');
    const row: CapabilityRowF = {
      id,
      task_id: input.task_id ?? nextId('task'),
      owner_user_id: input.owner_user_id,
      name: input.name ?? '测试能力',
      summary: input.summary ?? '一句话简介',
      kind: input.kind ?? 'writing',
      storage_key: input.storage_key ?? `capabilities/${id}/definition.json`,
      published: input.published ?? false,
      ui_artifact_id: input.ui_artifact_id ?? null,
      created_at: input.created_at ?? nowIso(),
    };
    this.capabilities.set(row.id, row);
    return row;
  }

  seedBillingAccount(ownerUserId: string, balanceCents: bigint): BillingAccountRowF {
    const now = nowIso();
    const row: BillingAccountRowF = {
      owner_user_id: ownerUserId,
      balance_cents: balanceCents,
      reserved_cents: 0n,
      created_at: now,
      updated_at: now,
    };
    this.billingAccounts.set(ownerUserId, row);
    return row;
  }

  seedFreeAllowance(input: {
    ownerUserId: string;
    capabilityId: string;
    freeLimit: number;
    freeUsed?: number;
    freeReserved?: number;
  }): BillingFreeAllowanceRowF {
    const now = nowIso();
    const row: BillingFreeAllowanceRowF = {
      owner_user_id: input.ownerUserId,
      capability_id: input.capabilityId,
      policy_version: 'runtime-usage-v1',
      free_limit_snapshot: input.freeLimit,
      free_used_count: input.freeUsed ?? 0,
      free_reserved_count: input.freeReserved ?? 0,
      created_at: now,
      updated_at: now,
    };
    this.billingFreeAllowances.set(`${input.ownerUserId}:${input.capabilityId}`, row);
    return row;
  }

  seedPendingUsageRecovery(
    input: Omit<
      PendingUsageRecoveryRowF,
      | 'active_recharge_intent_id'
      | 'recovery_status'
      | 'terminal_turn_id'
      | 'expires_at'
      | 'created_at'
      | 'updated_at'
    > &
      Partial<
        Pick<
          PendingUsageRecoveryRowF,
          | 'active_recharge_intent_id'
          | 'recovery_status'
          | 'terminal_turn_id'
          | 'expires_at'
          | 'created_at'
          | 'updated_at'
        >
      >,
  ): PendingUsageRecoveryRowF {
    const now = nowIso();
    const row: PendingUsageRecoveryRowF = {
      ...input,
      active_recharge_intent_id: input.active_recharge_intent_id ?? input.usage_id,
      recovery_status: input.recovery_status ?? 'active',
      terminal_turn_id: input.terminal_turn_id ?? null,
      expires_at: input.expires_at ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      created_at: input.created_at ?? now,
      updated_at: input.updated_at ?? now,
    };
    this.pendingUsageRecoveries.set(`${row.owner_user_id}:${row.usage_id}`, row);
    return row;
  }

  seedAgentPackageRegistry(input: {
    packageDigest: string;
    releaseId: string;
    ownerUserId: string;
  }): void {
    this.agentPackages.set(input.packageDigest, {
      package_digest: input.packageDigest,
      protocol: 'combo.agent-package/1',
      owner_user_id: input.ownerUserId,
    });
    this.agentPackageReleases.set(input.releaseId, {
      release_id: input.releaseId,
      package_digest: input.packageDigest,
      owner_user_id: input.ownerUserId,
      protocol: 'combo.agent-package-release/1',
      release_scope: 'controlled_test',
    });
  }

  async connect(): Promise<TxConn> {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params),
      release: () => undefined,
    };
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push(s);

    if (
      s === 'BEGIN' ||
      s === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
      s === 'COMMIT' ||
      s === 'ROLLBACK'
    ) {
      this.txLog.push(s);
      return { rows: [], rowCount: null };
    }
    if (s.startsWith("SELECT set_config('lock_timeout'")) {
      return { rows: [{}] as R[], rowCount: 1 };
    }

    // ---------- usage billing ----------
    if (s.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [{}] as R[], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO pending_usage_recoveries')) {
      const [
        ownerUserId,
        usageId,
        sessionId,
        capabilityId,
        requestText,
        requestFingerprint,
        capabilityProtocol,
        releaseId,
        packageDigest,
        releaseScope,
        knowledgeResourcePath,
        knowledgeResourceDigest,
        billingPolicyVersion,
        validatorPolicyVersion,
        unitPriceRaw,
        freeLimitSnapshot,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        'controlled_test',
        string,
        string,
        string,
        string,
        string,
        number,
      ];
      const key = `${ownerUserId}:${usageId}`;
      const activeForSession = [...this.pendingUsageRecoveries.values()].find(
        (row) => row.session_id === sessionId && row.recovery_status === 'active',
      );
      if (this.pendingUsageRecoveries.has(key) || activeForSession) {
        return { rows: [], rowCount: 0 };
      }
      const now = nowIso();
      const row: PendingUsageRecoveryRowF = {
        owner_user_id: ownerUserId,
        usage_id: usageId,
        session_id: sessionId,
        capability_id: capabilityId,
        request_text: requestText,
        request_fingerprint: requestFingerprint,
        product_kind: 'knowledge_agent_test',
        capability_protocol: capabilityProtocol,
        release_id: releaseId,
        package_digest: packageDigest,
        release_scope: releaseScope,
        knowledge_resource_path: knowledgeResourcePath,
        knowledge_resource_digest: knowledgeResourceDigest,
        billing_policy_version: billingPolicyVersion,
        validator_policy_version: validatorPolicyVersion,
        unit_price_cents: BigInt(unitPriceRaw),
        free_limit_snapshot: freeLimitSnapshot,
        active_recharge_intent_id: usageId,
        recovery_status: 'active',
        terminal_turn_id: null,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        created_at: now,
        updated_at: now,
      };
      this.pendingUsageRecoveries.set(key, row);
      return { rows: [{ ...row, is_unexpired: true }] as R[], rowCount: 1 };
    }
    if (
      s.startsWith(
        'SELECT owner_user_id, usage_id, session_id, capability_id, request_text, request_fingerprint, product_kind, capability_protocol, release_id,',
      ) &&
      s.includes('FROM pending_usage_recoveries')
    ) {
      let rows = [...this.pendingUsageRecoveries.values()];
      if (s.includes('WHERE owner_user_id = $1 AND usage_id = $2')) {
        rows = rows.filter((row) => row.owner_user_id === params[0] && row.usage_id === params[1]);
      } else if (s.includes('WHERE owner_user_id = $1 AND session_id = $2')) {
        rows = rows.filter(
          (row) =>
            row.owner_user_id === params[0] &&
            row.session_id === params[1] &&
            row.recovery_status === 'active',
        );
      } else {
        rows = rows.filter(
          (row) =>
            row.owner_user_id === params[0] &&
            row.recovery_status === 'active' &&
            new Date(row.expires_at).getTime() > Date.now() &&
            (params[1] === null || row.session_id === params[1]),
        );
        rows.sort(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            left.usage_id.localeCompare(right.usage_id),
        );
        rows = rows.slice(0, 100);
      }
      return {
        rows: rows.map((row) => ({
          ...row,
          is_unexpired: new Date(row.expires_at).getTime() > Date.now(),
        })) as R[],
        rowCount: rows.length,
      };
    }
    if (s.includes('SELECT id, name, summary, kind FROM capabilities WHERE id = $1')) {
      const c = this.capabilities.get(params[0] as string);
      if (!c) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: c.id, name: c.name, summary: c.summary, kind: c.kind }] as R[],
        rowCount: 1,
      };
    }
    if (s.startsWith('SELECT owner_user_id, usage_id, session_id FROM pending_usage_recoveries')) {
      const rows = [...this.pendingUsageRecoveries.values()]
        .filter(
          (row) =>
            row.recovery_status === 'active' && new Date(row.expires_at).getTime() <= Date.now(),
        )
        .sort(
          (left, right) =>
            left.expires_at.localeCompare(right.expires_at) ||
            left.owner_user_id.localeCompare(right.owner_user_id) ||
            left.usage_id.localeCompare(right.usage_id),
        )
        .slice(0, Number(params[0]));
      return {
        rows: rows.map((row) => ({
          owner_user_id: row.owner_user_id,
          usage_id: row.usage_id,
          session_id: row.session_id,
        })) as R[],
        rowCount: rows.length,
      };
    }
    if (s.startsWith('SELECT EXISTS ( SELECT 1 FROM usage_charges')) {
      const exists = [...this.usageCharges.values()].some(
        (row) => row.owner_user_id === params[0] && row.usage_id === params[1],
      );
      return { rows: [{ exists }] as R[], rowCount: 1 };
    }
    if (s.startsWith('UPDATE pending_usage_recoveries')) {
      const key = `${String(params[0])}:${String(params[1])}`;
      const row = this.pendingUsageRecoveries.get(key);
      if (!row || row.recovery_status !== 'active') return { rows: [], rowCount: 0 };
      row.request_text = null;
      if (s.includes('recovery_status = $3')) {
        row.recovery_status = params[2] as 'accepted' | 'abandoned';
        row.terminal_turn_id = String(params[3]);
      } else {
        row.recovery_status = 'abandoned';
        row.terminal_turn_id = params[2] === null ? null : String(params[2]);
      }
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO billing_accounts')) {
      const ownerUserId = params[0] as string;
      if (!this.billingAccounts.has(ownerUserId)) {
        const now = nowIso();
        this.billingAccounts.set(ownerUserId, {
          owner_user_id: ownerUserId,
          balance_cents: 0n,
          reserved_cents: 0n,
          created_at: now,
          updated_at: now,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (
      s.startsWith('SELECT balance_cents, reserved_cents FROM billing_accounts') &&
      s.endsWith('FOR UPDATE')
    ) {
      const row = this.billingAccounts.get(params[0] as string);
      return row ? { rows: [{ ...row }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('UPDATE billing_accounts SET balance_cents = balance_cents - $2::bigint')) {
      const [ownerUserId, amountRaw] = params as [string, string];
      const row = this.billingAccounts.get(ownerUserId);
      const amount = BigInt(amountRaw);
      if (!row || row.balance_cents < amount) return { rows: [], rowCount: 0 };
      row.balance_cents -= amount;
      row.reserved_cents += amount;
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }
    if (
      s.startsWith('UPDATE billing_accounts SET reserved_cents = reserved_cents - $2::bigint') &&
      s.includes('balance_cents = balance_cents + $2::bigint')
    ) {
      const [ownerUserId, amountRaw] = params as [string, string];
      const row = this.billingAccounts.get(ownerUserId);
      const amount = BigInt(amountRaw);
      if (!row || row.reserved_cents < amount) return { rows: [], rowCount: 0 };
      row.reserved_cents -= amount;
      row.balance_cents += amount;
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE billing_accounts SET reserved_cents = reserved_cents - $2::bigint')) {
      const [ownerUserId, amountRaw] = params as [string, string];
      const row = this.billingAccounts.get(ownerUserId);
      const amount = BigInt(amountRaw);
      if (!row || row.reserved_cents < amount) return { rows: [], rowCount: 0 };
      row.reserved_cents -= amount;
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO billing_free_allowances')) {
      const [ownerUserId, capabilityId, policyVersion, freeLimitSnapshot] = params as [
        string,
        string,
        string,
        number,
      ];
      const key = `${ownerUserId}:${capabilityId}`;
      if (!this.billingFreeAllowances.has(key)) {
        const now = nowIso();
        this.billingFreeAllowances.set(key, {
          owner_user_id: ownerUserId,
          capability_id: capabilityId,
          policy_version: policyVersion,
          free_limit_snapshot: freeLimitSnapshot,
          free_used_count: 0,
          free_reserved_count: 0,
          created_at: now,
          updated_at: now,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (
      s.startsWith(
        'SELECT policy_version, free_limit_snapshot, free_used_count, free_reserved_count FROM billing_free_allowances',
      )
    ) {
      const row = this.billingFreeAllowances.get(`${String(params[0])}:${String(params[1])}`);
      return row ? { rows: [{ ...row }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (
      s.startsWith(
        'UPDATE billing_free_allowances SET free_reserved_count = free_reserved_count + 1',
      )
    ) {
      const row = this.billingFreeAllowances.get(`${String(params[0])}:${String(params[1])}`);
      if (!row || row.free_used_count + row.free_reserved_count >= row.free_limit_snapshot) {
        return { rows: [], rowCount: 0 };
      }
      row.free_reserved_count += 1;
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }
    if (
      s.startsWith(
        'UPDATE billing_free_allowances SET free_reserved_count = free_reserved_count - 1, free_used_count = free_used_count + 1',
      )
    ) {
      const row = this.billingFreeAllowances.get(`${String(params[0])}:${String(params[1])}`);
      if (!row || row.free_reserved_count <= 0) return { rows: [], rowCount: 0 };
      row.free_reserved_count -= 1;
      row.free_used_count += 1;
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }
    if (
      s.startsWith(
        'UPDATE billing_free_allowances SET free_reserved_count = free_reserved_count - 1',
      )
    ) {
      const row = this.billingFreeAllowances.get(`${String(params[0])}:${String(params[1])}`);
      if (!row || row.free_reserved_count <= 0) return { rows: [], rowCount: 0 };
      row.free_reserved_count -= 1;
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }
    if (
      s.startsWith(
        'SELECT id, owner_user_id, usage_id, capability_id, session_id, turn_id, request_fingerprint, charge_source, status, unit_price_cents, free_limit_snapshot, reserved_cents, settled_cents, product_kind',
      ) &&
      s.includes('FROM usage_charges')
    ) {
      const row = s.includes('WHERE turn_id = $1')
        ? [...this.usageCharges.values()].find((candidate) => candidate.turn_id === params[0])
        : [...this.usageCharges.values()].find(
            (candidate) =>
              candidate.owner_user_id === params[0] && candidate.usage_id === params[1],
          );
      return row ? { rows: [{ ...row }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (
      s.startsWith(
        'SELECT owner_user_id, usage_id, session_id FROM usage_charges WHERE turn_id = $1',
      )
    ) {
      const row = [...this.usageCharges.values()].find(
        (candidate) =>
          candidate.turn_id === params[0] && candidate.product_kind === 'knowledge_agent_test',
      );
      return row
        ? {
            rows: [
              {
                owner_user_id: row.owner_user_id,
                usage_id: row.usage_id,
                session_id: row.session_id,
              },
            ] as R[],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT product_kind FROM usage_charges WHERE turn_id = $1')) {
      const row = [...this.usageCharges.values()].find(
        (candidate) => candidate.turn_id === params[0],
      );
      return row
        ? { rows: [{ product_kind: row.product_kind }] as R[], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (
      s.startsWith(
        "SELECT uc.turn_id, t.session_id, t.status AS turn_status, uc.product_kind FROM usage_charges uc JOIN turns t ON t.id = uc.turn_id WHERE uc.status = 'reserved'",
      )
    ) {
      const rows = [...this.usageCharges.values()]
        .flatMap((charge) => {
          const turn = this.turns.get(charge.turn_id);
          return charge.status === 'reserved' &&
            turn &&
            ['completed', 'failed', 'interrupted'].includes(turn.status)
            ? [
                {
                  turn_id: charge.turn_id,
                  session_id: turn.session_id,
                  turn_status: turn.status,
                  product_kind: charge.product_kind,
                },
              ]
            : [];
        })
        .slice(0, 100);
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (s.startsWith('INSERT INTO usage_charges')) {
      const knowledge = s.includes("'knowledge_agent_test'");
      const [
        ownerUserId,
        usageId,
        capabilityId,
        sessionId,
        turnId,
        requestFingerprint,
        chargeSource,
        unitPriceRaw,
        freeLimitSnapshot,
        reservedRaw,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        UsageChargeRowF['charge_source'],
        string,
        number,
        string,
      ];
      if (
        [...this.usageCharges.values()].some(
          (row) =>
            (row.owner_user_id === ownerUserId && row.usage_id === usageId) ||
            row.turn_id === turnId,
        )
      ) {
        throw Object.assign(new Error('duplicate usage charge'), {
          code: '23505',
          constraint: 'uq_usage_charges_owner_usage',
        });
      }
      const now = nowIso();
      const row: UsageChargeRowF = {
        id: nextId('usage'),
        owner_user_id: ownerUserId,
        usage_id: usageId,
        capability_id: capabilityId,
        session_id: sessionId,
        turn_id: turnId,
        request_fingerprint: requestFingerprint,
        charge_source: chargeSource,
        status: 'reserved',
        unit_price_cents: BigInt(unitPriceRaw),
        free_limit_snapshot: freeLimitSnapshot,
        reserved_cents: BigInt(reservedRaw),
        settled_cents: 0n,
        product_kind: knowledge ? 'knowledge_agent_test' : 'legacy_capability',
        capability_protocol: knowledge ? String(params[10]) : null,
        release_id: knowledge ? String(params[11]) : null,
        package_digest: knowledge ? String(params[12]) : null,
        release_scope: knowledge ? String(params[13]) : null,
        knowledge_resource_path: knowledge ? String(params[14]) : null,
        knowledge_resource_digest: knowledge ? String(params[15]) : null,
        billing_policy_version: knowledge ? String(params[16]) : null,
        validator_policy_version: knowledge ? String(params[17]) : null,
        execution_outcome: null,
        created_at: now,
        updated_at: now,
        finished_at: null,
      };
      this.usageCharges.set(row.id, row);
      return { rows: [{ id: row.id }] as R[], rowCount: 1 };
    }
    if (s.startsWith("UPDATE usage_charges SET status = 'completed'")) {
      const [id, settledRaw] = params as [string, string];
      const row = this.usageCharges.get(id);
      if (!row || row.status !== 'reserved') return { rows: [], rowCount: 0 };
      row.status = 'completed';
      row.settled_cents = BigInt(settledRaw);
      if (row.product_kind === 'knowledge_agent_test') row.execution_outcome = 'answered';
      row.finished_at = nowIso();
      row.updated_at = row.finished_at;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE usage_charges SET status = 'released'")) {
      const row = this.usageCharges.get(params[0] as string);
      if (!row || row.status !== 'reserved') return { rows: [], rowCount: 0 };
      row.status = 'released';
      row.settled_cents = 0n;
      if (row.product_kind === 'knowledge_agent_test') {
        row.execution_outcome = params[1] as UsageChargeRowF['execution_outcome'];
      }
      row.finished_at = nowIso();
      row.updated_at = row.finished_at;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO wallet_ledger')) {
      const [ownerUserId, amountRaw, usageChargeId] = params as [string, string, string];
      const existing = [...this.walletLedger.values()].find(
        (row) => row.entry_type === 'usage_debit' && row.usage_charge_id === usageChargeId,
      );
      if (existing) return { rows: [], rowCount: 0 };
      const row: WalletLedgerRowF = {
        id: nextId('ledger'),
        owner_user_id: ownerUserId,
        entry_type: 'usage_debit',
        amount_cents: BigInt(amountRaw),
        recharge_order_id: null,
        usage_charge_id: usageChargeId,
        created_at: nowIso(),
      };
      this.walletLedger.set(row.id, row);
      return { rows: [{ id: row.id }] as R[], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO agent_usage_receipts')) {
      const chargeId = String(params[0]);
      if (
        [...this.agentUsageReceipts.values()].some(
          (candidate) =>
            candidate.usage_charge_id === chargeId ||
            candidate.turn_id === params[5] ||
            (candidate.owner_user_id === params[1] && candidate.usage_id === params[2]),
        )
      ) {
        throw Object.assign(new Error('duplicate knowledge receipt'), { code: '23505' });
      }
      const row: AgentUsageReceiptRowF = {
        id: nextUuid(),
        protocol: 'combo.agent-usage-receipt/1',
        usage_charge_id: chargeId,
        owner_user_id: String(params[1]),
        usage_id: String(params[2]),
        capability_id: String(params[3]),
        session_id: String(params[4]),
        turn_id: String(params[5]),
        product_kind: 'knowledge_agent_test',
        capability_protocol: String(params[6]),
        release_id: String(params[7]),
        package_digest: String(params[8]),
        release_scope: 'controlled_test',
        knowledge_resource_path: String(params[10]),
        knowledge_resource_digest: String(params[11]),
        billing_policy_version: String(params[12]),
        validator_policy_version: String(params[13]),
        unit_price_cents: BigInt(String(params[14])),
        free_limit_snapshot: Number(params[15]),
        charge_source: params[16] as UsageChargeRowF['charge_source'],
        settled_cents: BigInt(String(params[17])),
        execution_outcome: params[18] as AgentUsageReceiptRowF['execution_outcome'],
        validation_code: String(params[19]),
        response_message_id: params[20] === null ? null : String(params[20]),
        response_digest: params[21] === null ? null : String(params[21]),
        citation_chunk_ids: [...(params[22] as string[])],
        execution_environment: 'test',
        runtime_release_id: String(params[23]),
        runtime_source_sha: String(params[24]),
        created_at: nowIso(),
      };
      this.agentUsageReceipts.set(row.id, row);
      return { rows: [{ id: row.id }] as R[], rowCount: 1 };
    }
    if (s.includes('FROM agent_usage_receipts') && s.includes('WHERE session_id = $1')) {
      const rows = [...this.agentUsageReceipts.values()]
        .filter((candidate) => candidate.session_id === params[0])
        .sort((left, right) =>
          left.created_at === right.created_at
            ? left.id.localeCompare(right.id)
            : left.created_at.localeCompare(right.created_at),
        );
      return { rows: rows.map((row) => ({ ...row })) as R[], rowCount: rows.length };
    }

    // ---------- immutable Agent Package Registry ----------
    if (s.includes('FROM agent_package_releases r') && s.includes('JOIN agent_packages p')) {
      const release = this.agentPackageReleases.get(String(params[0]));
      const agentPackage = release ? this.agentPackages.get(release.package_digest) : undefined;
      if (!release || !agentPackage || release.package_digest !== params[1]) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            release_id: release.release_id,
            package_digest: release.package_digest,
            owner_user_id: release.owner_user_id,
            release_protocol: release.protocol,
            release_scope: release.release_scope,
            package_protocol: agentPackage.protocol,
          },
        ] as R[],
        rowCount: 1,
      };
    }

    // ---------- capabilities ----------
    if (s.startsWith('UPDATE capabilities c SET ui_artifact_id = $2')) {
      const [capabilityId, artifactId, studioSessionId, turnId] = params as [
        string,
        string,
        string,
        string | undefined,
      ];
      const capability = this.capabilities.get(capabilityId);
      const artifact = this.artifacts.get(artifactId);
      const session = this.sessions.get(studioSessionId);
      if (
        !capability ||
        (s.includes('c.ui_artifact_id IS NULL') && capability.ui_artifact_id !== null) ||
        !artifact ||
        artifact.session_id !== studioSessionId ||
        artifact.kind !== 'html' ||
        (s.includes('a.turn_id = $4') &&
          (artifact.turn_id !== turnId ||
            this.turns.get(turnId ?? '')?.session_id !== artifact.session_id ||
            this.turns.get(turnId ?? '')?.status !== 'completed')) ||
        (s.includes('a.turn_id IS NULL') && artifact.turn_id != null) ||
        !session ||
        session.capability_id !== capabilityId ||
        session.owner_user_id !== capability.owner_user_id ||
        session.mode !== 'studio'
      ) {
        return { rows: [], rowCount: 0 };
      }
      capability.ui_artifact_id = artifactId;
      return { rows: [{ id: capabilityId }] as R[], rowCount: 1 };
    }
    if (s.includes('FROM capabilities c JOIN artifacts a ON a.id = c.ui_artifact_id')) {
      const capability = this.capabilities.get(params[0] as string);
      const artifact = capability?.ui_artifact_id
        ? this.artifacts.get(capability.ui_artifact_id)
        : undefined;
      const session = artifact ? this.sessions.get(artifact.session_id) : undefined;
      if (
        !capability ||
        !artifact ||
        artifact.kind !== 'html' ||
        (artifact.turn_id != null &&
          (this.turns.get(artifact.turn_id)?.session_id !== artifact.session_id ||
            this.turns.get(artifact.turn_id)?.status !== 'completed')) ||
        !session ||
        session.capability_id !== capability.id ||
        session.owner_user_id !== capability.owner_user_id ||
        session.mode !== 'studio'
      ) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ ...artifact }] as R[], rowCount: 1 };
    }
    if (s.includes('FROM capabilities WHERE id = $1') && s.includes('storage_key')) {
      const c = this.capabilities.get(params[0] as string);
      return c ? { rows: [{ ...c }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (
      s.includes(
        'SELECT id, owner_user_id, name, summary, kind, published FROM capabilities WHERE id = $1',
      )
    ) {
      const c = this.capabilities.get(params[0] as string);
      if (!c) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: c.id,
            owner_user_id: c.owner_user_id,
            name: c.name,
            summary: c.summary,
            kind: c.kind,
            published: c.published,
          },
        ] as R[],
        rowCount: 1,
      };
    }
    if (s.includes('FROM capabilities WHERE owner_user_id = $1 OR published = true')) {
      const owner = params[0] as string;
      const rows = [...this.capabilities.values()]
        .filter((c) => c.owner_user_id === owner || c.published)
        .sort((a, b) => (a.id < b.id ? 1 : -1)) // created_at DESC（id 时间有序等价）
        .slice(0, 100)
        .map((c) => ({ ...c }));
      return { rows: rows as R[], rowCount: rows.length };
    }

    // ---------- sessions ----------
    if (s.startsWith('INSERT INTO sessions')) {
      const [capabilityId, ownerUserId] = params as [string, string];
      const mode: SessionRowF['mode'] = s.includes("'studio'") ? 'studio' : 'consume';
      const knowledge = s.startsWith(
        'INSERT INTO sessions (capability_id, owner_user_id, mode, product_kind, capability_protocol',
      );
      if (mode === 'studio' && s.includes('ON CONFLICT')) {
        const existing = [...this.sessions.values()].find(
          (row) =>
            row.owner_user_id === ownerUserId &&
            row.capability_id === capabilityId &&
            row.status === 'active' &&
            row.mode === 'studio',
        );
        if (existing) return { rows: [{ ...existing }] as R[], rowCount: 1 };
      }
      const now = nowIso();
      const row: SessionRowF = {
        id: nextId('sess'),
        capability_id: capabilityId,
        owner_user_id: ownerUserId,
        mode,
        product_kind: knowledge ? 'knowledge_agent_test' : 'legacy_capability',
        capability_protocol: knowledge ? (params[3] as string) : null,
        release_id: knowledge ? (params[4] as string) : null,
        package_digest: knowledge ? (params[5] as string) : null,
        release_scope: knowledge ? (params[6] as string) : null,
        knowledge_resource_path: knowledge ? (params[7] as string) : null,
        knowledge_resource_digest: knowledge ? (params[8] as string) : null,
        title: null,
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      this.sessions.set(row.id, row);
      return { rows: [{ ...row }] as R[], rowCount: 1 };
    }
    if (
      s.includes('FROM sessions WHERE owner_user_id = $1') &&
      s.includes('ORDER BY updated_at DESC')
    ) {
      // 对齐真 SQL：$2 为 null 不过滤，否则只留该能力下的会话。
      const owner = params[0] as string;
      const capabilityId = (params[1] ?? null) as string | null;
      const mode = (params[2] ?? 'consume') as SessionRowF['mode'];
      const rows = [...this.sessions.values()]
        .filter((x) => x.owner_user_id === owner)
        .filter((x) => x.status === 'active')
        .filter((x) => capabilityId === null || x.capability_id === capabilityId)
        .filter((x) => x.mode === mode)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, 100)
        .map((x) => ({ ...x }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (
      s.startsWith('SELECT id FROM sessions WHERE id = $1 AND capability_id = $2') &&
      s.includes('owner_user_id = $3') &&
      s.includes('mode = $4') &&
      s.includes("status = 'active'") &&
      s.endsWith('FOR UPDATE')
    ) {
      const [id, capabilityId, ownerUserId, mode] = params as [
        string,
        string,
        string,
        SessionRowF['mode'],
      ];
      const session = this.sessions.get(id);
      if (
        !session ||
        session.capability_id !== capabilityId ||
        session.owner_user_id !== ownerUserId ||
        session.mode !== mode ||
        session.status !== 'active'
      ) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ id: session.id }] as R[], rowCount: 1 };
    }
    if (s === 'SELECT id FROM sessions WHERE id = $1 FOR UPDATE') {
      const session = this.sessions.get(params[0] as string);
      return session
        ? { rows: [{ id: session.id }] as R[], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s === 'SELECT product_kind FROM sessions WHERE id = $1') {
      const session = this.sessions.get(params[0] as string);
      return session
        ? { rows: [{ product_kind: session.product_kind }] as R[], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM sessions WHERE id = $1 AND owner_user_id = $2')) {
      const x = this.sessions.get(params[0] as string);
      if (!x || x.owner_user_id !== params[1] || x.status !== 'active') {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ ...x }] as R[], rowCount: 1 };
    }
    if (s.startsWith('UPDATE sessions SET title = $3')) {
      const [id, ownerUserId, title] = params as [string, string, string];
      const x = this.sessions.get(id);
      if (!x || x.owner_user_id !== ownerUserId || x.status !== 'active') {
        return { rows: [], rowCount: 0 };
      }
      x.title = title;
      x.updated_at = nowIso();
      return { rows: [{ ...x }] as R[], rowCount: 1 };
    }
    if (s.startsWith("UPDATE sessions SET status = 'closed'")) {
      const [id, ownerUserId] = params as [string, string];
      const x = this.sessions.get(id);
      const guardsRunningTurn =
        s.includes('NOT EXISTS') &&
        s.includes('FROM turns') &&
        s.includes("turns.session_id = sessions.id AND turns.status = 'running'");
      const hasRunningTurn =
        guardsRunningTurn &&
        [...this.turns.values()].some(
          (turn) => turn.session_id === id && turn.status === 'running',
        );
      if (!x || x.owner_user_id !== ownerUserId || x.status !== 'active' || hasRunningTurn) {
        return { rows: [], rowCount: 0 };
      }
      x.status = 'closed';
      x.updated_at = nowIso();
      return { rows: [{ ...x }] as R[], rowCount: 1 };
    }
    if (s.includes('UPDATE sessions SET updated_at = now(), title = COALESCE(title, $2)')) {
      const [id, title] = params as [string, string | null];
      const x = this.sessions.get(id);
      if (!x) return { rows: [], rowCount: 0 };
      x.updated_at = nowIso();
      x.title = x.title ?? title;
      return { rows: [], rowCount: 1 };
    }

    // ---------- turns ----------
    if (s.startsWith('INSERT INTO turns')) {
      const [id, sessionId] = params as [string, string];
      if (
        [...this.turns.values()].some(
          (turn) => turn.session_id === sessionId && turn.status === 'running',
        )
      ) {
        throw Object.assign(new Error('duplicate running turn'), {
          code: '23505',
          constraint: 'uq_turns_session_running',
        });
      }
      const row: TurnRowF = {
        id,
        session_id: sessionId,
        status: 'running',
        last_error: null,
        created_at: nowIso(),
        finished_at: null,
      };
      this.turns.set(id, row);
      return { rows: [{ ...row }] as R[], rowCount: 1 };
    }
    if (
      s.startsWith('SELECT id, created_at FROM turns') &&
      s.includes("session_id = $1 AND status = 'running'")
    ) {
      const row = [...this.turns.values()].find(
        (candidate) => candidate.session_id === params[0] && candidate.status === 'running',
      );
      return row
        ? { rows: [{ id: row.id, created_at: row.created_at }] as R[], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (
      s.startsWith('SELECT id FROM turns') &&
      s.includes("id = $1 AND session_id = $2 AND status = 'running'")
    ) {
      const [id, sessionId] = params as [string, string];
      const row = this.turns.get(id);
      return row?.session_id === sessionId && row.status === 'running'
        ? { rows: [{ id: row.id }] as R[], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (
      s.startsWith('SELECT status FROM turns') &&
      s.includes('WHERE id = $1 AND session_id = $2') &&
      s.endsWith('FOR UPDATE')
    ) {
      const row = this.turns.get(params[0] as string);
      if (!row || row.session_id !== params[1]) return { rows: [], rowCount: 0 };
      return { rows: [{ status: row.status }] as R[], rowCount: 1 };
    }
    if (s.startsWith('UPDATE turns SET status = $2')) {
      const [id, status, errorJson] = params as [string, TurnRowF['status'], string | null];
      const row = this.turns.get(id);
      if (!row || row.status !== 'running') return { rows: [], rowCount: 0 };
      row.status = status;
      row.finished_at = nowIso();
      row.last_error = errorJson ? (JSON.parse(errorJson) as TurnRowF['last_error']) : null;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE turns SET status = 'failed'")) {
      const [id, errorJson] = params as [string, string];
      const row = this.turns.get(id);
      if (!row || row.status !== 'running') return { rows: [], rowCount: 0 };
      row.status = 'failed';
      row.finished_at = nowIso();
      row.last_error = JSON.parse(errorJson) as TurnRowF['last_error'];
      return { rows: [], rowCount: 1 };
    }
    if (
      s.startsWith('SELECT id FROM turns') &&
      s.includes("session_id = $1 AND status = 'running'")
    ) {
      const row = [...this.turns.values()].find(
        (candidate) => candidate.session_id === params[0] && candidate.status === 'running',
      );
      return row ? { rows: [{ id: row.id }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (
      s.startsWith(
        'SELECT id, session_id, status, last_error, created_at, finished_at FROM turns',
      ) &&
      s.includes("id = $1 AND session_id = $2 AND status <> 'running'")
    ) {
      const [id, sessionId] = params as [string, string];
      const row = this.turns.get(id);
      return row?.session_id === sessionId && row.status !== 'running'
        ? { rows: [{ ...row }] as R[], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT EXISTS (SELECT 1 FROM turns')) {
      const exists = [...this.turns.values()].some(
        (row) => row.session_id === params[0] && row.status === 'running',
      );
      return { rows: [{ exists }] as R[], rowCount: 1 };
    }
    if (
      s.startsWith("SELECT id, status, last_error ->> 'code' AS error_code FROM turns") &&
      s.includes("status <> 'running'")
    ) {
      const row = [...this.turns.values()]
        .filter((candidate) => candidate.session_id === params[0] && candidate.status !== 'running')
        .sort(
          (a, b) =>
            (b.finished_at ?? '').localeCompare(a.finished_at ?? '') ||
            b.created_at.localeCompare(a.created_at) ||
            b.id.localeCompare(a.id),
        )[0];
      return row
        ? {
            rows: [
              {
                id: row.id,
                status: row.status,
                error_code: row.last_error?.code ?? null,
              },
            ] as R[],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (
      s.startsWith(
        'SELECT id, session_id, status, last_error, created_at, finished_at FROM turns',
      ) &&
      s.includes("status <> 'running'")
    ) {
      const row = [...this.turns.values()]
        .filter((candidate) => candidate.session_id === params[0] && candidate.status !== 'running')
        .sort(
          (a, b) =>
            (b.finished_at ?? '').localeCompare(a.finished_at ?? '') ||
            b.created_at.localeCompare(a.created_at) ||
            b.id.localeCompare(a.id),
        )[0];
      return row ? { rows: [{ ...row }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (
      s.startsWith('SELECT t.id, t.session_id FROM turns t JOIN sessions s') &&
      s.includes("s.product_kind = 'legacy_capability'")
    ) {
      const cutoff = (params[0] as Date).getTime();
      const rows = [...this.turns.values()]
        .filter((row) => {
          const session = this.sessions.get(row.session_id);
          return (
            row.status === 'running' &&
            new Date(row.created_at).getTime() < cutoff &&
            session?.product_kind === 'legacy_capability'
          );
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        .map(({ id, session_id }) => ({ id, session_id }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (
      s.startsWith('SELECT t.id, t.session_id FROM turns t JOIN usage_charges uc') &&
      s.includes("uc.product_kind = 'knowledge_agent_test'")
    ) {
      const cutoff = (params[0] as Date).getTime();
      const rows = [...this.turns.values()]
        .filter((row) => {
          const charge = [...this.usageCharges.values()].find(
            (candidate) => candidate.turn_id === row.id,
          );
          return (
            row.status === 'running' &&
            new Date(row.created_at).getTime() < cutoff &&
            charge?.product_kind === 'knowledge_agent_test'
          );
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        .map(({ id, session_id }) => ({ id, session_id }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (s.startsWith('SELECT id, session_id FROM turns')) {
      const cutoff = (params[0] as Date).getTime();
      const rows = [...this.turns.values()]
        .filter((row) => row.status === 'running' && new Date(row.created_at).getTime() < cutoff)
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        .map(({ id, session_id }) => ({ id, session_id }));
      return { rows: rows as R[], rowCount: rows.length };
    }

    // ---------- messages ----------
    if (
      s.startsWith('INSERT INTO messages') &&
      s.includes('SELECT $1, $2, COALESCE(MAX(idx), 0)')
    ) {
      const [sessionId, turnId, contentJson] = params as [string, string, string];
      const indexes = this.messages.flatMap((m) =>
        m.turn_id === turnId && m.idx !== null ? [m.idx] : [],
      );
      const idx = (indexes.length ? Math.max(...indexes) : 0) + 1;
      const row: MessageRowF = {
        id: nextUuid(),
        session_id: sessionId,
        turn_id: turnId,
        idx,
        seq: null,
        role: 'assistant',
        content: JSON.parse(contentJson) as unknown[],
        status: 'failed',
        created_at: nowIso(),
      };
      this.messages.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO messages') && s.includes('VALUES ($1, $2, $3, NULL')) {
      const [sessionId, turnId, idx, role, contentJson, status] = params as [
        string,
        string,
        number,
        string,
        string,
        string,
      ];
      if (this.messages.some((m) => m.turn_id === turnId && m.idx === idx)) {
        const err = Object.assign(
          new Error('duplicate key value violates "uq_messages_turn_idx"'),
          { code: '23505' },
        );
        throw err;
      }
      const row: MessageRowF = {
        id: nextUuid(),
        session_id: sessionId,
        turn_id: turnId,
        idx,
        seq: null,
        role,
        content: JSON.parse(contentJson) as unknown[],
        status,
        created_at: nowIso(),
      };
      this.messages.push(row);
      return { rows: [{ ...row }] as R[], rowCount: 1 };
    }
    if (s.startsWith('SELECT count(*) AS count FROM messages')) {
      const count = this.messages.filter((m) => m.session_id === params[0]).length;
      return { rows: [{ count: String(count) }] as R[], rowCount: 1 };
    }
    if (s.includes('FROM messages m LEFT JOIN turns t')) {
      // 忠实于真 SQL:不做可见性过滤(详情要看到运行中/失败轮的消息),只按会话取全量后合并排序。
      const rows = this.messages
        .filter((m) => m.session_id === params[0])
        .sort((a, b) => {
          const ta = a.turn_id
            ? (this.turns.get(a.turn_id)?.created_at ?? a.created_at)
            : a.created_at;
          const tb = b.turn_id
            ? (this.turns.get(b.turn_id)?.created_at ?? b.created_at)
            : b.created_at;
          return (
            ta.localeCompare(tb) ||
            (a.idx ?? a.seq ?? 0) - (b.idx ?? b.seq ?? 0) ||
            a.created_at.localeCompare(b.created_at)
          );
        })
        .map((m) => ({
          ...m,
          turn_status: m.turn_id ? (this.turns.get(m.turn_id)?.status ?? null) : null,
          turn_created_at: m.turn_id ? (this.turns.get(m.turn_id)?.created_at ?? null) : null,
        }));
      return { rows: rows as R[], rowCount: rows.length };
    }

    // ---------- artifacts ----------
    if (
      s.includes('FROM artifacts a JOIN sessions s ON s.id = a.session_id') &&
      s.includes('JOIN capabilities c ON c.id = s.capability_id') &&
      s.includes("s.mode = 'consume'")
    ) {
      const [capabilityId, ownerUserId, targetStudioSessionId] = params as [string, string, string];
      const capability = this.capabilities.get(capabilityId);
      const target = this.sessions.get(targetStudioSessionId);
      if (
        !capability ||
        capability.owner_user_id !== ownerUserId ||
        capability.ui_artifact_id !== null ||
        !target ||
        target.capability_id !== capabilityId ||
        target.owner_user_id !== ownerUserId ||
        target.mode !== 'studio'
      ) {
        return { rows: [], rowCount: 0 };
      }
      const rows = [...this.artifacts.values()]
        .filter((artifact) => {
          const sourceSession = this.sessions.get(artifact.session_id);
          return (
            artifact.kind === 'html' &&
            artifact.created_at < target.created_at &&
            sourceSession?.capability_id === capabilityId &&
            sourceSession.owner_user_id === ownerUserId &&
            sourceSession.mode === 'consume' &&
            (artifact.turn_id == null ||
              (this.turns.get(artifact.turn_id)?.session_id === artifact.session_id &&
                this.turns.get(artifact.turn_id)?.status === 'completed'))
          );
        })
        .sort(
          (a, b) =>
            b.updated_at.localeCompare(a.updated_at) || b.created_at.localeCompare(a.created_at),
        )
        .slice(0, 20)
        .map((artifact) => ({ ...artifact }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (s.startsWith('INSERT INTO artifacts')) {
      const [id, sessionId, kind, title, storageKey, metaJson, turnId] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
      ];
      const existing = this.artifacts.get(id);
      const now = nowIso();
      if (existing && existing.session_id !== sessionId) {
        return { rows: [], rowCount: 0 };
      }
      const row: ArtifactRowF = existing
        ? {
            ...existing,
            kind,
            title,
            storage_key: storageKey,
            meta: JSON.parse(metaJson),
            turn_id: turnId,
            updated_at: now,
          }
        : {
            id,
            session_id: sessionId,
            kind,
            title,
            storage_key: storageKey,
            meta: JSON.parse(metaJson) as Record<string, unknown>,
            turn_id: turnId,
            created_at: now,
            updated_at: now,
          };
      this.artifacts.set(id, row);
      return {
        rows: [
          {
            id: row.id,
            session_id: row.session_id,
            turn_id: row.turn_id ?? null,
            kind: row.kind,
            title: row.title,
            storage_key: row.storage_key,
            meta: row.meta,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
        ] as R[],
        rowCount: 1,
      };
    }
    if (s.includes('SELECT id FROM artifacts WHERE id = $1 AND session_id = $2')) {
      const a = this.artifacts.get(params[0] as string);
      if (!a || a.session_id !== params[1]) return { rows: [], rowCount: 0 };
      return { rows: [{ id: a.id }] as R[], rowCount: 1 };
    }
    if (
      s.includes('FROM artifacts a LEFT JOIN turns t ON t.id = a.turn_id') &&
      s.includes("a.kind = 'html'") &&
      s.includes('ORDER BY a.updated_at DESC')
    ) {
      const row = [...this.artifacts.values()]
        .filter(
          (artifact) =>
            artifact.session_id === params[0] &&
            artifact.kind === 'html' &&
            (artifact.turn_id == null ||
              (this.turns.get(artifact.turn_id)?.session_id === artifact.session_id &&
                ['running', 'completed'].includes(this.turns.get(artifact.turn_id)?.status ?? ''))),
        )
        .sort(
          (a, b) =>
            b.updated_at.localeCompare(a.updated_at) || b.created_at.localeCompare(a.created_at),
        )[0];
      return row ? { rows: [{ ...row }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.includes('row_number() OVER') && s.includes('AS visible')) {
      const candidates = [...this.artifacts.values()].filter((artifact) => {
        if (artifact.session_id !== params[0]) return false;
        if (artifact.turn_id == null) return true;
        const turn = this.turns.get(artifact.turn_id);
        return (
          turn?.session_id === artifact.session_id &&
          (turn.status === 'completed' || turn.status === 'running')
        );
      });
      const latestByTurn = new Map<string, ArtifactRowF>();
      const visible = candidates.filter((artifact) => {
        if (artifact.turn_id == null) return true;
        const existing = latestByTurn.get(artifact.turn_id);
        if (
          !existing ||
          artifact.updated_at > existing.updated_at ||
          (artifact.updated_at === existing.updated_at &&
            (artifact.created_at > existing.created_at ||
              (artifact.created_at === existing.created_at && artifact.id > existing.id)))
        ) {
          latestByTurn.set(artifact.turn_id, artifact);
        }
        return false;
      });
      visible.push(...latestByTurn.values());
      const rows = visible
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        .map((artifact) => ({ ...artifact }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (
      s.includes('FROM artifacts WHERE session_id = $1') &&
      s.includes('ORDER BY created_at ASC')
    ) {
      const rows = [...this.artifacts.values()]
        .filter((a) => a.session_id === params[0])
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        .map((a) => ({
          id: a.id,
          session_id: a.session_id,
          turn_id: a.turn_id ?? null,
          kind: a.kind,
          title: a.title,
          storage_key: a.storage_key,
          meta: a.meta,
          created_at: a.created_at,
          updated_at: a.updated_at,
        }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (s.includes('FROM artifacts a JOIN sessions s ON s.id = a.session_id')) {
      const a = this.artifacts.get(params[0] as string);
      if (!a) return { rows: [], rowCount: 0 };
      const owner = this.sessions.get(a.session_id);
      if (!owner || owner.owner_user_id !== params[1]) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: a.id, kind: a.kind, storage_key: a.storage_key }] as R[],
        rowCount: 1,
      };
    }

    throw new Error(`FakeDb: unhandled SQL: ${s.slice(0, 140)}`);
  }
}

/** 假对象存储（内存 Map，实现 runtime 的最小对象面）。 */
export class FakeObjectStore implements RuntimeObjectStore {
  objects = new Map<string, Uint8Array>();

  private k(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }
  async putObject(
    bucket: Bucket,
    key: string,
    body: Uint8Array,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<{ key: string }> {
    if (opts?.abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
    this.objects.set(this.k(bucket, key), body);
    return { key };
  }
  async getObjectText(bucket: Bucket, key: string): Promise<string> {
    const v = this.objects.get(this.k(bucket, key));
    if (!v) throw new Error(`FakeObjectStore: missing ${bucket}/${key}`);
    return new TextDecoder().decode(v);
  }
  async getObject(bucket: Bucket, key: string): Promise<Uint8Array> {
    const v = this.objects.get(this.k(bucket, key));
    if (!v) throw new Error(`FakeObjectStore: missing ${bucket}/${key}`);
    return v;
  }
  async getObjectBounded(
    bucket: Bucket,
    key: string,
    maxBytes: number,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<Uint8Array> {
    if (opts?.abortSignal?.aborted) throw new BoundedObjectReadError('aborted');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new BoundedObjectReadError('invalid_limit');
    }
    const value = this.objects.get(this.k(bucket, key));
    if (!value) throw new BoundedObjectReadError('unavailable');
    if (value.byteLength > maxBytes) throw new BoundedObjectReadError('too_large');
    return new Uint8Array(value);
  }
  /** 测试便捷：直接放一段文本对象。 */
  seedText(bucket: string, key: string, text: string): void {
    this.objects.set(this.k(bucket, key), new TextEncoder().encode(text));
  }
}

// ───────────────────────────── 假 agent 工厂 ─────────────────────────────

/** 假 agent 剧本：按序发文本增量 → 可选调产物工具 → 按脚本成功/抛错/挂起等待打断。 */
export interface FakeAgentScript {
  deltas?: string[];
  /** 本轮新消息（拼在 history + user 之后成为 transcript 尾部）。 */
  finalMessages?: unknown[];
  /** prompt 期间调一次产物工具（覆盖 run-turn 的 onArtifact 接线）。 */
  invokeTool?: { title: string; content: string; artifactId?: string };
  /** 按名称执行已经接入 Pi 的工具，覆盖 TurnRunner 到远程工具的生产接线。 */
  invokeNamedTools?: Array<{ name: string; params: Record<string, unknown> }>;
  /** prompt 直接 reject。 */
  promptError?: Error;
  /** pi 把失败编码进消息的形态。 */
  runtimeError?: string;
  /** prompt 挂起直到 abort（打断路径）。 */
  hangUntilAbort?: boolean;
  /** 模拟模型 SDK 在 abort 后延迟多久才结束请求。 */
  abortDelayMs?: number;
}

export interface FakeAgentFactoryHandle {
  factory: TurnAgentFactory;
  /** 每次构造 agent 收到的入参（断言 definition/history/tools 接线）。 */
  calls: TurnAgentInput[];
}

export function makeFakeAgentFactory(script: FakeAgentScript = {}): FakeAgentFactoryHandle {
  const calls: TurnAgentInput[] = [];
  const factory: TurnAgentFactory = (input) => {
    calls.push(input);
    const listeners = new Set<(delta: string) => void>();
    let aborted = false;
    let abortHook: (() => void) | undefined;

    const agent: TurnAgent = {
      subscribeTextDelta(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async prompt() {
        for (const delta of script.deltas ?? []) {
          for (const fn of listeners) fn(delta);
        }
        if (script.invokeTool) {
          const tool = input.tools[0] as ArtifactAgentTool;
          await tool.execute('tc-1', {
            kind: 'html',
            title: script.invokeTool.title,
            content: script.invokeTool.content,
            ...(script.invokeTool.artifactId ? { artifactId: script.invokeTool.artifactId } : {}),
          });
        }
        for (const [index, invocation] of (script.invokeNamedTools ?? []).entries()) {
          const tool = input.tools.find((candidate) => candidate.name === invocation.name);
          if (!tool) throw new Error(`FakeAgent: missing tool ${invocation.name}`);
          const executable = tool as unknown as {
            execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
          };
          await executable.execute(`named-tool-${index}`, invocation.params);
        }
        if (script.hangUntilAbort) {
          await new Promise<void>((_resolve, reject) => {
            abortHook = () => {
              if (script.abortDelayMs) {
                setTimeout(() => reject(new Error('aborted')), script.abortDelayMs);
              } else {
                reject(new Error('aborted'));
              }
            };
            if (aborted) abortHook();
          });
        }
        if (script.promptError) throw script.promptError;
      },
      abort() {
        aborted = true;
        abortHook?.();
      },
      transcript() {
        return [
          ...input.history,
          { role: 'user', content: [{ type: 'text', text: '(prompt)' }] },
          ...(script.finalMessages ?? []),
        ];
      },
      runtimeError() {
        return script.runtimeError;
      },
    };
    return agent;
  };
  return { factory, calls };
}

/** 静默 TurnLogger（测试里不刷屏）。 */
export const silentLog = { error: () => undefined };

/** 轮询等待条件成立（异步轮次收尾用）。 */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
