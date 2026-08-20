import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function runLegacyTestDeployment(managedBy, { inspectionError = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'combo-deploy-gateway-retire-'));
  try {
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const render = join(root, 'render');
    const log = join(root, 'kubectl.log');
    const state = join(root, 'gateway-deleted');
    mkdirSync(join(home, 'data'), { recursive: true });
    mkdirSync(bin);
    mkdirSync(render);
    writeFileSync(
      join(render, 'apps.yaml'),
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n',
    );
    const kubectl = join(bin, 'kubectl');
    writeFileSync(
      kubectl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_KUBECTL_LOG"
case "$*" in
  *"apply --dry-run=client"*) printf '%s\\n' 'deployment.apps/api' ;;
  *"get deployment.apps/agent-gateway -o jsonpath="*) printf '%s' "$FAKE_GATEWAY_LABEL" ;;
  *"get service/agent-gateway -o jsonpath="*) printf '%s' "$FAKE_GATEWAY_LABEL" ;;
  *"get deployment.apps/agent-gateway --ignore-not-found -o name"*)
    [[ "$FAKE_INSPECTION_ERROR" != 1 ]] || exit 42
    [[ -e "$FAKE_GATEWAY_STATE" ]] || printf '%s\\n' 'deployment.apps/agent-gateway'
    ;;
  *"get service/agent-gateway --ignore-not-found -o name"*)
    [[ -e "$FAKE_GATEWAY_STATE" ]] || printf '%s\\n' 'service/agent-gateway'
    ;;
  *"delete deployment.apps/agent-gateway service/agent-gateway"*)
    : > "$FAKE_GATEWAY_STATE"
    ;;
  *) ;;
esac
`,
    );
    chmodSync(kubectl, 0o700);

    const result = spawnSync(
      'bash',
      [
        join(SCRIPT_DIR, 'deploy-env.sh'),
        'apps',
        '--environment',
        'test',
        '--render-dir',
        render,
        '--kubeconfig',
        join(root, 'kubeconfig'),
        '--no-wait',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          FAKE_GATEWAY_LABEL: managedBy,
          FAKE_INSPECTION_ERROR: inspectionError ? '1' : '0',
          FAKE_KUBECTL_LOG: log,
          FAKE_GATEWAY_STATE: state,
        },
      },
    );
    return { result, log: readFileSync(log, 'utf8') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('schema v1 Test rollback retires only the exact release-v2 Gateway pair', () => {
  const { result, log } = runLegacyTestDeployment('release-v2');
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    log,
    /delete deployment\.apps\/agent-gateway service\/agent-gateway --wait=true --timeout=60s/u,
  );
});

test('schema v1 Test rollback refuses to delete a Gateway with an unknown owner', () => {
  const { result, log } = runLegacyTestDeployment('manual-owner');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing deletion/u);
  assert.doesNotMatch(log, / delete .*agent-gateway/u);
});

test('schema v1 Test rollback fails closed when ownership cannot be inspected', () => {
  const { result, log } = runLegacyTestDeployment('release-v2', { inspectionError: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to inspect deployment\.apps\/agent-gateway/u);
  assert.doesNotMatch(log, / delete .*agent-gateway/u);
});
