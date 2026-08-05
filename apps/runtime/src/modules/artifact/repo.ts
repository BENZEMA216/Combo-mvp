// artifacts 表 SQL。模型工具使用不可变正文对象，并在 running Turn 守卫下更新可见索引。
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, type ArtifactView, type SessionMode } from '@cb/shared';
import { withTransaction, type Queryable, type RuntimeDb } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import { toIso } from '../session/repo.js';
import { StudioArtifactValidationError, validateStudioHtml } from './studio-contract.js';

/** 产物内容所在桶。 */
export const ARTIFACT_BUCKET = 'combo-artifacts' as const;

/** 历史稳定键仍可读取；新工具写入使用不可变版本键，未提交对象不会覆盖可见正文。 */
export function artifactStorageKey(sessionId: string, artifactId: string): string {
  return `artifacts/${sessionId}/${artifactId}`;
}

export function artifactVersionStorageKey(
  sessionId: string,
  artifactId: string,
  objectWriteId: string,
): string {
  return `${artifactStorageKey(sessionId, artifactId)}/versions/${objectWriteId}`;
}

/** kind → 回读时的 Content-Type（产物是文本类内容：网页/文档/代码/结构化 JSON）。 */
export function contentTypeFor(kind: string): string {
  switch (kind) {
    case 'html':
      return 'text/html; charset=utf-8';
    case 'markdown':
      return 'text/markdown; charset=utf-8';
    case 'structured':
      return 'application/json; charset=utf-8';
    default:
      return 'text/plain; charset=utf-8';
  }
}

interface ArtifactDbRow {
  id: string;
  session_id: string;
  turn_id?: string | null;
  kind: string;
  title: string | null;
  storage_key: string;
  meta?: Record<string, unknown>;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface StoredArtifact {
  id: string;
  sessionId: string;
  turnId: string | null;
  kind: string;
  title: string | null;
  storageKey: string;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toStoredArtifact(r: ArtifactDbRow): StoredArtifact {
  return {
    id: r.id,
    sessionId: r.session_id,
    turnId: r.turn_id ?? null,
    kind: r.kind,
    title: r.title,
    storageKey: r.storage_key,
    meta: r.meta ?? {},
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function toView(r: ArtifactDbRow): ArtifactView {
  const sourceArtifactId =
    typeof r.meta?.sourceArtifactId === 'string' ? r.meta.sourceArtifactId : undefined;
  return {
    id: r.id,
    kind: r.kind,
    ...(r.title ? { title: r.title } : {}),
    ...(sourceArtifactId ? { sourceArtifactId } : {}),
    ...(r.turn_id ? { sourceTurnId: r.turn_id } : {}),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

/** 插/更新一行（id 由调用方定；ON CONFLICT 原地覆盖 kind/title/meta）。 */
export async function upsertArtifact(
  db: Queryable,
  input: {
    id: string;
    sessionId: string;
    kind: string;
    title: string;
    storageKey: string;
    meta: Record<string, unknown>;
    turnId?: string;
  },
): Promise<ArtifactView> {
  const res = await db.query<ArtifactDbRow>(
    `INSERT INTO artifacts (id, session_id, kind, title, storage_key, meta, turn_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (id)
     DO UPDATE SET kind = EXCLUDED.kind,
                   title = EXCLUDED.title,
                   storage_key = EXCLUDED.storage_key,
                   meta = EXCLUDED.meta,
                   turn_id = EXCLUDED.turn_id,
                   updated_at = now()
       WHERE artifacts.session_id = EXCLUDED.session_id
     RETURNING id, session_id, turn_id, kind, title, storage_key, meta, created_at, updated_at`,
    [
      input.id,
      input.sessionId,
      input.kind,
      input.title,
      input.storageKey,
      JSON.stringify(input.meta),
      input.turnId ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('upsertArtifact: upsert returned no row');
  return toView(row);
}

/**
 * 只有绑定 Turn 仍为 running 时才把已经上传的不可变对象键变成可见 Artifact。
 * Session 与 Turn 锁序和终态路径一致，终态一旦获胜，迟到工具只能返回 null。
 */
export async function upsertArtifactForRunningTurn(
  db: RuntimeDb,
  input: {
    id: string;
    sessionId: string;
    turnId: string;
    kind: string;
    title: string;
    storageKey: string;
    meta: Record<string, unknown>;
  },
  signal?: AbortSignal,
): Promise<ArtifactView | null> {
  return withTransaction(
    db,
    async (transaction) => {
      const session = await transaction.query<{ id: string }>(
        `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`,
        [input.sessionId],
      );
      if (!session.rows[0]) return null;
      const turn = await transaction.query<{ id: string }>(
        `SELECT id FROM turns
          WHERE id = $1 AND session_id = $2 AND status = 'running'
          FOR UPDATE`,
        [input.turnId, input.sessionId],
      );
      if (!turn.rows[0] || signal?.aborted) return null;
      return upsertArtifact(transaction, { ...input, turnId: input.turnId });
    },
    { signal },
  );
}

/** 会话内查单个产物（tool 判定「更新还是新建」用）。 */
export async function readArtifactInSession(
  db: Queryable,
  artifactId: string,
  sessionId: string,
): Promise<{ id: string } | null> {
  const res = await db.query<{ id: string }>(
    `SELECT id FROM artifacts WHERE id = $1 AND session_id = $2 LIMIT 1`,
    [artifactId, sessionId],
  );
  return res.rows[0] ?? null;
}

/** 会话内最近更新的 HTML。Studio 用它兜底复用主页面，避免模型漏传 artifactId 时制造副本。 */
export async function readLatestHtmlArtifactInSession(
  db: Queryable,
  sessionId: string,
): Promise<StoredArtifact | null> {
  const res = await db.query<ArtifactDbRow>(
    `SELECT a.id, a.session_id, a.turn_id, a.kind, a.title, a.storage_key, a.meta,
            a.created_at, a.updated_at
       FROM artifacts a
       LEFT JOIN turns t ON t.id = a.turn_id
      WHERE a.session_id = $1
        AND a.kind = 'html'
        AND (
          a.turn_id IS NULL
          OR (t.session_id = a.session_id AND t.status IN ('running', 'completed'))
        )
      ORDER BY a.updated_at DESC, a.created_at DESC, a.id DESC
      LIMIT 1`,
    [sessionId],
  );
  const row = res.rows[0];
  return row ? toStoredArtifact(row) : null;
}

/** capability 当前生效的 Studio HTML；额外校验指针确实来自该 capability 的 Studio 会话。 */
export async function readCapabilityUiArtifact(
  db: Queryable,
  capabilityId: string,
): Promise<StoredArtifact | null> {
  const res = await db.query<ArtifactDbRow>(
    `SELECT a.id, a.session_id, a.turn_id, a.kind, a.title, a.storage_key, a.meta,
            a.created_at, a.updated_at
       FROM capabilities c
       JOIN artifacts a ON a.id = c.ui_artifact_id
       JOIN sessions s ON s.id = a.session_id
       LEFT JOIN turns t ON t.id = a.turn_id
      WHERE c.id = $1
        AND a.kind = 'html'
        AND (a.turn_id IS NULL OR (t.session_id = a.session_id AND t.status = 'completed'))
        AND s.capability_id = c.id
        AND s.owner_user_id = c.owner_user_id
        AND s.mode = 'studio'
      LIMIT 1`,
    [capabilityId],
  );
  const row = res.rows[0];
  return row ? toStoredArtifact(row) : null;
}

/** 把一次成功 Studio 写入原子提升为该 capability 的当前 UI。 */
export async function bindCapabilityUiArtifact(
  db: Queryable,
  input: { capabilityId: string; artifactId: string; studioSessionId: string; turnId: string },
): Promise<boolean> {
  return bindCapabilityUiArtifactWithGuard(db, input, false);
}

/** Codex 直接保存的 Studio HTML 没有来源 Turn，但仍必须来自同 owner/capability 的 active Studio。 */
export async function bindDirectStudioUiArtifact(
  db: Queryable,
  input: { capabilityId: string; artifactId: string; studioSessionId: string },
): Promise<boolean> {
  return bindCapabilityUiArtifactWithGuard(db, input, false);
}

/** 既有 consume UI 首次采用专用 CAS：只允许从空指针提升，不能覆盖并发完成的新 revision。 */
async function bindCapabilityUiArtifactIfEmpty(
  db: Queryable,
  input: { capabilityId: string; artifactId: string; studioSessionId: string },
): Promise<boolean> {
  return bindCapabilityUiArtifactWithGuard(db, input, true);
}

async function bindCapabilityUiArtifactWithGuard(
  db: Queryable,
  input: {
    capabilityId: string;
    artifactId: string;
    studioSessionId: string;
    turnId?: string;
  },
  onlyIfEmpty: boolean,
): Promise<boolean> {
  const res = await db.query<{ id: string }>(
    `UPDATE capabilities c
        SET ui_artifact_id = $2
      WHERE c.id = $1
        ${onlyIfEmpty ? 'AND c.ui_artifact_id IS NULL' : ''}
        AND EXISTS (
          SELECT 1
            FROM artifacts a
            JOIN sessions s ON s.id = a.session_id
           WHERE a.id = $2
             AND a.session_id = $3
             AND a.kind = 'html'
             ${
               input.turnId
                 ? "AND a.turn_id = $4\n             AND EXISTS (SELECT 1 FROM turns t WHERE t.id = a.turn_id AND t.session_id = a.session_id AND t.status = 'completed')"
                 : 'AND a.turn_id IS NULL'
             }
             AND s.capability_id = c.id
             AND s.owner_user_id = c.owner_user_id
             AND s.mode = 'studio'
        )
      RETURNING c.id`,
    [
      input.capabilityId,
      input.artifactId,
      input.studioSessionId,
      ...(input.turnId ? [input.turnId] : []),
    ],
  );
  return Boolean(res.rows[0]);
}

/**
 * 首次进入 Studio 的当前模型补全：只检查这个 Agent 创作者本人、目标 Studio 创建前的
 * consume HTML。候选还必须通过当前 Miniapp 运行契约，避免把普通报告/网页误认成 Agent UI。
 */
async function listExistingConsumeUiCandidates(
  db: Queryable,
  input: { capabilityId: string; ownerUserId: string; targetStudioSessionId: string },
): Promise<StoredArtifact[]> {
  const res = await db.query<ArtifactDbRow>(
    `SELECT a.id, a.session_id, a.turn_id, a.kind, a.title, a.storage_key, a.meta,
            a.created_at, a.updated_at
       FROM artifacts a
       JOIN sessions s ON s.id = a.session_id
       JOIN capabilities c ON c.id = s.capability_id
       JOIN sessions target ON target.id = $3
       LEFT JOIN turns source_turn ON source_turn.id = a.turn_id
      WHERE c.id = $1
        AND c.owner_user_id = $2
        AND c.ui_artifact_id IS NULL
        AND s.owner_user_id = $2
        AND s.mode = 'consume'
        AND a.kind = 'html'
        AND (
          a.turn_id IS NULL
          OR (source_turn.session_id = a.session_id AND source_turn.status = 'completed')
        )
        AND target.capability_id = c.id
        AND target.owner_user_id = $2
        AND target.mode = 'studio'
        AND a.created_at < target.created_at
      ORDER BY a.updated_at DESC, a.created_at DESC
      LIMIT 20`,
    [input.capabilityId, input.ownerUserId, input.targetStudioSessionId],
  );
  return res.rows.map(toStoredArtifact);
}

class ExistingUiAdoptionConflictError extends Error {
  constructor() {
    super('capability UI was promoted concurrently');
    this.name = 'ExistingUiAdoptionConflictError';
  }
}

/**
 * 把可确认的既有 consume UI 克隆进当前 Studio，并以空指针 CAS 提升为当前 UI。
 * 对象先用不可变新键写入；DB 事务失败时旧指针不变，最多留下可离线清理的孤儿对象。
 */
export async function adoptExistingConsumeUiArtifact(
  db: RuntimeDb,
  objectStore: RuntimeObjectStore,
  input: { capabilityId: string; ownerUserId: string; targetStudioSessionId: string },
): Promise<ArtifactView | null> {
  const candidates = await listExistingConsumeUiCandidates(db, input);
  for (const source of candidates) {
    let content: Uint8Array;
    try {
      content = await objectStore.getObject(ARTIFACT_BUCKET, source.storageKey);
    } catch {
      // 既有索引可能残留已清理对象；继续检查下一个候选，而不是阻断设计空间。
      continue;
    }
    const validation = validateStudioHtml(new TextDecoder().decode(content));
    if (!validation.ok) continue;

    const id = randomUUID();
    const storageKey = artifactStorageKey(input.targetStudioSessionId, id);
    await objectStore.putObject(ARTIFACT_BUCKET, storageKey, content, {
      contentType: contentTypeFor(source.kind),
    });

    try {
      return await withTransaction(db, async (tx) => {
        const view = await upsertArtifact(tx, {
          id,
          sessionId: input.targetStudioSessionId,
          kind: 'html',
          title: source.title ?? 'Agent UI',
          storageKey,
          meta: {
            ...source.meta,
            adoption: 'existing-owner-consume-html',
            sourceArtifactId: source.id,
            sourceSessionId: source.sessionId,
            sourceUpdatedAt: source.updatedAt,
          },
        });
        const bound = await bindCapabilityUiArtifactIfEmpty(tx, {
          capabilityId: input.capabilityId,
          artifactId: id,
          studioSessionId: input.targetStudioSessionId,
        });
        if (!bound) throw new ExistingUiAdoptionConflictError();
        return view;
      });
    } catch (err) {
      if (err instanceof ExistingUiAdoptionConflictError) {
        // 另一请求已经完成了同一能力的提升；它才是当前真源，本次不覆盖。
        return null;
      }
      throw err;
    }
  }
  return null;
}

/**
 * 把 capability 当前 UI 复制到目标会话，形成与之后 Studio 修改隔离的快照。
 * 目标已有 HTML 时幂等返回现有项；这让“重新进入 active Studio”不会重复 seed。
 */
export async function seedCapabilityUiArtifact(
  db: RuntimeDb,
  objectStore: RuntimeObjectStore,
  input: {
    capabilityId: string;
    targetSessionId: string;
    targetOwnerUserId: string;
    targetMode: SessionMode;
  },
): Promise<ArtifactView | null> {
  const preliminaryExisting = await readLatestHtmlArtifactInSession(db, input.targetSessionId);
  let candidate:
    | {
        id: string;
        kind: string;
        title: string;
        storageKey: string;
        meta: Record<string, unknown>;
      }
    | undefined;

  if (!preliminaryExisting) {
    const source = await readCapabilityUiArtifact(db, input.capabilityId);
    if (source) {
      const content = await objectStore.getObject(ARTIFACT_BUCKET, source.storageKey);
      const id = randomUUID();
      const storageKey = artifactStorageKey(input.targetSessionId, id);
      await objectStore.putObject(ARTIFACT_BUCKET, storageKey, content, {
        contentType: contentTypeFor(source.kind),
      });
      candidate = {
        id,
        kind: source.kind,
        title: source.title ?? 'Agent UI',
        storageKey,
        meta: {
          ...source.meta,
          sourceArtifactId: source.id,
          sourceUpdatedAt: source.updatedAt,
        },
      };
    }
  }

  return withTransaction(db, async (tx) => {
    const target = await tx.query<{ id: string }>(
      `SELECT id
         FROM sessions
        WHERE id = $1
          AND capability_id = $2
          AND owner_user_id = $3
          AND mode = $4
          AND status = 'active'
        FOR UPDATE`,
      [input.targetSessionId, input.capabilityId, input.targetOwnerUserId, input.targetMode],
    );
    if (!target.rows[0]) {
      throw new Error('seedCapabilityUiArtifact: target session identity mismatch');
    }

    // 两个并发进入请求在同一 Session 行锁上串行；后到者必须看到先到者已经提交的 seed。
    const existing = await readLatestHtmlArtifactInSession(tx, input.targetSessionId);
    if (existing) return toView(existingToDbRow(existing));
    if (!candidate) return null;

    return upsertArtifact(tx, {
      ...candidate,
      sessionId: input.targetSessionId,
    });
  });
}

export class DirectUiSessionBusyError extends Error {
  constructor() {
    super('Studio session has a running Turn');
    this.name = 'DirectUiSessionBusyError';
  }
}

export class DirectUiIdempotencyConflictError extends Error {
  constructor() {
    super('Agent UI idempotency key was reused with a different request');
    this.name = 'DirectUiIdempotencyConflictError';
  }
}

function directUiArtifactId(sessionId: string, idempotencyKey: string): string {
  const hex = createHash('sha256')
    .update(`combo-agent-ui\0${sessionId}\0${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function readDirectStudioUiRequest(
  db: Queryable,
  sessionId: string,
  idempotencyKey: string,
): Promise<ArtifactDbRow | null> {
  const result = await db.query<ArtifactDbRow>(
    `SELECT id, session_id, turn_id, kind, title, storage_key, meta, created_at, updated_at
       FROM artifacts
      WHERE session_id = $1
        AND turn_id IS NULL
        AND kind = 'html'
        AND meta ->> 'authoringSurface' = 'codex'
        AND meta ->> 'idempotencyKey' = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [sessionId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function replayDirectStudioUiRequest(
  row: ArtifactDbRow,
  requestSha256: string,
  htmlSha256: string,
): { artifact: ArtifactView; sha256: string; created: false } {
  if (row.meta?.idempotencySha256 !== requestSha256 || row.meta?.sha256 !== htmlSha256) {
    throw new DirectUiIdempotencyConflictError();
  }
  return { artifact: toView(row), sha256: htmlSha256, created: false };
}

/** Codex 在不启动模型 Turn 的情况下保存一份合规 HTML revision，并原子设为 Capability 当前 UI。 */
export async function saveDirectStudioUiRevision(
  db: RuntimeDb,
  objectStore: RuntimeObjectStore,
  input: {
    sessionId: string;
    capabilityId: string;
    ownerUserId: string;
    title: string;
    html: string;
    idempotencyKey: string;
  },
): Promise<{ artifact: ArtifactView; sha256: string; created: boolean }> {
  const validation = validateStudioHtml(input.html);
  if (!validation.ok) throw new StudioArtifactValidationError(validation.errors);
  const sha256 = createHash('sha256').update(input.html).digest('hex');
  const requestSha256 = createHash('sha256')
    .update(canonicalJson({ html: input.html, title: input.title }))
    .digest('hex');
  const replay = await readDirectStudioUiRequest(db, input.sessionId, input.idempotencyKey);
  if (replay) return replayDirectStudioUiRequest(replay, requestSha256, sha256);

  const id = directUiArtifactId(input.sessionId, input.idempotencyKey);
  const storageKey = artifactVersionStorageKey(input.sessionId, id, requestSha256);
  await objectStore.putObject(ARTIFACT_BUCKET, storageKey, new TextEncoder().encode(input.html), {
    contentType: contentTypeFor('html'),
  });
  const artifact = await withTransaction(db, async (tx) => {
    const target = await tx.query<{ id: string }>(
      `SELECT id
         FROM sessions
        WHERE id = $1
          AND capability_id = $2
          AND owner_user_id = $3
          AND mode = 'studio'
          AND status = 'active'
        FOR UPDATE`,
      [input.sessionId, input.capabilityId, input.ownerUserId],
    );
    if (!target.rows[0]) throw new Error('saveDirectStudioUiRevision: session identity mismatch');
    const running = await tx.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM turns WHERE session_id = $1 AND status = 'running'
       ) AS exists`,
      [input.sessionId],
    );
    if (running.rows[0]?.exists) throw new DirectUiSessionBusyError();
    const concurrent = await readDirectStudioUiRequest(tx, input.sessionId, input.idempotencyKey);
    if (concurrent) return replayDirectStudioUiRequest(concurrent, requestSha256, sha256);
    const view = await upsertArtifact(tx, {
      id,
      sessionId: input.sessionId,
      kind: 'html',
      title: input.title,
      storageKey,
      meta: {
        authoringSurface: 'codex',
        sha256,
        idempotencyKey: input.idempotencyKey,
        idempotencySha256: requestSha256,
      },
    });
    const bound = await bindDirectStudioUiArtifact(tx, {
      capabilityId: input.capabilityId,
      artifactId: id,
      studioSessionId: input.sessionId,
    });
    if (!bound) throw new Error('saveDirectStudioUiRevision: capability UI bind failed');
    return { artifact: view, sha256, created: true as const };
  });
  return artifact;
}

/** 给 Revision-pinned Session 复制冻结 UI；不读取 Capability 的可变 current UI。 */
export async function seedAgentRevisionUiArtifact(
  db: RuntimeDb,
  objectStore: RuntimeObjectStore,
  input: {
    revisionId: string;
    sourceArtifactId: string;
    sourceStorageKey: string;
    sourceUiSha256: string;
    capabilityId: string;
    targetSessionId: string;
    targetOwnerUserId: string;
  },
): Promise<ArtifactView> {
  const preliminary = await readLatestHtmlArtifactInSession(db, input.targetSessionId);
  if (preliminary) return toView(existingToDbRow(preliminary));
  const content = await objectStore.getObject(ARTIFACT_BUCKET, input.sourceStorageKey);
  const actualSha = createHash('sha256').update(content).digest('hex');
  if (actualSha !== input.sourceUiSha256) {
    throw new Error('seedAgentRevisionUiArtifact: UI digest mismatch');
  }
  const html = new TextDecoder().decode(content);
  const validation = validateStudioHtml(html);
  if (!validation.ok) throw new StudioArtifactValidationError(validation.errors);
  const id = randomUUID();
  const storageKey = artifactStorageKey(input.targetSessionId, id);
  await objectStore.putObject(ARTIFACT_BUCKET, storageKey, content, {
    contentType: contentTypeFor('html'),
  });
  return withTransaction(db, async (tx) => {
    const target = await tx.query<{ id: string }>(
      `SELECT id
         FROM sessions
        WHERE id = $1
          AND capability_id = $2
          AND owner_user_id = $3
          AND mode = 'consume'
          AND status = 'active'
          AND agent_revision_id = $4
        FOR UPDATE`,
      [input.targetSessionId, input.capabilityId, input.targetOwnerUserId, input.revisionId],
    );
    if (!target.rows[0]) throw new Error('seedAgentRevisionUiArtifact: session identity mismatch');
    const existing = await readLatestHtmlArtifactInSession(tx, input.targetSessionId);
    if (existing) return toView(existingToDbRow(existing));
    return upsertArtifact(tx, {
      id,
      sessionId: input.targetSessionId,
      kind: 'html',
      title: 'Agent UI',
      storageKey,
      meta: {
        sourceArtifactId: input.sourceArtifactId,
        agentRevisionId: input.revisionId,
        uiSha256: input.sourceUiSha256,
      },
    });
  });
}

function existingToDbRow(artifact: StoredArtifact): ArtifactDbRow {
  return {
    id: artifact.id,
    session_id: artifact.sessionId,
    turn_id: artifact.turnId,
    kind: artifact.kind,
    title: artifact.title,
    storage_key: artifact.storageKey,
    meta: artifact.meta,
    created_at: artifact.createdAt,
    updated_at: artifact.updatedAt,
  };
}

/**
 * 会话详情产物。普通运行保留现有全量行为；Studio 只恢复种子、每个 completed Turn
 * 的最后一份 revision，以及当前 running Turn 的最新候选。失败或中断轮不会进入历史。
 */
export async function listArtifacts(
  db: Queryable,
  sessionId: string,
  mode: SessionMode = 'consume',
): Promise<ArtifactView[]> {
  const sql =
    mode === 'studio'
      ? `SELECT id, session_id, turn_id, kind, title, storage_key, meta, created_at, updated_at
           FROM (
             SELECT a.id, a.session_id, a.turn_id, a.kind, a.title, a.storage_key, a.meta,
                    a.created_at, a.updated_at,
                    row_number() OVER (
                      PARTITION BY a.turn_id
                      ORDER BY a.updated_at DESC, a.created_at DESC, a.id DESC
                    ) AS turn_rank
               FROM artifacts a
               LEFT JOIN turns t ON t.id = a.turn_id
              WHERE a.session_id = $1
                AND (
                  a.turn_id IS NULL
                  OR (t.session_id = a.session_id AND t.status IN ('completed', 'running'))
                )
           ) AS visible
          WHERE turn_id IS NULL OR turn_rank = 1
          ORDER BY created_at ASC, id ASC`
      : `SELECT id, session_id, turn_id, kind, title, storage_key, meta, created_at, updated_at
           FROM artifacts
          WHERE session_id = $1
          ORDER BY created_at ASC, id ASC`;
  const res = await db.query<ArtifactDbRow>(sql, [sessionId]);
  return res.rows.map(toView);
}

/** owner-scoped 读产物（内容回读端点用）：JOIN sessions 校归属，非本人/不存在 → null。 */
export async function readArtifactForOwner(
  db: Queryable,
  artifactId: string,
  ownerUserId: string,
): Promise<{ id: string; kind: string; storageKey: string } | null> {
  const res = await db.query<{ id: string; kind: string; storage_key: string }>(
    `SELECT a.id, a.kind, a.storage_key
       FROM artifacts a
       JOIN sessions s ON s.id = a.session_id
      WHERE a.id = $1 AND s.owner_user_id = $2
      LIMIT 1`,
    [artifactId, ownerUserId],
  );
  const row = res.rows[0];
  return row ? { id: row.id, kind: row.kind, storageKey: row.storage_key } : null;
}
