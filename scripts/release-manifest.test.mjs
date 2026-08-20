import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  readReleaseManifest,
  releaseManifestDigest,
  serializeReleaseManifest,
  validateReleaseManifest,
} from './release-manifest.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function fixtureManifest(schemaVersion = 2) {
  const images = {
    api: `ghcr.io/dangdang-tech/combo-api@sha256:${'1'.repeat(64)}`,
    runtime: `ghcr.io/dangdang-tech/combo-runtime@sha256:${'2'.repeat(64)}`,
    web: `ghcr.io/dangdang-tech/combo-web@sha256:${'3'.repeat(64)}`,
  };
  if (schemaVersion === 2) {
    images.agentGateway = `ghcr.io/dangdang-tech/combo-agent-gateway@sha256:${'5'.repeat(64)}`;
  }
  return {
    schemaVersion,
    sourceSha: 'a'.repeat(40),
    releaseId: `release-${'a'.repeat(40)}`,
    images,
    migrationHead: '0009_billing.sql',
    builtAt: '2026-01-01T00:00:00.000Z',
    webAssetManifest: `sha256:${'4'.repeat(64)}`,
  };
}

test('keeps canonical schema v1 manifests valid without an Agent Gateway image', () => {
  const legacy = fixtureManifest(1);
  const normalized = validateReleaseManifest(legacy);
  assert.equal(normalized.schemaVersion, 1);
  assert.deepEqual(Object.keys(normalized.images), ['api', 'runtime', 'web']);
  assert.equal(
    releaseManifestDigest(normalized),
    'sha256:11aed47758f6a2ee63d223265f372d7a2a3622a784e1320b4a09a85876f1947d',
  );
  assert.equal(serializeReleaseManifest(normalized), serializeReleaseManifest(legacy));
});

test('schema v2 binds the independent Agent Gateway image and rejects mixed schemas', () => {
  const current = fixtureManifest(2);
  const normalized = validateReleaseManifest(current);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.images.agentGateway, current.images.agentGateway);

  const missingGateway = structuredClone(current);
  delete missingGateway.images.agentGateway;
  assert.throws(() => validateReleaseManifest(missingGateway), /images keys must be exactly/u);

  const gatewayInLegacy = fixtureManifest(1);
  gatewayInLegacy.images.agentGateway = current.images.agentGateway;
  assert.throws(() => validateReleaseManifest(gatewayInLegacy), /images keys must be exactly/u);
});

test('create emits schema v2 and requires the fourth immutable image', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-manifest-test-'));
  try {
    const output = join(directory, 'release.json');
    const args = [
      join(SCRIPT_DIR, 'release-manifest.mjs'),
      'create',
      '--output',
      output,
      '--source-sha',
      'a'.repeat(40),
      '--api-image',
      `ghcr.io/dangdang-tech/combo-api@sha256:${'1'.repeat(64)}`,
      '--agent-gateway-image',
      `ghcr.io/dangdang-tech/combo-agent-gateway@sha256:${'5'.repeat(64)}`,
      '--runtime-image',
      `ghcr.io/dangdang-tech/combo-runtime@sha256:${'2'.repeat(64)}`,
      '--web-image',
      `ghcr.io/dangdang-tech/combo-web@sha256:${'3'.repeat(64)}`,
      '--migration-head',
      '0009_billing.sql',
      '--built-at',
      '2026-01-01T00:00:00.000Z',
      '--web-asset-manifest',
      `sha256:${'4'.repeat(64)}`,
    ];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readReleaseManifest(output).schemaVersion, 2);
    assert.match(readFileSync(output, 'utf8'), /"agentGateway":/u);

    const missingOutput = join(directory, 'missing.json');
    const withoutGateway = args.filter(
      (value, index) =>
        value !== '--agent-gateway-image' && args[index - 1] !== '--agent-gateway-image',
    );
    withoutGateway[withoutGateway.indexOf(output)] = missingOutput;
    const missing = spawnSync(process.execPath, withoutGateway, { encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Missing --agent-gateway-image/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
