import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runGate(name, args = [], environment = {}) {
  return spawnSync('bash', [join(repo, 'scripts/gates', name), ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function output(result) {
  return result.stdout + result.stderr;
}

async function writeExecutable(path, source = '#!/bin/sh\nexit 0\n') {
  await writeFile(path, source, 'utf8');
  await chmod(path, 0o755);
}

test('E4 prerequisite success remains NOT_RUN until a real turn and evidence exist', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'combo-e4-honesty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeExecutable(join(directory, 'codex'), '#!/bin/sh\nprintf "codex-test 1.0\\n"\n');
  await writeExecutable(join(directory, 'curl'));
  const protocolEntrypoint = join(directory, 'protocol.js');
  await writeFile(protocolEntrypoint, '', 'utf8');

  const result = runGate('e4-real-runtime.sh', [], {
    PATH: directory + ':' + process.env.PATH,
    VNX_E4_AUTOMATION_READY: 'true',
    VNX_E4_MODEL_PROXY_URL: 'https://model-proxy.invalid',
    VNX_E4_PROTOCOL_ENTRYPOINT: protocolEntrypoint,
    VNX_E4_RUNTIME_DIGEST: 'sha256:' + 'a'.repeat(64),
  });

  assert.equal(result.status, 2, output(result));
  assert.match(output(result), /PRECHECK_READY/u);
  assert.match(output(result), /E4 Gate: NOT_RUN/u);
});

test('E5 requires both executable canaries and never treats their presence as Gate PASS', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'combo-e5-honesty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binDirectory = join(directory, 'bin');
  const canaryDirectory = join(directory, 'canaries');
  await Promise.all([mkdir(binDirectory), mkdir(canaryDirectory)]);
  await writeExecutable(join(binDirectory, 'container'));
  await writeExecutable(join(canaryDirectory, 'syscall-canary'));

  const environment = {
    PATH: binDirectory + ':' + process.env.PATH,
    VNX_E5_CANARY_DIR: canaryDirectory,
    VNX_E5_IMAGE: 'example.invalid/combo@sha256:' + 'b'.repeat(64),
    VNX_E5_MODEL_PROXY_URL: 'https://model-proxy.invalid',
  };
  const incomplete = runGate('e5-isolation-canary.sh', [], environment);
  assert.equal(incomplete.status, 2, output(incomplete));
  assert.match(output(incomplete), /两个隔离 canary 都必须存在且可执行/u);

  await writeExecutable(join(canaryDirectory, 'network-canary'));
  const complete = runGate('e5-isolation-canary.sh', [], environment);
  assert.equal(complete.status, 2, output(complete));
  assert.match(output(complete), /PRECHECK_READY/u);
  assert.match(output(complete), /E5 Gate: NOT_RUN/u);
});

test('E6 validates its scenario but cannot create empty evidence or report success', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'combo-e6-honesty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidenceDirectory = join(directory, 'evidence');
  const environment = {
    VNX_E6_API_BASE_URL: 'https://api.invalid',
    VNX_E6_CREATOR_MAC_TOKEN: 'dummy-token',
    VNX_E6_DEPLOY_AUTHORIZED: 'true',
    VNX_E6_EVIDENCE_DIR: evidenceDirectory,
    VNX_E6_GATEWAY_WS_URL: 'wss://gateway.invalid',
    VNX_E6_SECOND_NETWORK_CONSUMER: 'https://consumer.invalid',
  };

  const unknown = runGate('e6-cloud-e2e.sh', ['unknown'], environment);
  assert.equal(unknown.status, 1, output(unknown));
  const result = runGate('e6-cloud-e2e.sh', ['golden-path'], environment);
  assert.equal(result.status, 2, output(result));
  assert.match(output(result), /E6 Gate: NOT_RUN/u);
  await assert.rejects(access(evidenceDirectory));
});

test('every E7 planning mode remains NOT_RUN and unknown modes fail', () => {
  const environment = {
    VNX_E6_DEPLOY_AUTHORIZED: 'true',
    VNX_E7_API_BASE_URL: 'https://api.invalid',
  };
  for (const mode of ['soak', 'dr', 'uat']) {
    const result = runGate('e7-soak-dr.sh', [mode], environment);
    assert.equal(result.status, 2, output(result));
    assert.match(output(result), /E7 Gate: NOT_RUN/u);
  }
  const unknown = runGate('e7-soak-dr.sh', ['unknown'], environment);
  assert.equal(unknown.status, 1, output(unknown));
});

test('T1 controller presence and a local matrix cannot masquerade as remote fault injection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'combo-t1-honesty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'controller-was-invoked');
  const controller = join(directory, 'failpoint-controller');
  await writeExecutable(controller, '#!/bin/sh\ntouch "' + marker + '"\n');
  await writeExecutable(join(directory, 'pnpm'));

  const result = runGate('t1-fault-injection.sh', [], {
    PATH: directory + ':' + process.env.PATH,
    VNX_T1_API_BASE_URL: 'https://api.invalid',
    VNX_T1_DEPLOY_AUTHORIZED: 'true',
    VNX_T1_FAILPOINT_CONTROLLER: controller,
    VNX_T1_MINIO_URL: 'https://minio.invalid',
    VNX_T1_PG_URL: 'postgres://invalid',
    VNX_T1_REDIS_URL: 'redis://invalid',
  });

  assert.equal(result.status, 2, output(result));
  assert.match(output(result), /PRECHECK_READY/u);
  assert.match(output(result), /T1 Gate: NOT_RUN/u);
  await assert.rejects(access(marker));
});

test('PR and Main CI ShellCheck every physical Gate script', async () => {
  for (const workflow of ['.github/workflows/pr-ci.yml', '.github/workflows/ci.yml']) {
    const source = await readFile(join(repo, workflow), 'utf8');
    assert.match(source, /scripts\/gates\/\*\.sh/u, workflow);
  }
});
