// sessions / messages 两表 SQL。owner 校验统一收在 SQL 的 owner_user_id 条件里：
// 非本人与不存在同样 0 行（不暴露存在性）。
import {
  KnowledgeAgentBindingSchema,
  type AgentBinding,
  type KnowledgeAgentBinding,
  type MessageRole,
  type MessageStatus,
  type MessageView,
  type SessionMode,
  type SessionView,
} from '@cb/shared';
import { withTransaction, type Queryable, type RuntimeDb } from '../../platform/infra/db.js';
import { abandonActiveRecoveryForLockedSession } from '../billing/pending-recovery.js';
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
  mode: SessionMode;
  product_kind: 'legacy_capability' | 'knowledge_agent_test';
  capability_protocol: string | null;
  release_id: string | null;
  package_digest: string | null;
  release_scope: string | null;
  knowledge_resource_path: string | null;
  knowledge_resource_digest: string | null;
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
  mode: SessionMode;
  agentBinding: AgentBinding;
  title: string | null;
  status: 'active' | 'closed';
  createdAt: string;
  updatedAt: string;
}

const SESSION_COLUMNS = `id, capability_id, owner_user_id, mode, product_kind,
  capability_protocol, release_id, package_digest, release_scope,
  knowledge_resource_path, knowledge_resource_digest,
  title, status, created_at, updated_at`;

function bindingFromSessionRow(row: SessionDbRow): AgentBinding {
  if (row.product_kind === 'legacy_capability') return { productKind: 'legacy_capability' };
  return KnowledgeAgentBindingSchema.parse({
    productKind: row.product_kind,
    capability: { id: row.capability_id, protocol: row.capability_protocol },
    release: {
      protocol: 'combo.agent-package-release/1',
      releaseId: row.release_id,
      packageDigest: row.package_digest,
    },
    releaseScope: row.release_scope,
    knowledge: {
      protocol: 'combo.knowledge-bundle/1',
      resourcePath: row.knowledge_resource_path,
      resourceDigest: row.knowledge_resource_digest,
    },
  });
}

function toSessionRow(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    capabilityId: r.capability_id,
    ownerUserId: r.owner_user_id,
    mode: r.mode,
    agentBinding: bindingFromSessionRow(r),
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
  input: { capabilityId: string; ownerUserId: string; agentBinding?: KnowledgeAgentBinding },
): Promise<SessionRow> {
  if (input.agentBinding) {
    const binding = KnowledgeAgentBindingSchema.parse(input.agentBinding);
    if (binding.capability.id !== input.capabilityId) {
      throw new Error('createSession: binding capability mismatch');
    }
    const res = await db.query<SessionDbRow>(
      `INSERT INTO sessions
         (capability_id, owner_user_id, mode, product_kind, capability_protocol,
          release_id, package_digest, release_scope,
          knowledge_resource_path, knowledge_resource_digest)
       VALUES ($1, $2, 'consume', $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${SESSION_COLUMNS}`,
      [
        input.capabilityId,
        input.ownerUserId,
        binding.productKind,
        binding.capability.protocol,
        binding.release.releaseId,
        binding.release.packageDigest,
        binding.releaseScope,
        binding.knowledge.resourcePath,
        binding.knowledge.resourceDigest,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('createSession: knowledge insert returned no row');
    return toSessionRow(row);
  }
  const res = await db.query<SessionDbRow>(
    `INSERT INTO sessions (capability_id, owner_user_id, mode)
     VALUES ($1, $2, 'consume')
     RETURNING ${SESSION_COLUMNS}`,
    [input.capabilityId, input.ownerUserId],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createSession: insert returned no row');
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
 * 我的会话列表，按 updated_at 降序；默认只列普通运行会话，避免 Studio 修改历史混进试用侧栏。
 */
export async function listSessions(
  db: Queryable,
  ownerUserId: string,
  capabilityId?: string,
  mode: SessionMode = 'consume',
): Promise<SessionRow[]> {
  const res = await db.query<SessionDbRow>(
    `SELECT ${SESSION_COLUMNS}
      FROM sessions
      WHERE owner_user_id = $1
        AND status = 'active'
        AND ($2::uuid IS NULL OR capability_id = $2)
        AND mode = $3
      ORDER BY updated_at DESC
      LIMIT 100`,
    [ownerUserId, capabilityId ?? null, mode],
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

    await abandonActiveRecoveryForLockedSession(tx, ownerUserId, id);

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
