// sessions / messages 两表 SQL。owner 校验统一收在 SQL 的 owner_user_id 条件里：
// 非本人与不存在同样 0 行（不暴露存在性）。
import type { MessageRole, MessageStatus, MessageView, SessionMode, SessionView } from '@cb/shared';
import { withTransaction, type Queryable, type RuntimeDb } from '../../platform/infra/db.js';
import { parseMessageContent } from './message-content.js';

/** timestamptz → ISO 字符串（pg 可能回 Date 或字符串）。 */
export function toIso(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

interface SessionDbRow {
  id: string;
  capability_id: string;
  owner_user_id: string;
  agent_project_id?: string | null;
  agent_revision_id: string | null;
  agent_release_id: string | null;
  mode: SessionMode;
  title: string | null;
  status: 'active' | 'closed';
  created_at: string | Date;
  updated_at: string | Date;
}

/** 会话内部行（含 ownerUserId，仅服务端用；对外形态是 SessionView）。 */
export interface SessionRow {
  id: string;
  capabilityId: string;
  ownerUserId: string;
  agentProjectId: string | null;
  agentRevisionId: string | null;
  agentReleaseId: string | null;
  mode: SessionMode;
  title: string | null;
  status: 'active' | 'closed';
  createdAt: string;
  updatedAt: string;
}

const SESSION_COLUMNS = `id, capability_id, owner_user_id, agent_project_id,
  agent_revision_id, agent_release_id, mode, title, status, created_at, updated_at`;

function toSessionRow(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    capabilityId: r.capability_id,
    ownerUserId: r.owner_user_id,
    agentProjectId: r.agent_project_id ?? null,
    agentRevisionId: r.agent_revision_id,
    agentReleaseId: r.agent_release_id,
    mode: r.mode,
    title: r.title,
    status: r.status,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function toSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    capabilityId: row.capabilityId,
    ...(row.agentProjectId ? { agentProjectId: row.agentProjectId } : {}),
    ...(row.agentRevisionId ? { agentRevisionId: row.agentRevisionId } : {}),
    ...(row.agentReleaseId ? { agentReleaseId: row.agentReleaseId } : {}),
    mode: row.mode,
    ...(row.title ? { title: row.title } : {}),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 锁住一条 active 会话直到当前事务结束。开始轮次与归档必须共用这把行锁，
 * 否则“请求已读到 active、turn 尚未插入”的窗口会把后台生成留在 closed 会话里。
 */
export async function lockActiveSession(
  db: Queryable,
  id: string,
  ownerUserId: string,
): Promise<SessionRow | null> {
  const res = await db.query<SessionDbRow>(
    `SELECT ${SESSION_COLUMNS}
       FROM sessions
      WHERE id = $1 AND owner_user_id = $2 AND status = 'active'
      FOR UPDATE`,
    [id, ownerUserId],
  );
  const row = res.rows[0];
  return row ? toSessionRow(row) : null;
}

export class SessionBusyError extends Error {
  constructor() {
    super('session has a running turn');
    this.name = 'SessionBusyError';
  }
}

/** 建会话（loader 校验通过后调用）。 */
export async function createSession(
  db: Queryable,
  input: {
    capabilityId: string;
    ownerUserId: string;
    agentProjectId?: string;
    agentRevisionId?: string;
    agentReleaseId?: string;
  },
): Promise<SessionRow> {
  if (Boolean(input.agentProjectId) !== Boolean(input.agentRevisionId)) {
    throw new TypeError('Agent Session requires Project and Revision pins together');
  }
  if (input.agentReleaseId && !input.agentRevisionId) {
    throw new TypeError('Agent Release pin requires an Agent Revision pin');
  }
  const res = await db.query<SessionDbRow>(
    `INSERT INTO sessions
       (capability_id, owner_user_id, mode, agent_project_id, agent_revision_id, agent_release_id)
     VALUES ($1, $2, 'consume', $3, $4, $5)
     RETURNING ${SESSION_COLUMNS}`,
    [
      input.capabilityId,
      input.ownerUserId,
      input.agentProjectId ?? null,
      input.agentRevisionId ?? null,
      input.agentReleaseId ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createSession: insert returned no row');
  return toSessionRow(row);
}

/**
 * Agent Test 用 Test id 固定 Session id。租约 owner 在 Turn 事务前崩溃时，接管者复用同一
 * Session 与已 seed UI；身份不完全一致或 Session 已关闭时拒绝复用。
 */
export async function getOrCreateAgentTestSession(
  db: Queryable,
  input: {
    sessionId: string;
    capabilityId: string;
    ownerUserId: string;
    agentProjectId: string;
    agentRevisionId: string;
  },
): Promise<SessionRow> {
  const res = await db.query<SessionDbRow>(
    `INSERT INTO sessions
       (id, capability_id, owner_user_id, mode, agent_project_id, agent_revision_id)
     VALUES ($1, $2, $3, 'consume', $4, $5)
     ON CONFLICT (id)
     DO UPDATE SET updated_at = sessions.updated_at
       WHERE sessions.capability_id = EXCLUDED.capability_id
         AND sessions.owner_user_id = EXCLUDED.owner_user_id
         AND sessions.agent_project_id = EXCLUDED.agent_project_id
         AND sessions.agent_revision_id = EXCLUDED.agent_revision_id
         AND sessions.agent_release_id IS NULL
         AND sessions.mode = 'consume'
         AND sessions.status = 'active'
     RETURNING ${SESSION_COLUMNS}`,
    [
      input.sessionId,
      input.capabilityId,
      input.ownerUserId,
      input.agentProjectId,
      input.agentRevisionId,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('getOrCreateAgentTestSession: identity mismatch');
  return toSessionRow(row);
}

/**
 * 幂等进入 Studio：同一 owner + capability 的 active 设计会话原子复用。
 * 唯一部分索引负责并发闸；ON CONFLICT 让双击/重试只拿到同一条会话。
 */
export async function getOrCreateStudioSession(
  db: Queryable,
  input: { capabilityId: string; ownerUserId: string },
): Promise<SessionRow> {
  const res = await db.query<SessionDbRow>(
    `INSERT INTO sessions (capability_id, owner_user_id, mode)
     VALUES ($1, $2, 'studio')
     ON CONFLICT (owner_user_id, capability_id)
       WHERE status = 'active' AND mode = 'studio'
     DO UPDATE SET updated_at = sessions.updated_at
     RETURNING ${SESSION_COLUMNS}`,
    [input.capabilityId, input.ownerUserId],
  );
  const row = res.rows[0];
  if (!row) throw new Error('getOrCreateStudioSession: upsert returned no row');
  return toSessionRow(row);
}

/**
 * 我的会话列表，按 updated_at 降序。无 Project scope 时只列普通 Capability Session；
 * 有 Project scope 时只列带 Release 的正式 Agent Session。Test 与并发清理中的草稿 Session 永不进侧栏。
 */
export async function listSessions(
  db: Queryable,
  ownerUserId: string,
  capabilityId?: string,
  mode: SessionMode = 'consume',
  agentProjectId?: string,
): Promise<SessionRow[]> {
  const res = await db.query<SessionDbRow>(
    `SELECT ${SESSION_COLUMNS}
      FROM sessions s
      WHERE s.owner_user_id = $1
        AND s.status = 'active'
        AND ($2::uuid IS NULL OR s.capability_id = $2)
        AND s.mode = $3
        AND (
          ($4::uuid IS NULL AND s.agent_project_id IS NULL)
          OR ($4::uuid IS NOT NULL AND s.agent_project_id = $4 AND s.agent_release_id IS NOT NULL)
        )
        AND NOT EXISTS (SELECT 1 FROM agent_tests at WHERE at.session_id = s.id)
      ORDER BY s.updated_at DESC
      LIMIT 100`,
    [ownerUserId, capabilityId ?? null, mode, agentProjectId ?? null],
  );
  return res.rows.map(toSessionRow);
}

/** owner-scoped 改名；非本人、不存在或已归档 → null。 */
export async function updateSessionTitle(
  db: Queryable,
  id: string,
  ownerUserId: string,
  title: string,
): Promise<SessionRow | null> {
  const res = await db.query<SessionDbRow>(
    `UPDATE sessions
        SET title = $3, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND status = 'active'
      RETURNING ${SESSION_COLUMNS}`,
    [id, ownerUserId, title],
  );
  const row = res.rows[0];
  return row ? toSessionRow(row) : null;
}

/** owner-scoped 软归档；保留会话与产物，但不再出现在默认列表或运行入口。 */
export async function archiveSession(
  db: RuntimeDb,
  id: string,
  ownerUserId: string,
): Promise<SessionRow | null> {
  return withTransaction(db, async (tx) => {
    const active = await lockActiveSession(tx, id, ownerUserId);
    if (!active) return null;

    const running = await tx.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM turns WHERE session_id = $1 AND status = 'running') AS exists`,
      [id],
    );
    if (running.rows[0]?.exists) throw new SessionBusyError();

    const res = await tx.query<SessionDbRow>(
      `UPDATE sessions
          SET status = 'closed', updated_at = now()
        WHERE id = $1 AND owner_user_id = $2 AND status = 'active'
        RETURNING ${SESSION_COLUMNS}`,
      [id, ownerUserId],
    );
    const row = res.rows[0];
    return row ? toSessionRow(row) : null;
  });
}

/** owner-scoped 取 active 会话；非本人、不存在或已归档 → null。 */
export async function getSession(
  db: Queryable,
  id: string,
  ownerUserId: string,
): Promise<SessionRow | null> {
  const res = await db.query<SessionDbRow>(
    `SELECT ${SESSION_COLUMNS}
       FROM sessions
      WHERE id = $1 AND owner_user_id = $2 AND status = 'active'
      LIMIT 1`,
    [id, ownerUserId],
  );
  const row = res.rows[0];
  return row ? toSessionRow(row) : null;
}

// ───────────────────────────── messages ─────────────────────────────

interface MessageDbRow {
  id: string;
  seq: number | null;
  idx?: number | null;
  turn_id?: string | null;
  turn_status?: string | null;
  role: MessageRole;
  content: unknown[];
  status: MessageStatus;
  created_at: string | Date;
}

/** 消息行（= 对外 MessageView 同形态；build-agent 也直接消费它重建历史）。 */
export interface MessageRecord extends MessageView {
  role: MessageRole;
  turnId?: string;
  turnStatus?: string;
}

function toMessageRecord(r: MessageDbRow, derivedSeq?: number): MessageRecord {
  return {
    id: r.id,
    seq: derivedSeq ?? r.seq ?? 0,
    role: r.role,
    content: Array.isArray(r.content) ? r.content : [],
    status: r.status,
    createdAt: toIso(r.created_at),
    ...(r.turn_id ? { turnId: r.turn_id } : {}),
    ...(r.turn_status ? { turnStatus: r.turn_status } : {}),
  };
}

/**
 * 会话全部消息（详情用）：合并排序（legacy 按 seq、轮按创建时间、轮内按 idx），
 * seq 返回派生序号。不做可见性过滤——运行中轮的 user 消息、失败轮的错误记录
 * 都必须在详情里可见;历史/上下文的 completed 过滤由消费方（run-turn）负责,
 * 依据是随行返回的 turnStatus 与消息自身 status。
 */
export async function getMessages(db: Queryable, sessionId: string): Promise<MessageRecord[]> {
  const res = await db.query<MessageDbRow>(
    `SELECT m.id, m.seq, m.idx, m.turn_id, m.role, m.content, m.status, m.created_at,
            t.status AS turn_status, t.created_at AS turn_created_at
       FROM messages m LEFT JOIN turns t ON t.id = m.turn_id
      WHERE m.session_id = $1
      ORDER BY COALESCE(t.created_at, m.created_at) ASC,
               COALESCE(m.idx, m.seq) ASC, m.created_at ASC`,
    [sessionId],
  );
  return res.rows.map((row, index) => toMessageRecord(row, index + 1));
}

/** 从首条用户消息文本派生会话标题（首轮自动命名）。 */
function deriveTitle(content: unknown[]): string | null {
  const first = content.find(
    (b): b is { type: 'text'; text: string } =>
      typeof b === 'object' &&
      b !== null &&
      (b as { type?: unknown }).type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string',
  );
  const title = first?.text.trim().slice(0, 30);
  return title || null;
}

/** 按轮追加消息；调用方负责轮内 idx，写入路径不加锁也不分配会话级序号。 */
export async function appendTurnMessage(
  db: Queryable,
  input: {
    sessionId: string;
    turnId: string;
    idx: number;
    role: MessageRole;
    content: unknown[];
    status?: MessageStatus;
  },
): Promise<MessageRecord> {
  const content = parseMessageContent(input.role, input.content);
  const status: MessageStatus = input.status ?? 'completed';
  const inserted = await db.query<MessageDbRow>(
    `INSERT INTO messages (session_id, turn_id, idx, seq, role, content, status)
     VALUES ($1, $2, $3, NULL, $4, $5::jsonb, $6)
     RETURNING id, seq, idx, turn_id, role, content, status, created_at`,
    [input.sessionId, input.turnId, input.idx, input.role, JSON.stringify(content), status],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('appendTurnMessage: insert returned no row');
  const title = input.idx === 0 && input.role === 'user' ? deriveTitle(content) : null;
  await db.query(
    `UPDATE sessions SET updated_at = now(), title = COALESCE(title, $2) WHERE id = $1`,
    [input.sessionId, title],
  );
  const count = await db.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM messages WHERE session_id = $1`,
    [input.sessionId],
  );
  return toMessageRecord(row, Number(count.rows[0]?.count ?? 0));
}
