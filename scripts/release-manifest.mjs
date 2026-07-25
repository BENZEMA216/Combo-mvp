#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MIGRATION_HEAD_PATTERN = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;

const IMAGE_REPOSITORIES = Object.freeze({
  api: 'ghcr.io/dangdang-tech/combo-api',
  runtime: 'ghcr.io/dangdang-tech/combo-runtime',
  web: 'ghcr.io/dangdang-tech/combo-web',
});

function fail(message) {
  throw new Error(`Invalid release manifest: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly: ${wanted.join(', ')}`);
  }
}

function validateTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) {
    fail('builtAt must be an ISO-8601 UTC timestamp');
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail('builtAt is not a real timestamp');
}

function validateImage(name, value) {
  const repository = IMAGE_REPOSITORIES[name];
  if (typeof value !== 'string' || !value.startsWith(`${repository}@`)) {
    fail(`images.${name} must use ${repository}@sha256:digest`);
  }
  const digest = value.slice(repository.length + 1);
  if (!DIGEST_PATTERN.test(digest)) {
    fail(`images.${name} must contain a lowercase sha256 digest`);
  }
}

export function validateReleaseManifest(value) {
  if (!isRecord(value)) fail('root must be an object');
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'sourceSha',
      'releaseId',
      'images',
      'migrationHead',
      'builtAt',
      'webAssetManifest',
    ],
    'root',
  );

  if (value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${RELEASE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (typeof value.sourceSha !== 'string' || !SOURCE_SHA_PATTERN.test(value.sourceSha)) {
    fail('sourceSha must be a complete lowercase commit SHA');
  }
  if (typeof value.releaseId !== 'string' || !RELEASE_ID_PATTERN.test(value.releaseId)) {
    fail('releaseId must use lowercase letters, digits, dot, underscore, or dash');
  }
  if (!value.releaseId.includes(value.sourceSha)) {
    fail('releaseId must contain sourceSha');
  }
  if (!isRecord(value.images)) fail('images must be an object');
  assertExactKeys(value.images, Object.keys(IMAGE_REPOSITORIES), 'images');
  for (const name of Object.keys(IMAGE_REPOSITORIES)) validateImage(name, value.images[name]);
  if (
    typeof value.migrationHead !== 'string' ||
    !MIGRATION_HEAD_PATTERN.test(value.migrationHead)
  ) {
    fail('migrationHead must be a migration filename');
  }
  validateTimestamp(value.builtAt);
  if (
    typeof value.webAssetManifest !== 'string' ||
    !DIGEST_PATTERN.test(value.webAssetManifest)
  ) {
    fail('webAssetManifest must be a lowercase sha256 digest');
  }

  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    sourceSha: value.sourceSha,
    releaseId: value.releaseId,
    images: {
      api: value.images.api,
      runtime: value.images.runtime,
      web: value.images.web,
    },
    migrationHead: value.migrationHead,
    builtAt: value.builtAt,
    webAssetManifest: value.webAssetManifest,
  };
}

export function serializeReleaseManifest(value) {
  return `${JSON.stringify(validateReleaseManifest(value), null, 2)}\n`;
}

export function releaseManifestDigest(value) {
  return `sha256:${createHash('sha256').update(serializeReleaseManifest(value)).digest('hex')}`;
}

export function readReleaseManifest(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('manifest path must be a regular file');
  if (stat.size > 64 * 1024) fail('manifest exceeds 64 KiB');

  const source = readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('manifest is not valid JSON');
  }
  const manifest = validateReleaseManifest(parsed);
  if (source !== serializeReleaseManifest(manifest)) {
    fail('manifest JSON is not in canonical form');
  }
  return manifest;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value, received: ${argv.slice(index).join(' ')}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function createFromOptions(options) {
  return validateReleaseManifest({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    sourceSha: required(options, 'source-sha'),
    releaseId: required(options, 'release-id'),
    images: {
      api: required(options, 'api-image'),
      runtime: required(options, 'runtime-image'),
      web: required(options, 'web-image'),
    },
    migrationHead: required(options, 'migration-head'),
    builtAt: required(options, 'built-at'),
    webAssetManifest: required(options, 'web-asset-manifest'),
  });
}

function run(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (command === 'create') {
    const output = required(options, 'output');
    const manifest = createFromOptions(options);
    writeFileSync(output, serializeReleaseManifest(manifest), { mode: 0o644 });
    process.stdout.write(`${releaseManifestDigest(manifest)}\n`);
    return;
  }
  if (command === 'verify') {
    const manifest = readReleaseManifest(required(options, 'manifest'));
    if (options['source-sha'] && manifest.sourceSha !== options['source-sha']) {
      fail('sourceSha does not match the expected revision');
    }
    if (options['release-id'] && manifest.releaseId !== options['release-id']) {
      fail('releaseId does not match the expected release');
    }
    process.stdout.write(`${releaseManifestDigest(manifest)}\n`);
    return;
  }
  throw new Error('Usage: release-manifest.mjs <create|verify> --name value ...');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
