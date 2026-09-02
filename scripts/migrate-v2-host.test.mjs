import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = readFileSync(join(repo, 'scripts', 'migrate-v2-host.sh'), 'utf8');
const canonical = readFileSync(join(repo, 'scripts', 'deploy-env.sh'), 'utf8');

test('the V2 host wrapper holds the canonical shared-foundation lock through verification', () => {
  const lock = '$HOME/data/combo-foundation-shared.lock';
  assert.match(canonical, /combo-foundation-\$FOUNDATION_SET\.lock/);
  assert.ok(wrapper.includes(lock));

  const flock = wrapper.indexOf('flock -w 900 9');
  const deleteJob = wrapper.indexOf('delete job migrate');
  const applyJob = wrapper.lastIndexOf('apply -f "$render_dir/job-migrate.yaml"');
  const waitJob = wrapper.indexOf('condition=complete job/migrate');
  const verifyRoles = wrapper.indexOf('SELECT count(*) = 5 AND bool_and(rolcanlogin)');
  const verifyEnvironments = wrapper.indexOf(
    'for namespace in combo-test combo-preview combo-prod',
  );
  assert.ok(
    flock > 0 &&
      flock < deleteJob &&
      deleteJob < applyJob &&
      applyJob < waitJob &&
      waitJob < verifyRoles &&
      verifyRoles < verifyEnvironments,
  );
});

test('the wrapper applies only explicit combo-v2 manifests and never accepts a no-wait mode', () => {
  assert.match(wrapper, /set -euo pipefail\nset \+x/);
  assert.match(wrapper, /-n combo-v2 get secret combo-env/);
  assert.match(wrapper, /apply -f "\$render_dir\/namespace\.yaml"/);
  assert.match(wrapper, /apply -f "\$render_dir\/job-migrate\.yaml"/);
  assert.doesNotMatch(wrapper, /--no-wait/);
  assert.doesNotMatch(wrapper, /--force/);
});

const fakeKubectl = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_KUBECTL_LOG"
namespace=
previous=
for argument in "$@"; do
  if [[ "$previous" == -n ]]; then namespace=$argument; fi
  previous=$argument
done

if [[ " $* " == *" get secret combo-env "* && " $* " == *"jsonpath="* ]]; then
  value=c2FtZS1wYXNzd29yZA==
  if [[ "\${FAKE_SCENARIO:-success}" == secret-mismatch && "$namespace" == combo-prod ]]; then
    value=ZGlmZmVyZW50LXBhc3N3b3Jk
  fi
  printf '%s' "$value"
  exit 0
fi
if [[ " $* " == *" get namespace combo-v2 "* ]]; then
  printf '%s\n' namespace/combo-v2
  exit 0
fi
if [[ " $* " == *" get deployment "* ]]; then
  if [[ "\${FAKE_SCENARIO:-success}" == running-v2 ]]; then printf '%s' 1; fi
  exit 0
fi
if [[ " $* " == *" get job migrate "* ]]; then
  if [[ "\${FAKE_SCENARIO:-success}" == stale-job && -f "$FAKE_JOB_STATE" ]]; then
    printf '%s\n' job.batch/migrate
  fi
  exit 0
fi
if [[ " $* " == *" get pods "* ]]; then exit 0; fi
if [[ " $* " == *" delete job migrate "* ]]; then
  if flock -n 8 8>"$HOME/data/combo-foundation-shared.lock"; then
    printf '%s\n' cleanup-lock-free >> "$FAKE_KUBECTL_LOG"
  else
    printf '%s\n' cleanup-lock-held >> "$FAKE_KUBECTL_LOG"
  fi
  if [[ "\${FAKE_SCENARIO:-success}" == stale-job && ! -f "$FAKE_JOB_DELETE_RETRIED" ]]; then
    : > "$FAKE_JOB_DELETE_RETRIED"
    exit 1
  fi
  rm -f "$FAKE_JOB_STATE"
  exit 0
fi
if [[ " $* " == *"--for=condition=complete job/migrate"* ]]; then
  if [[ "\${FAKE_SCENARIO:-success}" == timeout ]]; then exit 1; fi
  if [[ "\${FAKE_SCENARIO:-success}" == interrupt ]]; then
    printf '%s\n' wait-started >> "$FAKE_KUBECTL_LOG"
    while true; do sleep 1; done
  fi
  exit 0
fi
if [[ " $* " == *" exec deployment/"* && " $* " == *"process.env.PGPASSWORD"* ]]; then
  value=c2FtZS1wYXNzd29yZA==
  if [[ "\${FAKE_SCENARIO:-success}" == pod-stale && "$namespace" == combo-prod ]]; then
    value=b2xkLXBhc3N3b3Jk
  fi
  printf '%s' "$value"
  exit 0
fi
if [[ "$namespace" == combo-foundation && " $* " == *" exec statefulset/postgres "* ]]; then
  printf '%s\n' t
  exit 0
fi
exit 0
`;

const fakeFlock = `#!/usr/bin/env python3
import os
import subprocess
import sys

owner_file = os.environ['FAKE_FLOCK_OWNER']

def owner_alive():
    try:
        with open(owner_file, encoding='utf8') as handle:
            owner = int(handle.read())
        os.kill(owner, 0)
        return True
    except (FileNotFoundError, ProcessLookupError, ValueError):
        return False
    except PermissionError:
        return True

arguments = sys.argv[1:]
if len(arguments) == 3 and arguments[:2] == ['-w', '900'] and arguments[2] == '9':
    with open(owner_file, 'w', encoding='utf8') as handle:
        handle.write(str(os.getppid()))
    raise SystemExit(0)
if arguments and arguments[0] == '-n':
    if owner_alive():
        raise SystemExit(1)
    if len(arguments) >= 3 and not arguments[1].isdigit():
        raise SystemExit(subprocess.run(arguments[2:], check=False).returncode)
    raise SystemExit(0)
raise SystemExit(2)
`;

const fakeSleep = `#!/usr/bin/env bash
if [[ "\${FAKE_SCENARIO:-success}" == stale-job ]]; then exit 0; fi
exec /bin/sleep "$@"
`;

function fixture(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'combo-v2-host-wrapper-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const render = join(root, 'render');
  const log = join(root, 'kubectl.log');
  const kubeconfig = join(root, 'kubeconfig');
  const flockOwner = join(root, 'flock.owner');
  const jobState = join(root, 'job.state');
  const jobDeleteRetried = join(root, 'job-delete-retried');
  mkdirSync(join(home, 'data'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(render);
  writeFileSync(log, '');
  writeFileSync(join(render, 'namespace.yaml'), 'kind: Namespace\n');
  writeFileSync(join(render, 'job-migrate.yaml'), 'kind: Job\n');
  writeFileSync(kubeconfig, 'test\n');
  const kubectl = join(bin, 'kubectl');
  writeFileSync(kubectl, fakeKubectl);
  chmodSync(kubectl, 0o755);
  const flock = join(bin, 'flock');
  writeFileSync(flock, fakeFlock);
  chmodSync(flock, 0o755);
  const sleep = join(bin, 'sleep');
  writeFileSync(sleep, fakeSleep);
  chmodSync(sleep, 0o755);
  if (scenario === 'stale-job') writeFileSync(jobState, 'present\n');
  return {
    root,
    log,
    lock: join(home, 'data', 'combo-foundation-shared.lock'),
    args: [
      join(repo, 'scripts', 'migrate-v2-host.sh'),
      '--render-dir',
      render,
      '--kubeconfig',
      kubeconfig,
    ],
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_KUBECTL_LOG: log,
      FAKE_SCENARIO: scenario,
      FAKE_FLOCK_OWNER: flockOwner,
      FAKE_JOB_STATE: jobState,
      FAKE_JOB_DELETE_RETRIED: jobDeleteRetried,
    },
  };
}

function lines(path) {
  return readFileSync(path, 'utf8').trim().split('\n');
}

function assertOneCredentialConnectionExecPerDeployment(log) {
  for (const namespace of ['combo-preview', 'combo-prod']) {
    for (const deployment of ['api', 'worker', 'runtime']) {
      assert.equal(
        log.filter((line) =>
          line.includes(`-n ${namespace} exec deployment/${deployment} -- node -e`),
        ).length,
        1,
        `${namespace}/${deployment}`,
      );
    }
  }
}

test('a timed-out Job is terminated and observed absent while the host lock is held', () => {
  const context = fixture('timeout');
  try {
    const result = spawnSync('bash', context.args, {
      env: context.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    const log = lines(context.log);
    const wait = log.findIndex((line) => line.includes('condition=complete job/migrate'));
    const cleanup = log.findIndex(
      (line, index) => index > wait && line.includes('delete job migrate'),
    );
    assert.ok(wait >= 0 && cleanup > wait, log.join('\n'));
    assert.equal(log[cleanup + 1], 'cleanup-lock-held');
    assert.equal(spawnSync('flock', ['-n', context.lock, 'true'], { env: context.env }).status, 0);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('a shared role Secret mismatch stops before the migration Job is applied', () => {
  const context = fixture('secret-mismatch');
  try {
    const result = spawnSync('bash', context.args, {
      env: context.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /shared role Secret mismatch/);
    assert.equal(
      lines(context.log).some((line) => line.includes('apply -f') && line.includes('job-migrate')),
      false,
    );
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('a running old V2 writer stops the offline migration before Job apply', () => {
  const context = fixture('running-v2');
  try {
    const result = spawnSync('bash', context.args, {
      env: context.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /must be scaled to zero/);
    assert.equal(
      lines(context.log).some((line) => line.includes('apply -f') && line.includes('job-migrate')),
      false,
    );
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('a surviving Job object with no Pod keeps the lock and triggers another delete', () => {
  const context = fixture('stale-job');
  try {
    const result = spawnSync('bash', context.args, {
      env: context.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const log = lines(context.log);
    const deletes = log.filter((line) => line.includes('delete job migrate'));
    assert.ok(deletes.length >= 3, log.join('\n'));
    assert.equal(
      log.some((line) => line === 'cleanup-lock-free'),
      false,
    );
    assert.equal(spawnSync('flock', ['-n', context.lock, 'true'], { env: context.env }).status, 0);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('a Pod with stale injected credentials fails the post-migration connection gate', () => {
  const context = fixture('pod-stale');
  try {
    const result = spawnSync('bash', context.args, {
      env: context.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /credential or fresh connection failed/);
    const log = lines(context.log);
    assertOneCredentialConnectionExecPerDeployment(log);
    assert.equal(
      log.some((line) => line === 'cleanup-lock-free'),
      false,
    );
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('an interrupted wrapper terminates the Job before releasing the host lock', async () => {
  const context = fixture('interrupt');
  try {
    const child = spawn('bash', context.args, {
      env: context.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !readFileSync(context.log, 'utf8').includes('wait-started')) {
      await delay(25);
    }
    assert.match(readFileSync(context.log, 'utf8'), /wait-started/);
    process.kill(-child.pid, 'SIGTERM');
    const exit = await new Promise((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    assert.deepEqual(exit, { code: 143, signal: null }, stderr);

    const log = lines(context.log);
    const wait = log.findIndex((line) => line === 'wait-started');
    const cleanup = log.findIndex(
      (line, index) => index > wait && line.includes('delete job migrate'),
    );
    assert.ok(cleanup > wait, log.join('\n'));
    assert.equal(log[cleanup + 1], 'cleanup-lock-held');
    assert.equal(spawnSync('flock', ['-n', context.lock, 'true'], { env: context.env }).status, 0);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});
