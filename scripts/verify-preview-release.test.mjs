import assert from 'node:assert/strict';
import test from 'node:test';
import { main, validatePreviewIdentity, verifyPreviewRelease } from './verify-preview-release.mjs';

const SHA = 'a'.repeat(40);

function identity(overrides = {}) {
  return {
    schemaVersion: 1,
    environment: 'preview',
    sourceSha: SHA,
    releaseId: `release-${SHA}`,
    builtAt: '2026-08-04T06:00:36.000Z',
    releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
    webAssetManifest: `sha256:${'c'.repeat(64)}`,
    ...overrides,
  };
}

test('accepts an exact immutable Preview identity', () => {
  assert.deepEqual(validatePreviewIdentity(identity(), SHA), {
    environment: 'preview',
    sourceSha: SHA,
    releaseId: `release-${SHA}`,
    builtAt: '2026-08-04T06:00:36.000Z',
    releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
    webAssetManifest: `sha256:${'c'.repeat(64)}`,
  });
});

test('rejects a deployment that does not run the expected main SHA', () => {
  assert.throws(
    () => validatePreviewIdentity(identity({ sourceSha: 'd'.repeat(40) }), SHA),
    /expected/,
  );
});

test('rejects a non-Preview environment and incomplete release evidence', () => {
  assert.throws(
    () => validatePreviewIdentity(identity({ environment: 'production' }), SHA),
    /not preview/,
  );
  assert.throws(
    () => validatePreviewIdentity(identity({ webAssetManifest: undefined }), SHA),
    /web asset manifest/,
  );
});

test('fetches only the fixed Preview version endpoint without cache', async () => {
  let request;
  const result = await verifyPreviewRelease(SHA, async (...args) => {
    request = args;
    return new globalThis.Response(JSON.stringify(identity()), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  assert.equal(request[0], 'https://review.43-160-242-46.sslip.io/version.json');
  assert.equal(request[1].cache, 'no-store');
  assert.equal(request[1].redirect, 'error');
  assert.equal(result.sourceSha, SHA);
});

test('package-script separator is accepted by the CLI', async () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  let output = '';
  globalThis.fetch = async () =>
    new globalThis.Response(JSON.stringify(identity()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };

  try {
    await main(['--', '--expected-sha', SHA]);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }

  assert.equal(JSON.parse(output).sourceSha, SHA);
});
