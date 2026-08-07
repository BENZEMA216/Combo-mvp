import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { renderConnectScript } from '../modules/task/connect-script.js';

type JsonBody = Record<string, unknown>;

async function readJson(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonBody;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function runScript(
  script: string,
  env: Record<string, string | undefined>,
): Promise<{ code: number; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const child = spawn('sh', ['-s'], {
    env: childEnv,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(script);
  const [code] = (await once(child, 'close')) as [number];
  return { code, stderr };
}

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureHome(
  contents = '{"message":"hello"}\n',
): Promise<{ home: string; cache: string }> {
  const home = await mkdtemp(join(tmpdir(), 'combo-script-test-'));
  tempRoots.push(home);
  const sessions = join(home, '.codex', 'sessions');
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, 'one.jsonl'), contents, 'utf8');
  return { home, cache: join(home, 'cache') };
}

describe('renderConnectScript uploader', () => {
  it('响应丢失后先确认已落地，不重复发送同一片', async () => {
    const landed = new Set<number>();
    const uploadAttempts = new Map<number, number>();
    let bundleId = '';
    const server = createServer(async (req, res) => {
      const body = await readJson(req);
      if (req.url === '/api/v1/connect/prepare') {
        bundleId = String(body.bundleId);
        sendJson(res, 200, {
          data: {
            protocolVersion: 2,
            bundleId,
            totalParts: Number(body.totalParts),
            landedParts: [...landed],
            complete: landed.size === Number(body.totalParts),
          },
        });
        return;
      }
      if (req.url === '/api/v1/connect/upload') {
        const index = Number(body.partIndex);
        uploadAttempts.set(index, (uploadAttempts.get(index) ?? 0) + 1);
        landed.add(index);
        if (index === 0 && uploadAttempts.get(index) === 1) {
          req.socket.destroy(); // 对客户端表现为响应丢失；服务端已登记。
          return;
        }
        sendJson(res, 200, {
          data: {
            landed: landed.size,
            total: Number(body.totalParts),
            complete: landed.size === Number(body.totalParts),
          },
        });
        return;
      }
      sendJson(res, 404, {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const { home, cache } = await fixtureHome(
      `${'a'.repeat(1_100_000)}\n${'b'.repeat(1_100_000)}\n`,
    );
    const script = renderConnectScript({
      base: `http://127.0.0.1:${address.port}`,
      pairingCode: 'TEST-CODE',
    });
    const result = await runScript(script, {
      HOME: home,
      COMBO_CACHE_DIR: cache,
      COMBO_UPLOAD_TIMEOUT: '1',
      COMBO_UPLOAD_ATTEMPTS: '2',
      COMBO_RETRY_BASE_DELAY: '0',
      COMBO_SOURCE_SCOPE: 'history',
    });
    server.close();

    expect(result.code, result.stderr).toBe(0);
    expect(uploadAttempts.get(0)).toBe(1);
    expect(uploadAttempts.get(1)).toBe(1);
    expect(bundleId).toMatch(/^[a-f0-9]{64}$/);
    expect(await readdir(cache)).toEqual([]);
  }, 20_000);

  it('失败保留快照，重跑复用同一 bundle 并禁止替换', async () => {
    let failUpload = true;
    const bundleIds: string[] = [];
    const replaceFlags: boolean[] = [];
    const server = createServer(async (req, res) => {
      const body = await readJson(req);
      if (req.url === '/api/v1/connect/prepare') {
        bundleIds.push(String(body.bundleId));
        replaceFlags.push(Boolean(body.replaceExisting));
        sendJson(res, 200, {
          data: {
            protocolVersion: 2,
            bundleId: body.bundleId,
            totalParts: body.totalParts,
            landedParts: [],
            complete: false,
          },
        });
        return;
      }
      if (req.url === '/api/v1/connect/upload' && failUpload) {
        sendJson(res, 503, { error: { userMessage: 'temporary' } });
        return;
      }
      if (req.url === '/api/v1/connect/upload') {
        sendJson(res, 200, { data: { landed: 1, total: 1, complete: true } });
        return;
      }
      sendJson(res, 404, {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const { home, cache } = await fixtureHome();
    const script = renderConnectScript({
      base: `http://127.0.0.1:${address.port}`,
      pairingCode: 'TEST-CODE',
    });
    const env = {
      HOME: home,
      COMBO_CACHE_DIR: cache,
      COMBO_UPLOAD_TIMEOUT: '1',
      COMBO_UPLOAD_ATTEMPTS: '1',
      COMBO_RETRY_BASE_DELAY: '0',
      COMBO_SOURCE_SCOPE: 'history',
    };
    const first = await runScript(script, env);
    expect(first.code).toBe(1);
    const cacheEntries = await readdir(cache);
    expect(cacheEntries).toHaveLength(1);
    const manifest = JSON.parse(
      await readFile(join(cache, cacheEntries[0]!, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({ sourceScope: 'history', sourceKey: 'history' });

    failUpload = false;
    const second = await runScript(script, env);
    server.close();
    expect(second.code, second.stderr).toBe(0);
    expect(bundleIds[0]).toBe(bundleIds.at(-1));
    expect(replaceFlags[0]).toBe(true);
    expect(replaceFlags.at(-1)).toBe(false);
    expect(await readdir(cache)).toEqual([]);
  }, 20_000);

  it('current-task scope uploads exactly the matching Codex session and excludes decoys', async () => {
    const threadId = '019fdd00-ff57-7550-be78-654a2e4cd49e';
    const uploaded: string[] = [];
    const server = createServer(async (req, res) => {
      const body = await readJson(req);
      if (req.url === '/api/v1/connect/prepare') {
        sendJson(res, 200, {
          data: {
            protocolVersion: 2,
            bundleId: body.bundleId,
            totalParts: body.totalParts,
            landedParts: [],
            complete: false,
          },
        });
        return;
      }
      if (req.url === '/api/v1/connect/upload') {
        uploaded.push(String(body.content));
        sendJson(res, 200, { data: { landed: 1, total: 1, complete: true } });
        return;
      }
      sendJson(res, 404, {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const home = await mkdtemp(join(tmpdir(), 'combo-current-task-test-'));
    tempRoots.push(home);
    const sessions = join(home, '.codex', 'sessions', '2026', '08', '08');
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, `rollout-current-${threadId}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n{"marker":"current-only"}\n`,
      'utf8',
    );
    await writeFile(
      join(sessions, 'rollout-decoy-00000000-0000-4000-8000-000000000001.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-000000000001' } })}\n{"marker":"must-not-upload"}\n`,
      'utf8',
    );

    const script = renderConnectScript({
      base: `http://127.0.0.1:${address.port}`,
      pairingCode: 'CURRENT-TASK-CODE',
    });
    const result = await runScript(script, {
      HOME: home,
      CODEX_THREAD_ID: threadId,
      COMBO_CACHE_DIR: join(home, 'cache'),
      COMBO_SOURCE_SCOPE: 'codex_current_task',
    });
    server.close();

    expect(result.code, result.stderr).toBe(0);
    expect(uploaded.join('\n')).toContain('current-only');
    expect(uploaded.join('\n')).not.toContain('must-not-upload');
    expect(result.stderr).toContain('当前 Codex 任务（1 个会话）');
  }, 20_000);

  it.each([
    ['missing thread identity', undefined],
    ['malformed thread identity', 'not-a-uuid'],
    ['no matching session', '00000000-0000-4000-8000-000000000099'],
  ])('fails closed before network for %s', async (_label, threadId) => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      sendJson(res, 500, {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const { home, cache } = await fixtureHome();
    const script = renderConnectScript({
      base: `http://127.0.0.1:${address.port}`,
      pairingCode: 'FAIL-CLOSED-CODE',
    });
    const result = await runScript(script, {
      HOME: home,
      CODEX_THREAD_ID: threadId,
      COMBO_CACHE_DIR: cache,
      COMBO_SOURCE_SCOPE: 'codex_current_task',
      COMBO_UPLOAD_ATTEMPTS: '1',
    });
    server.close();

    expect(result.code).toBe(1);
    expect(requestCount).toBe(0);
    expect(result.stderr).toContain('已在上传前停止');
    expect(result.stderr).not.toContain('无法确认上传状态');
  });

  it('fails closed when an old connection command omits the source scope', async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      sendJson(res, 500, {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const { home, cache } = await fixtureHome();
    const script = renderConnectScript({
      base: `http://127.0.0.1:${address.port}`,
      pairingCode: 'OLD-UNSCOPED-CODE',
    });
    const result = await runScript(script, {
      HOME: home,
      COMBO_CACHE_DIR: cache,
      COMBO_SOURCE_SCOPE: undefined,
      COMBO_UPLOAD_ATTEMPTS: '1',
    });
    server.close();

    expect(result.code).toBe(1);
    expect(requestCount).toBe(0);
    expect(result.stderr).toContain('连接命令缺少有效的数据范围');
    expect(result.stderr).toContain('已在上传前停止');
  });

  it('rejects duplicate current-task matches before network', async () => {
    const threadId = '019fdd00-ff57-7550-be78-654a2e4cd49e';
    const home = await mkdtemp(join(tmpdir(), 'combo-unsafe-current-task-test-'));
    tempRoots.push(home);
    const sessions = join(home, '.codex', 'sessions');
    const first = join(sessions, 'one');
    const second = join(sessions, 'two');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const content = `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`;
    const target = join(first, `rollout-one-${threadId}.jsonl`);
    await writeFile(target, content, 'utf8');
    await symlink(target, join(second, `rollout-two-${threadId}.jsonl`));

    const script = renderConnectScript({
      base: 'http://127.0.0.1:1',
      pairingCode: 'UNSAFE-PATH-CODE',
    });
    const result = await runScript(script, {
      HOME: home,
      CODEX_THREAD_ID: threadId,
      COMBO_CACHE_DIR: join(home, 'cache'),
      COMBO_SOURCE_SCOPE: 'codex_current_task',
      COMBO_UPLOAD_ATTEMPTS: '1',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('匹配到 2 个');
    expect(result.stderr).toContain('已在上传前停止');
  });

  it('rejects a unique symlinked current-task match before network', async () => {
    const threadId = '019fdd00-ff57-7550-be78-654a2e4cd49e';
    const home = await mkdtemp(join(tmpdir(), 'combo-symlink-current-task-test-'));
    tempRoots.push(home);
    const sessions = join(home, '.codex', 'sessions');
    const outside = join(home, 'outside');
    await mkdir(sessions, { recursive: true });
    await mkdir(outside, { recursive: true });
    const target = join(outside, 'target.jsonl');
    await writeFile(
      target,
      `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`,
      'utf8',
    );
    await symlink(target, join(sessions, `rollout-link-${threadId}.jsonl`));

    const script = renderConnectScript({
      base: 'http://127.0.0.1:1',
      pairingCode: 'SYMLINK-PATH-CODE',
    });
    const result = await runScript(script, {
      HOME: home,
      CODEX_THREAD_ID: threadId,
      COMBO_CACHE_DIR: join(home, 'cache'),
      COMBO_SOURCE_SCOPE: 'codex_current_task',
      COMBO_UPLOAD_ATTEMPTS: '1',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('符号链接');
    expect(result.stderr).toContain('已在上传前停止');
  });
});
