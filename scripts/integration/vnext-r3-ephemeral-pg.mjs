import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const CLUSTER_NAME = 'combo-vnext-r3-ephemeral';
const MIGRATION_HEAD = '0030_creator_agent_runtime_product_wiring.sql';
const ADMIN_ROLE = 'combo_r3_test_admin';
const EPHEMERAL_ROLE_PASSWORD = 'combo-r3-ephemeral-role-password';
const POSTGRES_PORT = '5432';
const READY_ATTEMPTS = 200;
const READY_INTERVAL_MS = 50;
const MAX_POSTGRES_LOG_BYTES = 1_000_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
const COMMAND_TERMINATION_GRACE_MS = 5_000;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'combo-vnext-r3-pg-'));
const dataDirectory = join(temporaryRoot, 'data');
const socketDirectory = join(temporaryRoot, 'socket');
mkdirSync(socketDirectory, { mode: 0o700 });

let postgresProcess;
let postgresLog = '';
let postgresStartError;
let cleanupPromise;
let activeCommandProcess;

function executable(envName, fallback) {
  const configured = process.env[envName]?.trim();
  return configured && configured.length > 0 ? configured : fallback;
}

function appendPostgresLog(chunk) {
  postgresLog += chunk.toString('utf8');
  if (Buffer.byteLength(postgresLog, 'utf8') > MAX_POSTGRES_LOG_BYTES) {
    postgresLog = postgresLog.slice(-MAX_POSTGRES_LOG_BYTES);
  }
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function terminateChild(child, signal) {
  if (childHasExited(child)) return;
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  child.kill(signal);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    if (activeCommandProcess !== undefined) {
      rejectRun(new Error('ephemeral PostgreSQL gate commands must run sequentially'));
      return;
    }
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      detached: process.platform !== 'win32',
    });
    activeCommandProcess = child;
    let stdout = '';
    let stderr = '';
    let timeoutError;
    let killTimer;
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const timeoutTimer = setTimeout(() => {
      timeoutError = new Error(
        `${command} ${args.join(' ')} timed out after ${String(timeoutMs)}ms`,
      );
      terminateChild(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        terminateChild(child, 'SIGKILL');
      }, COMMAND_TERMINATION_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();
    const finish = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (activeCommandProcess === child) activeCommandProcess = undefined;
    };
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      finish();
      rejectRun(timeoutError ?? error);
    });
    child.once('exit', (code, signal) => {
      finish();
      if (timeoutError) {
        rejectRun(timeoutError);
        return;
      }
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit ${String(code)}`;
      rejectRun(
        new Error(
          `${command} ${args.join(' ')} failed with ${suffix}` +
            `${stderr.length > 0 ? `\n${stderr}` : ''}`,
        ),
      );
    });
  });
}

async function stopActiveCommand() {
  const child = activeCommandProcess;
  if (child === undefined || childHasExited(child)) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  terminateChild(child, 'SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(COMMAND_TERMINATION_GRACE_MS, false),
  ]);
  if (!stopped && !childHasExited(child)) {
    terminateChild(child, 'SIGKILL');
    await exited;
  }
}

function postgresHasExited() {
  return (
    postgresProcess === undefined ||
    postgresProcess.exitCode !== null ||
    postgresProcess.signalCode !== null
  );
}

async function waitForPostgres() {
  const pgIsReady = executable('PG_ISREADY_BIN', 'pg_isready');
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    if (postgresStartError) throw postgresStartError;
    if (postgresHasExited()) {
      throw new Error(`ephemeral PostgreSQL exited before readiness\n${postgresLog}`);
    }
    try {
      await run(
        pgIsReady,
        [
          '--host',
          socketDirectory,
          '--port',
          POSTGRES_PORT,
          '--username',
          ADMIN_ROLE,
          '--dbname',
          'postgres',
          '--quiet',
        ],
        { capture: true },
      );
      return;
    } catch {
      await delay(READY_INTERVAL_MS);
    }
  }
  throw new Error(`ephemeral PostgreSQL readiness timed out\n${postgresLog}`);
}

async function stopPostgres() {
  if (postgresHasExited()) return;
  const exited = new Promise((resolveExit) => postgresProcess.once('exit', resolveExit));
  postgresProcess.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(10_000, false)]);
  if (!stopped && !postgresHasExited()) {
    postgresProcess.kill('SIGKILL');
    await exited;
  }
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await stopPostgres();
    rmSync(temporaryRoot, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void Promise.allSettled([stopActiveCommand(), cleanup()]).finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  });
}

try {
  await run(
    executable('INITDB_BIN', 'initdb'),
    [
      '--pgdata',
      dataDirectory,
      '--username',
      ADMIN_ROLE,
      '--auth-local=trust',
      '--auth-host=reject',
      '--encoding=UTF8',
      '--no-locale',
      '--no-instructions',
    ],
    { capture: true },
  );

  postgresProcess = spawn(
    executable('POSTGRES_BIN', 'postgres'),
    [
      '-D',
      dataDirectory,
      '-c',
      `cluster_name=${CLUSTER_NAME}`,
      '-h',
      '',
      '-p',
      POSTGRES_PORT,
      '-k',
      socketDirectory,
      '-c',
      'unix_socket_permissions=0700',
    ],
    { cwd: repositoryRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  postgresProcess.stdout.on('data', appendPostgresLog);
  postgresProcess.stderr.on('data', appendPostgresLog);
  postgresProcess.once('error', (error) => {
    postgresStartError = error;
  });
  await waitForPostgres();

  const encodedSocket = encodeURIComponent(socketDirectory);
  const databaseUrl =
    `postgresql://${ADMIN_ROLE}@localhost:${POSTGRES_PORT}/postgres` +
    `?host=${encodedSocket}&application_name=combo_vnext_r3_gate`;
  const isolatedEnvironment = {
    DATABASE_URL: databaseUrl,
    CREATOR_AGENT_PG_TEST_URL: databaseUrl,
    CREATOR_AGENT_R3_PG_CLUSTER_NAME: CLUSTER_NAME,
    CREATOR_AGENT_R3_PG_ISOLATED: '1',
    EXPECTED_MIGRATION_HEAD: MIGRATION_HEAD,
    POSTGRES_API_PASSWORD: EPHEMERAL_ROLE_PASSWORD,
    POSTGRES_WORKER_PASSWORD: EPHEMERAL_ROLE_PASSWORD,
    POSTGRES_RUNTIME_PASSWORD: EPHEMERAL_ROLE_PASSWORD,
    POSTGRES_AGENT_API_PASSWORD: EPHEMERAL_ROLE_PASSWORD,
    POSTGRES_AGENT_BROKER_PASSWORD: EPHEMERAL_ROLE_PASSWORD,
    POSTGRES_AGENT_CONSUMER_API_PASSWORD: EPHEMERAL_ROLE_PASSWORD,
    POSTGRES_AGENT_RECONCILER_PASSWORD: EPHEMERAL_ROLE_PASSWORD,
  };

  await run('bash', ['scripts/integration/db-migrate.sh'], {
    env: { ...isolatedEnvironment, MIGRATION_RUNS: '2' },
  });
  await run('pnpm', ['-F', '@cb/shared', 'build'], {
    env: isolatedEnvironment,
  });
  await run('pnpm', ['-F', '@cb/creator-agent-protocol', 'build'], {
    env: isolatedEnvironment,
  });
  await run(
    'pnpm',
    [
      '-F',
      '@cb/db',
      'exec',
      'vitest',
      'run',
      '__tests__/creator-agent-runtime-product-wiring-migration.test.ts',
      '__tests__/creator-agent-runtime-product-wiring.pg.test.ts',
    ],
    {
      env: {
        ...isolatedEnvironment,
        CREATOR_AGENT_RUNTIME_PRODUCT_PG_TEST: '1',
      },
    },
  );
  await run('pnpm', ['-F', '@cb/creator-agent-persistence', 'build'], {
    env: isolatedEnvironment,
  });
  await run(
    'pnpm',
    [
      '-F',
      '@cb/creator-agent-persistence',
      'exec',
      'vitest',
      'run',
      'src/cloud-journal.pg.test.ts',
      '-t',
      'continues prepared and terminal facts after replacement revokes the old transport Lease',
    ],
    {
      env: {
        ...isolatedEnvironment,
        CREATOR_AGENT_PERSISTENCE_PG_TEST: '1',
      },
    },
  );
  await run('pnpm', ['-F', '@cb/agent-gateway', 'pretest'], {
    env: isolatedEnvironment,
  });
  await run('pnpm', ['-F', '@cb/creator-worker-broker-client', 'pretest'], {
    env: isolatedEnvironment,
  });
  await run('pnpm', ['-F', '@cb/creator-worker', 'build'], {
    env: isolatedEnvironment,
  });
  await run('pnpm', ['-F', '@cb/runtime', 'build'], {
    env: isolatedEnvironment,
  });
  await run('pnpm', ['-F', '@cb/runtime', 'typecheck:test'], {
    env: isolatedEnvironment,
  });
  await run('pnpm', ['-F', '@cb/scripts', 'typecheck:test'], {
    env: isolatedEnvironment,
  });
  await run(
    'pnpm',
    ['exec', 'vitest', 'run', 'scripts/integration/vnext-r3-crypto-boundary.test.ts'],
    { env: isolatedEnvironment },
  );
  await run(
    'pnpm',
    [
      '-F',
      '@cb/agent-gateway',
      'exec',
      'vitest',
      'run',
      'src/postgres-lifecycle-publisher.pg.test.ts',
    ],
    {
      env: {
        ...isolatedEnvironment,
        CREATOR_AGENT_GATEWAY_LIFECYCLE_PG_TEST: '1',
        CREATOR_AGENT_GATEWAY_LIFECYCLE_PG_ISOLATED: '1',
        CREATOR_AGENT_GATEWAY_LIFECYCLE_PG_URL: databaseUrl,
      },
    },
  );
  await run(
    'pnpm',
    ['exec', 'vitest', 'run', 'scripts/integration/vnext-r3-worker-host.pg.test.ts'],
    {
      env: {
        ...isolatedEnvironment,
        CREATOR_AGENT_R3_WORKER_HOST_PG_TEST: '1',
        CREATOR_AGENT_R3_WORKER_HOST_PG_URL: databaseUrl,
      },
    },
  );
} catch (error) {
  if (postgresLog.length > 0) {
    process.stderr.write(`\n[ephemeral-postgres]\n${postgresLog}\n`);
  }
  throw error;
} finally {
  await cleanup();
}
