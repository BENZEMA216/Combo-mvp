/* global fetch, process */
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const image =
  process.env.COMBO_MINIO_IMAGE ??
  'minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e';
const containerName = `combo-snapshot-minio-${process.pid}-${randomBytes(4).toString('hex')}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'combo-snapshot-minio-e2-'));
const envFile = join(temporaryDirectory, 'minio.env');
const accessKey = `combo${randomBytes(8).toString('hex')}`;
const secretKey = randomBytes(32).toString('base64url');
const bucket = `combo-snapshot-e2-${randomBytes(6).toString('hex')}`;
let containerStarted = false;

function command(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  if (result.status !== 0) {
    const detail = options.inherit ? '' : (result.stderr || result.stdout || '').trim();
    throw new Error(`docker ${args[0]} failed${detail.length === 0 ? '' : `: ${detail}`}`);
  }
  return options.inherit ? '' : result.stdout.trim();
}

async function cleanup() {
  if (containerStarted) {
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    containerStarted = false;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function runVitest(endpoint) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        'src/__tests__/object-storage.minio.integration.test.ts',
        '--reporter=verbose',
      ],
      {
        cwd: packageRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          COMBO_SNAPSHOT_MINIO_E2: '1',
          COMBO_SNAPSHOT_MINIO_ENDPOINT: endpoint,
          COMBO_SNAPSHOT_MINIO_ACCESS_KEY: accessKey,
          COMBO_SNAPSHOT_MINIO_SECRET_KEY: secretKey,
          COMBO_SNAPSHOT_MINIO_BUCKET: bucket,
        },
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`MinIO E2 vitest failed (${signal ?? `exit ${code}`})`));
    });
  });
}

try {
  command(['info']);
  await writeFile(
    envFile,
    `MINIO_ROOT_USER=${accessKey}\nMINIO_ROOT_PASSWORD=${secretKey}\nMINIO_BROWSER=off\n`,
    { mode: 0o600 },
  );
  command([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--env-file',
    envFile,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/data:rw,noexec,nosuid,size=512m',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--publish',
    '127.0.0.1::9000',
    image,
    'server',
    '/data',
    '--console-address',
    ':9001',
  ]);
  containerStarted = true;
  const portLine = command(['port', containerName, '9000/tcp']);
  const portMatch = /127\.0\.0\.1:(\d+)$/u.exec(portLine);
  if (portMatch === null) throw new Error(`unexpected docker port output: ${portLine}`);
  const endpoint = `http://127.0.0.1:${portMatch[1]}`;

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/minio/health/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // 容器拉起和首次初始化期间连接失败属于预期等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('disposable MinIO did not become ready within 30 seconds');
  await runVitest(endpoint);
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  await cleanup();
}
