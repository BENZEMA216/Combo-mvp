import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readReleaseManifest,
  releaseIdForSource,
  releaseManifestDigest,
  serializeReleaseManifest,
  validateReleaseManifest,
} from './release-manifest.mjs';
import {
  createWebAssetManifest,
  readWebAssetManifest,
  serializeWebAssetManifest,
  validateWebAssetManifest,
  webAssetManifestDigest,
} from './web-asset-manifest.mjs';

const SHA = 'a'.repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceSha: SHA,
    releaseId: releaseIdForSource(SHA),
    images: {
      api: `ghcr.io/dangdang-tech/combo-api@${digest('1')}`,
      runtime: `ghcr.io/dangdang-tech/combo-runtime@${digest('2')}`,
      web: `ghcr.io/dangdang-tech/combo-web@${digest('3')}`,
    },
    migrationHead: '0006_one_running_turn_per_session.sql',
    builtAt: '2026-07-24T08:00:00.000Z',
    webAssetManifest: digest('4'),
    ...overrides,
  };
}

test('release manifest canonicalizes every required immutable field', () => {
  const value = validateReleaseManifest(manifest());
  const serialized = serializeReleaseManifest(value);

  assert.deepEqual(JSON.parse(serialized), value);
  assert.match(releaseManifestDigest(value), /^sha256:[0-9a-f]{64}$/);
  assert.equal(serialized, serializeReleaseManifest(JSON.parse(serialized)));
});

test('release manifest rejects tags, foreign repositories, and mismatched identity', () => {
  assert.throws(
    () =>
      validateReleaseManifest(
        manifest({
          images: {
            ...manifest().images,
            api: 'ghcr.io/dangdang-tech/combo-api:latest',
          },
        }),
      ),
    /combo-api@sha256/,
  );
  assert.throws(
    () =>
      validateReleaseManifest(
        manifest({
          images: {
            ...manifest().images,
            web: `ghcr.io/example/combo-web@${digest('3')}`,
          },
        }),
      ),
    /combo-web@sha256/,
  );
  assert.throws(
    () => validateReleaseManifest(manifest({ releaseId: 'release-another' })),
    /deterministic/,
  );
  assert.throws(
    () => validateReleaseManifest({ ...manifest(), unexpected: 'value' }),
    /keys must be exactly/,
  );
});

test('release manifest rejects impossible dates', () => {
  assert.throws(
    () => validateReleaseManifest(manifest({ builtAt: '2026-02-31T08:00:00.000Z' })),
    /real canonical timestamp/,
  );
});

test('release manifest reader rejects noncanonical bytes and symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'combo-release-manifest-'));
  const canonical = join(root, 'release.json');
  const noncanonical = join(root, 'noncanonical.json');
  const linked = join(root, 'linked.json');
  writeFileSync(canonical, serializeReleaseManifest(manifest()));
  writeFileSync(noncanonical, JSON.stringify(manifest()));
  symlinkSync(canonical, linked);

  assert.deepEqual(readReleaseManifest(canonical), manifest());
  assert.throws(() => readReleaseManifest(noncanonical), /not in canonical form/);
  assert.throws(() => readReleaseManifest(linked), /regular file/);
});

test('web asset manifest is deterministic and changes with asset contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'combo-web-assets-'));
  const web = join(root, 'web');
  const runtime = join(root, 'runtime');
  const output = join(web, 'web-asset-manifest.json');
  mkdirSync(join(web, 'assets'), { recursive: true });
  mkdirSync(join(runtime, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<script src="/assets/app-123.js"></script>');
  writeFileSync(join(web, 'assets/app-123.js'), 'console.log("web");');
  writeFileSync(join(runtime, 'index.html'), '<script src="/try/assets/app-456.js"></script>');
  writeFileSync(join(runtime, 'assets/app-456.js'), 'console.log("runtime");');

  const first = createWebAssetManifest({ webRoot: web, runtimeRoot: runtime, output });
  writeFileSync(output, serializeWebAssetManifest(first));
  const repeated = createWebAssetManifest({ webRoot: web, runtimeRoot: runtime, output });
  assert.deepEqual(repeated, first);
  assert.equal(readFileSync(output, 'utf8'), serializeWebAssetManifest(first));
  assert.deepEqual(readWebAssetManifest(output), first);

  const firstDigest = webAssetManifestDigest(first);
  writeFileSync(join(runtime, 'assets/app-456.js'), 'console.log("changed");');
  const changed = createWebAssetManifest({ webRoot: web, runtimeRoot: runtime, output });
  assert.notEqual(webAssetManifestDigest(changed), firstDigest);
  assert.equal(
    changed.assets.some((asset) => asset.application === 'runtime-web'),
    true,
  );
});

test('web asset manifest rejects missing applications, duplicates, and unsafe paths', () => {
  const webIndex = {
    application: 'web',
    path: 'index.html',
    digest: digest('1'),
  };
  const runtimeIndex = {
    application: 'runtime-web',
    path: 'index.html',
    digest: digest('2'),
  };
  assert.throws(
    () => validateWebAssetManifest({ schemaVersion: 1, assets: [webIndex] }),
    /runtime-web\/index.html is missing/,
  );
  assert.throws(
    () =>
      validateWebAssetManifest({
        schemaVersion: 1,
        assets: [runtimeIndex, webIndex, webIndex],
      }),
    /duplicate asset|canonical sorted order/,
  );
  assert.throws(
    () =>
      validateWebAssetManifest({
        schemaVersion: 1,
        assets: [runtimeIndex, { ...webIndex, path: '../index.html' }],
      }),
    /normalized relative path/,
  );
});

test('release and Web asset digest vectors are stable', () => {
  assert.equal(
    releaseManifestDigest(manifest()),
    'sha256:cbf6d69442156e09e9a45c3dbfdb87e3603cfe20a859b2fc5932c21455f3cbdd',
  );
  const assets = validateWebAssetManifest({
    schemaVersion: 1,
    assets: [
      { application: 'runtime-web', path: 'index.html', digest: digest('1') },
      { application: 'web', path: 'index.html', digest: digest('2') },
    ],
  });
  assert.equal(
    webAssetManifestDigest(assets),
    'sha256:e333683cf52803331fa3acd7b625954a695d62559fe7fd6d6232bb3e7b70917d',
  );
});
