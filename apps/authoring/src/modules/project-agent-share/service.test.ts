import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CreateProjectAgentShareBody } from '@cb/shared';
import type { Queryable, QueryResultLike } from '../../platform/infra/db.js';
import { getProjectAgentShareHandler } from './handlers.js';
import {
  createProjectAgentShare,
  readProjectAgentShare,
  readProjectAgentShareWithToken,
} from './service.js';

const OWNER_A = '00000000-0000-4000-8000-000000000001';
const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);
const NOW = new Date('2026-08-10T00:00:00.000Z');

const body: CreateProjectAgentShareBody = {
  name: 'Repository reviewer',
  description: 'Review one immutable Git Project with Codex.',
  repositoryUrl: 'https://github.com/openai/codex.git',
  sourceRef: 'refs/heads/main',
  commitSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  startPrompt: 'Inspect this repository and explain its architecture.',
  requirements: {
    commands: ['git'],
    plugins: ['combo@dangdang-tech-combo'],
    environmentVariableNames: ['DATABASE_URL'],
  },
  idempotencyKey: '00000000-0000-4000-8000-000000000002',
};

interface StoredRow {
  id: string;
  owner_user_id: string;
  share_token: string;
  manifest: Record<string, unknown>;
  manifest_sha256: string;
  idempotency_key: string;
  idempotency_sha256: string;
  created_at: string;
}

class FakeShareDb implements Queryable {
  readonly rows: StoredRow[] = [];

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    if (sql.includes('INSERT INTO project_agent_shares')) {
      const existing = this.rows.find(
        (row) => row.owner_user_id === params[0] && row.idempotency_key === params[4],
      );
      if (existing) return { rows: [], rowCount: 0 };
      const row: StoredRow = {
        id: '00000000-0000-4000-8000-000000000099',
        owner_user_id: String(params[0]),
        share_token: String(params[1]),
        manifest: JSON.parse(String(params[2])) as Record<string, unknown>,
        manifest_sha256: String(params[3]),
        idempotency_key: String(params[4]),
        idempotency_sha256: String(params[5]),
        created_at: String(params[6]),
      };
      this.rows.push(row);
      return { rows: [row as R], rowCount: 1 };
    }
    if (sql.includes('WHERE owner_user_id')) {
      const row = this.rows.find(
        (candidate) =>
          candidate.owner_user_id === params[0] && candidate.idempotency_key === params[1],
      );
      return { rows: row ? [row as R] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('WHERE share_token')) {
      const row = this.rows.find((candidate) => candidate.share_token === params[0]);
      return { rows: row ? [row as R] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

async function create(db: FakeShareDb, overrides: Partial<CreateProjectAgentShareBody> = {}) {
  return createProjectAgentShare(db, {
    ownerUserId: OWNER_A,
    body: { ...body, ...overrides },
    publicOrigin: 'https://test.example',
    now: () => NOW,
    randomToken: () => TOKEN_A,
  });
}

describe('Project Agent share service', () => {
  it('replays a lost create response with the byte-identical share URL and copy prompt', async () => {
    const db = new FakeShareDb();
    const first = await create(db);
    const replay = await createProjectAgentShare(db, {
      ownerUserId: OWNER_A,
      body,
      publicOrigin: 'https://test.example',
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      randomToken: () => TOKEN_B,
    });

    expect(first.kind).toBe('created');
    expect(replay.kind).toBe('replayed');
    expect(replay).toEqual({ ...first, kind: 'replayed' });
    expect(db.rows).toHaveLength(1);
    if (first.kind !== 'created') throw new Error('unexpected outcome');
    expect(first.result.shareUrl).toBe(`https://test.example/project-agent/${TOKEN_A}`);
    expect(first.result.copyPrompt)
      .toBe(`请使用 Combo 的 read_project_agent_share 读取并审查这个 Project Agent 分享：
https://test.example/project-agent/${TOKEN_A}

如果当前任务没有 read_project_agent_share，先读取同环境安装页 https://test.example/codex-plugin，只用 Codex Desktop 内置 CLI 安装或升级；首次安装，或可调用工具明确返回 authorization 错误时，再完成 OAuth。然后在新的顶层任务继续处理同一分享请求；无需默认重启，只有新任务工具清单仍未更新时才按安装页兜底。

先展示仓库、sourceRef、commit/tree SHA、依赖声明和安全边界，不要立即执行分享者的启动任务。我明确确认后，再恢复该 commit 中的 Git tracked files，核对 commit 与 tree SHA，并使用真实 Codex Harness 开始新任务。不要上传或恢复 Cookie、令牌、环境变量值、Codex 会话、ignored 或 untracked files。这个公开链接不会过期且 V0 不能撤销，manifest 中不得包含秘密；Combo 只保存 manifest，不托管 Git 对象。`);
    expect(first.result.copyPrompt).not.toContain('plugin marketplace add');
    expect(first.result.copyPrompt).not.toContain(body.startPrompt);
    expect(first.result.copyPrompt).not.toContain(body.description);
  });

  it('rejects the same owner/key with a different normalized body', async () => {
    const db = new FakeShareDb();
    await create(db);
    const conflict = await create(db, { startPrompt: 'A different task.' });
    expect(conflict).toEqual({ kind: 'idempotency_conflict' });
    expect(db.rows).toHaveLength(1);
  });

  it('reads by link without an owner predicate and rejects another environment or path', async () => {
    const db = new FakeShareDb();
    const created = await create(db);
    if (created.kind !== 'created') throw new Error('unexpected outcome');

    const publicRead = await readProjectAgentShare(db, {
      publicOrigin: 'https://test.example',
      shareUrl: created.result.shareUrl,
    });
    expect(publicRead).toEqual({ kind: 'found', result: created.result });
    expect(
      await readProjectAgentShare(db, {
        publicOrigin: 'https://test.example',
        shareUrl: `https://evil.example/project-agent/${TOKEN_A}`,
      }),
    ).toEqual({ kind: 'invalid_url' });
    expect(
      await readProjectAgentShare(db, {
        publicOrigin: 'https://test.example',
        shareUrl: `https://test.example/project-agent/${TOKEN_A}?leak=1`,
      }),
    ).toEqual({ kind: 'invalid_url' });
  });

  it('fails closed when stored manifest content or digest is tampered', async () => {
    const db = new FakeShareDb();
    await create(db);
    db.rows[0]!.manifest = { ...db.rows[0]!.manifest, description: 'tampered' };
    await expect(
      readProjectAgentShareWithToken(db, {
        publicOrigin: 'https://test.example',
        shareToken: TOKEN_A,
      }),
    ).rejects.toThrow('manifest digest mismatch');

    const digestDb = new FakeShareDb();
    await create(digestDb);
    digestDb.rows[0]!.manifest_sha256 = '0'.repeat(64);
    await expect(
      readProjectAgentShareWithToken(digestDb, {
        publicOrigin: 'https://test.example',
        shareToken: TOKEN_A,
      }),
    ).rejects.toThrow('manifest digest mismatch');
  });

  it('serves an anonymous HTTP read with private/no-store, no-referrer and noindex headers', async () => {
    const db = new FakeShareDb();
    await create(db);
    const headers = new Map<string, string>();
    let statusCode = 0;
    let sentBody: unknown;
    const reply = {
      header(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      code(status: number) {
        statusCode = status;
        return this;
      },
      send(value: unknown) {
        sentBody = value;
        return this;
      },
    } as unknown as FastifyReply;
    const logError = vi.fn();
    const request = {
      id: 'trace-public-share',
      params: { shareToken: TOKEN_A },
      log: { error: logError },
      server: {
        infra: {
          db,
          env: { EXTERNAL_MCP_PUBLIC_ORIGIN: 'https://test.example' },
        },
      },
    } as unknown as FastifyRequest;

    await getProjectAgentShareHandler().call(request.server, request, reply);
    expect(statusCode).toBe(200);
    expect(sentBody).toMatchObject({ data: { manifest: { name: body.name } } });
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(logError).not.toHaveBeenCalled();
  });
});
