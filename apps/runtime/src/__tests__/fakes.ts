// 测试共用假件：忠实假 PG（按 repo 的真实 SQL 形态逐条模拟）+ 假对象存储 + 假 agent 工厂。
// 「忠实」指：守卫条件（owner/唯一约束/过滤）与真实 SQL 语义一致，命中/未命中行数可断言。
import type { Bucket } from '@cb/shared';
import type { Queryable, QueryResultLike, TxConn, TxPool } from '../platform/infra/db.js';
import type { RuntimeObjectStore } from '../platform/infra/object-store.js';
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
  agent_project_id: string | null;
  agent_revision_id: string | null;
  agent_release_id: string | null;
  mode: 'consume' | 'studio';
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
    if (s.includes('SELECT id, name, summary, kind FROM capabilities WHERE id = $1')) {
      const c = this.capabilities.get(params[0] as string);
      if (!c) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: c.id, name: c.name, summary: c.summary, kind: c.kind }] as R[],
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
    if (s.startsWith('INSERT INTO sessions (id, capability_id, owner_user_id, mode')) {
      const [id, capabilityId, ownerUserId, agentProjectId, agentRevisionId] = params as [
        string,
        string,
        string,
        string,
        string,
      ];
      const existing = this.sessions.get(id);
      if (existing) {
        const reusable =
          existing.capability_id === capabilityId &&
          existing.owner_user_id === ownerUserId &&
          existing.agent_project_id === agentProjectId &&
          existing.agent_revision_id === agentRevisionId &&
          existing.agent_release_id === null &&
          existing.mode === 'consume' &&
          existing.status === 'active';
        return reusable
          ? { rows: [{ ...existing }] as R[], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      const timestamp = nowIso();
      const row: SessionRowF = {
        id,
        capability_id: capabilityId,
        owner_user_id: ownerUserId,
        agent_project_id: agentProjectId,
        agent_revision_id: agentRevisionId,
        agent_release_id: null,
        mode: 'consume',
        title: null,
        status: 'active',
        created_at: timestamp,
        updated_at: timestamp,
      };
      this.sessions.set(id, row);
      return { rows: [{ ...row }] as R[], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO sessions')) {
      const [capabilityId, ownerUserId] = params as [string, string];
      const mode: SessionRowF['mode'] = s.includes("'studio'") ? 'studio' : 'consume';
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
        agent_project_id: mode === 'consume' ? ((params[2] as string | null) ?? null) : null,
        agent_revision_id: mode === 'consume' ? ((params[3] as string | null) ?? null) : null,
        agent_release_id: mode === 'consume' ? ((params[4] as string | null) ?? null) : null,
        mode,
        title: null,
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      this.sessions.set(row.id, row);
      return { rows: [{ ...row }] as R[], rowCount: 1 };
    }
    if (
      s.includes('FROM sessions s') &&
      s.includes('s.owner_user_id = $1') &&
      s.includes('ORDER BY s.updated_at DESC')
    ) {
      // 对齐真 SQL：$2 为 null 不过滤，否则只留该能力下的会话。
      const owner = params[0] as string;
      const capabilityId = (params[1] ?? null) as string | null;
      const mode = (params[2] ?? 'consume') as SessionRowF['mode'];
      const agentProjectId = (params[3] ?? null) as string | null;
      const rows = [...this.sessions.values()]
        .filter((x) => x.owner_user_id === owner)
        .filter((x) => x.status === 'active')
        .filter((x) => capabilityId === null || x.capability_id === capabilityId)
        .filter((x) => x.mode === mode)
        .filter((x) =>
          agentProjectId === null
            ? x.agent_project_id === null
            : x.agent_project_id === agentProjectId && x.agent_release_id !== null,
        )
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, 100)
        .map((x) => ({ ...x }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (
      s.startsWith('SELECT id FROM sessions WHERE id = $1 AND capability_id = $2') &&
      s.includes('owner_user_id = $3') &&
      (s.includes('mode = $4') || s.includes("mode = 'studio'")) &&
      s.includes("status = 'active'") &&
      s.endsWith('FOR UPDATE')
    ) {
      const [id, capabilityId, ownerUserId, parameterMode] = params as [
        string,
        string,
        string,
        SessionRowF['mode'] | undefined,
      ];
      const mode: SessionRowF['mode'] = s.includes("mode = 'studio'")
        ? 'studio'
        : (parameterMode ?? 'consume');
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
    if (s.startsWith('SELECT EXISTS (') && s.includes('SELECT 1 FROM turns')) {
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
        id: nextId('msg'),
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
        id: nextId('msg'),
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
    if (
      s.includes('FROM artifacts') &&
      s.includes("meta ->> 'authoringSurface' = 'codex'") &&
      s.includes("meta ->> 'idempotencyKey' = $2")
    ) {
      const row = [...this.artifacts.values()]
        .filter(
          (artifact) =>
            artifact.session_id === params[0] &&
            artifact.turn_id == null &&
            artifact.kind === 'html' &&
            artifact.meta.authoringSurface === 'codex' &&
            artifact.meta.idempotencyKey === params[1],
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
      return row ? { rows: [{ ...row }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 };
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

/** 假对象存储（内存 Map，实现 runtime 的三方法子集）。 */
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
