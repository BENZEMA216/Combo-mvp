#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const PREVIEW_ORIGIN = 'https://review.43-160-242-46.sslip.io';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

export function validatePreviewIdentity(value, expectedSha) {
  if (!SHA_PATTERN.test(expectedSha)) fail('expected SHA must be a complete lowercase commit SHA');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Preview version.json must be a JSON object');
  }
  if (value.schemaVersion !== 1) fail('Preview version.json schemaVersion must be 1');
  if (value.environment !== 'preview') fail('deployed environment is not preview');
  if (value.sourceSha !== expectedSha) {
    fail(`Preview sourceSha is ${String(value.sourceSha)}, expected ${expectedSha}`);
  }
  if (value.releaseId !== `release-${expectedSha}`) {
    fail('Preview releaseId does not match the expected immutable source SHA');
  }
  if (!DIGEST_PATTERN.test(value.releaseManifestDigest)) {
    fail('Preview release manifest digest is missing or invalid');
  }
  if (!DIGEST_PATTERN.test(value.webAssetManifest)) {
    fail('Preview web asset manifest digest is missing or invalid');
  }
  if (typeof value.builtAt !== 'string' || Number.isNaN(Date.parse(value.builtAt))) {
    fail('Preview builtAt is missing or invalid');
  }
  return {
    environment: value.environment,
    sourceSha: value.sourceSha,
    releaseId: value.releaseId,
    builtAt: value.builtAt,
    releaseManifestDigest: value.releaseManifestDigest,
    webAssetManifest: value.webAssetManifest,
  };
}

export async function verifyPreviewRelease(expectedSha, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${PREVIEW_ORIGIN}/version.json`, {
    cache: 'no-store',
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) fail(`Preview version.json returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    fail(`Preview version.json returned unexpected content type: ${contentType || 'missing'}`);
  }
  return validatePreviewIdentity(await response.json(), expectedSha);
}

function expectedShaFrom(argv) {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  const index = normalized.indexOf('--expected-sha');
  if (index === -1 || !normalized[index + 1] || normalized[index + 1].startsWith('--')) {
    fail('usage: verify-preview-release.mjs --expected-sha <40-character-main-sha>');
  }
  if (normalized.length !== 2) fail('only --expected-sha is accepted');
  return normalized[index + 1];
}

export async function main(argv = process.argv.slice(2)) {
  const expectedSha = expectedShaFrom(argv);
  const identity = await verifyPreviewRelease(expectedSha);
  process.stdout.write(`${JSON.stringify({ ok: true, ...identity }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Preview verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
