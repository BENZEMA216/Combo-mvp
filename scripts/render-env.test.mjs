import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releaseManifestDigest, serializeReleaseManifest } from './release-manifest.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function fixtureManifest() {
  return {
    schemaVersion: 1,
    sourceSha: 'a'.repeat(40),
    releaseId: 'release-' + 'a'.repeat(40),
    images: {
      api: 'ghcr.io/dangdang-tech/combo-api@sha256:' + '1'.repeat(64),
      runtime: 'ghcr.io/dangdang-tech/combo-runtime@sha256:' + '2'.repeat(64),
      web: 'ghcr.io/dangdang-tech/combo-web@sha256:' + '3'.repeat(64),
    },
    migrationHead: '0009_billing.sql',
    builtAt: '2026-01-01T00:00:00.000Z',
    webAssetManifest: 'sha256:' + '4'.repeat(64),
  };
}

function render(environment, phase, manifestPath, digest) {
  const output = join(mkdtempSync(join(tmpdir(), 'render-env-test-')), `${phase}.yaml`);
  const args = [
    join(SCRIPT_DIR, 'render-env.mjs'),
    '--environment',
    environment,
    '--phase',
    phase,
    '--output',
    output,
  ];
  if (phase !== 'foundation') {
    args.push('--manifest', manifestPath, '--manifest-digest', digest);
  }
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const content = readFileSync(output, 'utf8');
  rmSync(dirname(output), { recursive: true, force: true });
  return content;
}

test('renders apps for all three environments into their namespaces', () => {
  const manifest = fixtureManifest();
  const path = join(mkdtempSync(join(tmpdir(), 'render-env-manifest-')), 'release.json');
  writeFileSync(path, serializeReleaseManifest(manifest));
  const digest = releaseManifestDigest(manifest);
  const cases = [
    ['test', 'combo-test', 'https://test.43-160-242-46.sslip.io', 'redis://redis-queue:6379/0'],
    [
      'preview',
      'combo-preview',
      'https://review.43-160-242-46.sslip.io',
      'redis://redis-queue.combo-foundation.svc.cluster.local:6379/0',
    ],
    [
      'production',
      'combo-prod',
      'https://agora.43-160-242-46.sslip.io,https://buildwithcombo.com,https://www.buildwithcombo.com',
      'redis://redis-queue.combo-foundation.svc.cluster.local:6379/0',
    ],
  ];
  for (const [environment, namespace, origin, redisQueue] of cases) {
    const apps = render(environment, 'apps', path, digest);
    assert.match(apps, new RegExp(`namespace: ${namespace}`));
    assert.match(apps, new RegExp(`name: combo-release`));
    assert.match(apps, new RegExp(`COMBO_ENVIRONMENT: ${environment}`));
    assert.ok(apps.includes(origin), `${environment} public origin`);
    assert.ok(apps.includes(redisQueue), `${environment} redis queue host`);
    assert.ok(apps.includes(`ghcr.io/dangdang-tech/combo-api@sha256:${'1'.repeat(64)}`));
    const migrate = render(environment, 'migrate', path, digest);
    assert.match(migrate, new RegExp(`namespace: ${namespace}`));
    assert.match(migrate, /kind: Job/);
    assert.match(migrate, /name: migrate/);
  }
  rmSync(dirname(path), { recursive: true, force: true });
});

test('renders the two foundation sets into their namespaces', () => {
  const foundation = render('test', 'foundation', '', '');
  assert.match(foundation, /namespace: combo-test/);
  assert.match(foundation, /kind: StatefulSet/);
  assert.match(foundation, /name: postgres/);
  assert.doesNotMatch(foundation, /nodePort/);
  const shared = render('production', 'foundation', '', '');
  assert.match(shared, /namespace: combo-foundation/);
  assert.match(shared, /kind: StatefulSet/);
  assert.match(shared, /name: minio/);
});
