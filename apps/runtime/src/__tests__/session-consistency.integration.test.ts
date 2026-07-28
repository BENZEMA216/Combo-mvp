import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bindCapabilityUiArtifact,
  seedCapabilityUiArtifact,
  ARTIFACT_BUCKET,
} from '../modules/artifact/repo.js';
import { readSessionDetailDbSnapshot } from '../modules/session/detail.js';
import {
  createSession,
  getOrCreateStudioSession,
  type SessionRow,
} from '../modules/session/repo.js';
import {
  toRuntimeDb,
  withTransaction,
  type QueryResultLike,
  type RuntimeDb,
  type TxConn,
} from '../platform/infra/db.js';
import { FakeObjectStore } from './fakes.js';

const databaseUrl = process.env.RUNTIME_TERMINAL_FENCE_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;

interface SeededChain {
  userId: string;
  taskId: string;
  capabilityId: string;
  studio: SessionRow;
}

integrationDescribe('真实 PostgreSQL Session 一致性', () => {
  let pool: Pool;
  let db: RuntimeDb;
  const seeded: SeededChain[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 8 });
    db = toRuntimeDb(pool);
    await db.query('SELECT 1');
  });

  afterAll(async () => {
    for (const chain of seeded.reverse()) {
      await db.query('DELETE FROM sessions WHERE capability_id = $1', [chain.capabilityId]);
      await db.query('DELETE FROM capabilities WHERE id = $1', [chain.capabilityId]);
      await db.query('DELETE FROM tasks WHERE id = $1', [chain.taskId]);
      await db.query('DELETE FROM users WHERE id = $1', [chain.userId]);
    }
    await pool.end();
  });

  async function seedStudio(): Promise<SeededChain> {
    const suffix = randomUUID();
    const account = `creator-${suffix
      .replaceAll('-', '')
      .slice(0, 8)
      .replace(/[0189]/g, 'a')}`;
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (account)
       VALUES ($1)
       RETURNING id`,
      [account],
    );
    const userId = user.rows[0]!.id;
    const task = await db.query<{ id: string }>(
      `INSERT INTO tasks (owner_user_id, idempotency_key)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, `session-consistency-${suffix}`],
    );
    const taskId = task.rows[0]!.id;
    const capability = await db.query<{ id: string }>(
      `INSERT INTO capabilities (task_id, owner_user_id, name, storage_key)
       VALUES ($1, $2, 'session consistency', $3)
       RETURNING id`,
      [taskId, userId, `session-consistency/${suffix}.json`],
    );
    const capabilityId = capability.rows[0]!.id;
    const studio = await getOrCreateStudioSession(db, { capabilityId, ownerUserId: userId });
    const chain = { userId, taskId, capabilityId, studio };
    seeded.push(chain);
    return chain;
  }

  async function insertCompletedRevision(
    chain: SeededChain,
    label: string,
  ): Promise<{ turnId: string; artifactId: string }> {
    const revision = await insertRevision(chain.studio.id, 'completed', label);
    await db.query('UPDATE capabilities SET ui_artifact_id = $2 WHERE id = $1', [
      chain.capabilityId,
      revision.artifactId,
    ]);
    return revision;
  }

  async function insertRevision(
    sessionId: string,
    status: 'running' | 'completed' | 'failed' | 'interrupted',
    label: string,
  ): Promise<{ turnId: string; artifactId: string }> {
    const turnId = randomUUID();
    const artifactId = randomUUID();
    await withTransaction(db, async (tx) => {
      await tx.query(
        `INSERT INTO turns (id, session_id, status, finished_at)
         VALUES ($1, $2, $3, CASE WHEN $3 = 'running' THEN NULL ELSE now() END)`,
        [turnId, sessionId, status],
      );
      await tx.query(
        `INSERT INTO messages (session_id, turn_id, idx, seq, role, content, status)
         VALUES ($1, $2, 0, NULL, 'user', $3::jsonb, $4)`,
        [
          sessionId,
          turnId,
          JSON.stringify([{ type: 'text', text: label }]),
          status === 'completed' ? 'completed' : 'failed',
        ],
      );
      await tx.query(
        `INSERT INTO artifacts (id, session_id, turn_id, kind, title, storage_key)
         VALUES ($1, $2, $3, 'html', $4, $5)`,
        [artifactId, sessionId, turnId, label, `integration/${artifactId}.html`],
      );
    });
    return { turnId, artifactId };
  }

  function pauseAfterOwnedSessionRead(
    source: RuntimeDb,
    onSnapshot: () => void,
    resume: Promise<void>,
  ): RuntimeDb {
    let paused = false;
    return {
      query: <R>(sql: string, params?: unknown[], signal?: AbortSignal) =>
        source.query<R>(sql, params, signal),
      async connect(): Promise<TxConn> {
        const connection = await source.connect();
        return {
          async query<R = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
            signal?: AbortSignal,
          ): Promise<QueryResultLike<R>> {
            const result = await connection.query<R>(sql, params, signal);
            const normalized = sql.replace(/\s+/g, ' ').trim();
            if (
              !paused &&
              normalized.includes('FROM sessions') &&
              normalized.includes('id = $1 AND owner_user_id = $2')
            ) {
              paused = true;
              onSnapshot();
              await resume;
            }
            return result;
          },
          release: (destroy?: boolean) => connection.release(destroy),
        };
      },
    };
  }

  it('详情读取不把并发提交后的 messages/artifacts/current UI/active Turn 拼入旧快照', async () => {
    const chain = await seedStudio();
    const oldRevision = await insertCompletedRevision(chain, 'old revision');
    let markSnapshot!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshot = resolve;
    });
    let resumeSnapshot!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeSnapshot = resolve;
    });
    const snapshotDb = pauseAfterOwnedSessionRead(db, markSnapshot, resume);

    const pending = readSessionDetailDbSnapshot(snapshotDb, {
      sessionId: chain.studio.id,
      ownerUserId: chain.userId,
    });
    await snapshotStarted;

    const newRevision = await insertCompletedRevision(chain, 'new revision');
    const activeTurnId = randomUUID();
    await db.query(
      `INSERT INTO turns (id, session_id, status)
       VALUES ($1, $2, 'running')`,
      [activeTurnId, chain.studio.id],
    );
    resumeSnapshot();

    const snapshot = await pending;
    expect(snapshot?.messages.map((message) => message.turnId)).toEqual([oldRevision.turnId]);
    expect(snapshot?.artifacts.map((artifact) => artifact.id)).toEqual([oldRevision.artifactId]);
    expect(snapshot?.currentUiArtifact?.id).toBe(oldRevision.artifactId);
    expect(snapshot?.currentUiArtifact?.id).not.toBe(newRevision.artifactId);
    expect(snapshot?.activeTurn).toBeNull();
    expect(snapshot?.latestTerminalTurn).toEqual({
      id: oldRevision.turnId,
      status: 'completed',
      errorCode: null,
    });
    expect(snapshot?.latestTerminalTurn?.id).not.toBe(newRevision.turnId);
  });

  it('真实 PostgreSQL 详情只投影终态白名单码，不返回原始错误文本', async () => {
    const chain = await seedStudio();
    const turnId = randomUUID();
    await db.query(
      `INSERT INTO turns
         (id, session_id, status, last_error, created_at, finished_at)
       VALUES
         ($1, $2, 'failed', $3::jsonb, now(), now())`,
      [
        turnId,
        chain.studio.id,
        JSON.stringify({
          code: 'TURN_RUNTIME_ERROR',
          message: 'provider-sensitive-sentinel-must-never-leave-the-database',
        }),
      ],
    );

    const snapshot = await readSessionDetailDbSnapshot(db, {
      sessionId: chain.studio.id,
      ownerUserId: chain.userId,
    });

    expect(snapshot?.latestTerminalTurn).toEqual({
      id: turnId,
      status: 'failed',
      errorCode: 'TURN_RUNTIME_ERROR',
    });
    expect(JSON.stringify(snapshot)).not.toContain(
      'provider-sensitive-sentinel-must-never-leave-the-database',
    );
  });

  it('并发 seed 在真实 Session 行锁下只创建一个 null-turn 快照', async () => {
    const chain = await seedStudio();
    const sourceId = randomUUID();
    const sourceKey = `integration/${sourceId}.html`;
    await db.query(
      `INSERT INTO artifacts (id, session_id, kind, title, storage_key)
       VALUES ($1, $2, 'html', 'source UI', $3)`,
      [sourceId, chain.studio.id, sourceKey],
    );
    await db.query('UPDATE capabilities SET ui_artifact_id = $2 WHERE id = $1', [
      chain.capabilityId,
      sourceId,
    ]);
    const target = await createSession(db, {
      capabilityId: chain.capabilityId,
      ownerUserId: chain.userId,
    });
    const store = new FakeObjectStore();
    store.seedText(ARTIFACT_BUCKET, sourceKey, '<!doctype html><html>source</html>');
    const input = {
      capabilityId: chain.capabilityId,
      targetSessionId: target.id,
      targetOwnerUserId: chain.userId,
      targetMode: 'consume' as const,
    };

    const [first, second] = await Promise.all([
      seedCapabilityUiArtifact(db, store, input),
      seedCapabilityUiArtifact(db, store, input),
    ]);
    const count = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM artifacts
        WHERE session_id = $1 AND turn_id IS NULL`,
      [target.id],
    );

    expect(first?.id).toBe(second?.id);
    expect(count.rows[0]?.count).toBe('1');
  });

  it('当前 UI 晋升在真实 PostgreSQL 中校验终态 Turn、Session 和 owner，并随事务回滚', async () => {
    const chain = await seedStudio();
    const other = await seedStudio();
    const accepted = await insertRevision(chain.studio.id, 'completed', 'accepted revision');
    const running = await insertRevision(chain.studio.id, 'running', 'running revision');
    const wrongTurn = await insertRevision(chain.studio.id, 'completed', 'other completed turn');
    const otherSession = await insertRevision(
      other.studio.id,
      'completed',
      'other capability revision',
    );
    const foreignStudioId = randomUUID();

    await db.query(
      `INSERT INTO sessions (id, capability_id, owner_user_id, mode)
       VALUES ($1, $2, $3, 'studio')`,
      [foreignStudioId, chain.capabilityId, other.userId],
    );
    try {
      const foreignOwner = await insertRevision(
        foreignStudioId,
        'completed',
        'foreign owner revision',
      );

      await expect(
        bindCapabilityUiArtifact(db, {
          capabilityId: chain.capabilityId,
          artifactId: accepted.artifactId,
          studioSessionId: chain.studio.id,
          turnId: accepted.turnId,
        }),
      ).resolves.toBe(true);

      for (const input of [
        {
          artifactId: running.artifactId,
          studioSessionId: chain.studio.id,
          turnId: running.turnId,
        },
        {
          artifactId: accepted.artifactId,
          studioSessionId: chain.studio.id,
          turnId: wrongTurn.turnId,
        },
        {
          artifactId: accepted.artifactId,
          studioSessionId: foreignStudioId,
          turnId: accepted.turnId,
        },
        {
          artifactId: otherSession.artifactId,
          studioSessionId: other.studio.id,
          turnId: otherSession.turnId,
        },
        {
          artifactId: foreignOwner.artifactId,
          studioSessionId: foreignStudioId,
          turnId: foreignOwner.turnId,
        },
      ]) {
        await expect(
          bindCapabilityUiArtifact(db, {
            capabilityId: chain.capabilityId,
            ...input,
          }),
        ).resolves.toBe(false);
      }

      const rollbackRevision = await insertRevision(
        chain.studio.id,
        'completed',
        'rollback revision',
      );
      await expect(
        withTransaction(db, async (tx) => {
          const bound = await bindCapabilityUiArtifact(tx, {
            capabilityId: chain.capabilityId,
            artifactId: rollbackRevision.artifactId,
            studioSessionId: chain.studio.id,
            turnId: rollbackRevision.turnId,
          });
          expect(bound).toBe(true);
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      const pointer = await db.query<{ ui_artifact_id: string | null }>(
        'SELECT ui_artifact_id FROM capabilities WHERE id = $1',
        [chain.capabilityId],
      );
      expect(pointer.rows[0]?.ui_artifact_id).toBe(accepted.artifactId);
    } finally {
      await db.query('DELETE FROM sessions WHERE id = $1', [foreignStudioId]);
    }
  });

  it('复合外键拒绝跨 Session 的 Artifact 和 Message 来源 Turn', async () => {
    const source = await seedStudio();
    const target = await seedStudio();
    const turnId = randomUUID();
    await db.query(
      `INSERT INTO turns (id, session_id, status, finished_at)
       VALUES ($1, $2, 'completed', now())`,
      [turnId, source.studio.id],
    );

    await expect(
      db.query(
        `INSERT INTO artifacts (id, session_id, turn_id, kind, storage_key)
         VALUES ($1, $2, $3, 'html', $4)`,
        [randomUUID(), target.studio.id, turnId, `integration/${randomUUID()}.html`],
      ),
    ).rejects.toMatchObject({ constraint: 'fk_artifacts_turn_session' });
    await expect(
      db.query(
        `INSERT INTO messages (session_id, turn_id, idx, seq, role, content, status)
         VALUES ($1, $2, 0, NULL, 'user', '[]'::jsonb, 'completed')`,
        [target.studio.id, turnId],
      ),
    ).rejects.toMatchObject({ constraint: 'fk_messages_turn_session' });
  });
});
