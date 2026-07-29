import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const scriptDirectory = fileURLToPath(new URL('./', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const helperPath = join(scriptDirectory, 'retire-legacy-auth-secrets.sh');
const helperSource = readFileSync(helperPath, 'utf8');
const productionArtifactCheck = readFileSync(
  join(scriptDirectory, 'check-production-artifacts.sh'),
  'utf8',
);
const confirmation = '--confirm=RETIRE-LEGACY-AUTH-AFTER-PRODUCTION';
const targets = {
  test: 'combo-preview/combo-dev-env',
  preview: 'combo-review/combo-preview-env',
  production: 'combo/combo-env',
};
const legacyExternalKeys = helperSource
  .match(/^readonly LEGACY_EXTERNAL_KEYS_CSV='([^']+)'$/m)[1]
  .split(',');
const legacyDevKeys = helperSource.match(/^readonly LEGACY_DEV_KEYS_CSV='([^']+)'$/m)[1].split(',');
const legacyKeys = new Set([...legacyExternalKeys, ...legacyDevKeys]);
const expectedLegacyKeys = [
  'LOGTO_ENDPOINT',
  'LOGTO_ISSUER',
  'LOGTO_JWKS_URI',
  'LOGTO_APP_ID',
  'LOGTO_APP_SECRET',
  'LOGTO_AUDIENCE',
  'LOGTO_REDIRECT_URI',
  'LOGTO_ADMIN_ENDPOINT',
  'LOGTO_DB',
  'LOGTO_DB_ALTERATION_TARGET',
  'LOGTO_MANAGEMENT_APP_ID',
  'LOGTO_MANAGEMENT_APP_SECRET',
  'LOGTO_BRANDING_LOGO_URL',
  'LOGTO_BRANDING_DARK_LOGO_URL',
  'LOGTO_BRANDING_FAVICON_URL',
  'LOGTO_BRANDING_DARK_FAVICON_URL',
  'DEV_LOGIN_ENABLED',
  'DEV_SESSION_SECRET',
];

const fakeKubectl = String.raw`#!/usr/bin/env node
const fs = require('node:fs');

const statePath = process.env.FAKE_KUBECTL_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);

function save() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

function done(code, output = '', error = '') {
  save();
  if (output) process.stdout.write(output);
  if (error) process.stderr.write(error);
  process.exit(code);
}

function namespaceFromArgs() {
  const index = args.indexOf('-n');
  if (index < 0 || !args[index + 1]) done(90, '', 'namespace is required\n');
  return args[index + 1];
}

state.operations.push({ args });

if (args[0] === 'auth' && args[1] === 'can-i') {
  const verb = args[2];
  const resource = args[3];
  const namespace = namespaceFromArgs();
  const name = resource.startsWith('secret/') ? resource.slice('secret/'.length) : '';
  const target = namespace + '/' + name;
  const denied = state.deny === verb + ':' + target;
  done(0, denied ? 'no\n' : 'yes\n');
}

let stripped = args;
if (args[0] === '-n') stripped = args.slice(2);
const namespace = namespaceFromArgs();
const command = stripped[0];
const kind = stripped[1];
const name = stripped[2];
const target = namespace + '/' + name;
const secret = state.secrets[target];
if (kind !== 'secret' || !secret) done(91, '', 'unknown target\n');

if (command === 'get') {
  const output = args.find((argument) => argument.startsWith('--output='));
  if (
    !output ||
    !output.includes('.metadata.uid') ||
    !output.includes('.metadata.resourceVersion') ||
    !output.includes('.type') ||
    output.includes('.data') ||
    output.includes('.stringData') ||
    output.includes('jsonpath')
  ) {
    done(92, '', 'metadata-only output is required\n');
  }
  done(0, secret.uid + '\t' + secret.resourceVersion + '\t' + secret.type);
}

if (command === 'patch') {
  const patch = JSON.parse(fs.readFileSync(0, 'utf8'));
  state.patches.push({ target, patch });
  if (state.conflictTarget === target && state.conflictInjected !== true) {
    secret.resourceVersion = String(Number(secret.resourceVersion) + 1);
    state.conflictInjected = true;
    done(1, '', 'Error from server (Invalid): test operation does not apply\n');
  }
  if (
    !Array.isArray(patch) ||
    patch.length !== 4 ||
    patch[0]?.op !== 'test' ||
    patch[0]?.path !== '/metadata/uid' ||
    patch[0]?.value !== secret.uid ||
    patch[1]?.op !== 'test' ||
    patch[1]?.path !== '/metadata/resourceVersion' ||
    patch[1]?.value !== secret.resourceVersion ||
    patch[2]?.op !== 'test' ||
    patch[2]?.path !== '/type' ||
    patch[2]?.value !== secret.type ||
    patch[3]?.op !== 'remove' ||
    !patch[3]?.path?.startsWith('/data/')
  ) {
    done(1, '', 'Error from server (Invalid): test operation does not apply\n');
  }
  const key = patch[3].path.slice('/data/'.length);
  if (!Object.hasOwn(secret.data, key)) {
    const missingPath = state.missingPathOverride || patch[3].path;
    done(
      1,
      '',
      'Error from server (Invalid): jsonpatch remove operation does not apply: ' +
        'doc is missing path: "' + missingPath + '": missing value\n',
    );
  }
  delete secret.data[key];
  secret.resourceVersion = String(Number(secret.resourceVersion) + 1);
  done(0);
}

done(93, '', 'unsupported fake kubectl command\n');
`;

function initialSecrets() {
  return {
    [targets.test]: {
      uid: 'uid-test-1111',
      resourceVersion: '101',
      type: 'Opaque',
      data: {
        LOGTO_ENDPOINT: 'test-external-secret-value',
        DEV_SESSION_SECRET: 'test-dev-secret-value',
        KEEP_TEST: 'test-unrelated-secret-value',
      },
    },
    [targets.preview]: {
      uid: 'uid-preview-2222',
      resourceVersion: '201',
      type: 'Opaque',
      data: {
        LOGTO_MANAGEMENT_APP_SECRET: 'preview-external-secret-value',
        KEEP_PREVIEW: 'preview-unrelated-secret-value',
      },
    },
    [targets.production]: {
      uid: 'uid-production-3333',
      resourceVersion: '301',
      type: 'Opaque',
      data: {
        LOGTO_DB: 'production-external-secret-value',
        DEV_LOGIN_ENABLED: 'production-dev-secret-value',
        KEEP_PRODUCTION: 'production-unrelated-secret-value',
      },
    },
  };
}

function createFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'combo-retire-legacy-auth-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const fakePath = join(bin, 'kubectl');
  writeFileSync(fakePath, fakeKubectl);
  chmodSync(fakePath, 0o755);
  const statePath = join(root, 'state.json');
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        secrets: initialSecrets(),
        operations: [],
        patches: [],
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
  return { root, bin, statePath };
}

function readState(fixture) {
  return JSON.parse(readFileSync(fixture.statePath, 'utf8'));
}

function runHelper(fixture, target = 'all', confirm = confirmation) {
  return spawnSync('bash', [helperPath, confirm, target], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      FAKE_KUBECTL_STATE: fixture.statePath,
    },
    maxBuffer: 1024 * 1024,
  });
}

function assertNoValuesLeaked(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const value of [
    'test-external-secret-value',
    'test-dev-secret-value',
    'test-unrelated-secret-value',
    'preview-external-secret-value',
    'preview-unrelated-secret-value',
    'production-external-secret-value',
    'production-dev-secret-value',
    'production-unrelated-secret-value',
  ]) {
    assert.doesNotMatch(output, new RegExp(value));
  }
}

test('preflights every fixed target before the first mutation', () => {
  const fixture = createFixture({ deny: `patch:${targets.production}` });
  try {
    const before = readState(fixture).secrets;
    const result = runHelper(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing exact Secret patch permission: production/);
    assertNoValuesLeaked(result);
    const after = readState(fixture);
    assert.deepEqual(after.secrets, before);
    assert.equal(after.patches.length, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('removes only the explicit legacy keys with metadata CAS and is idempotent', () => {
  const fixture = createFixture();
  try {
    const initial = readState(fixture);
    const result = runHelper(fixture);
    assert.equal(result.status, 0, result.stderr);
    assertNoValuesLeaked(result);
    assert.equal(result.stdout.trim().split('\n').length, 3);
    assert.match(result.stdout, /environment=test .*changed=true .*legacy_keys_absent=true/);
    assert.match(result.stdout, /environment=preview .*changed=true .*legacy_keys_absent=true/);
    assert.match(result.stdout, /environment=production .*changed=true .*legacy_keys_absent=true/);

    const retired = readState(fixture);
    for (const target of Object.values(targets)) {
      const before = initial.secrets[target];
      const after = retired.secrets[target];
      assert.equal(after.uid, before.uid);
      assert.equal(after.type, 'Opaque');
      assert.notEqual(after.resourceVersion, before.resourceVersion);
      for (const key of Object.keys(after.data)) assert.equal(legacyKeys.has(key), false);
    }
    assert.deepEqual(retired.secrets[targets.test].data, {
      KEEP_TEST: 'test-unrelated-secret-value',
    });
    assert.deepEqual(retired.secrets[targets.preview].data, {
      KEEP_PREVIEW: 'preview-unrelated-secret-value',
    });
    assert.deepEqual(retired.secrets[targets.production].data, {
      KEEP_PRODUCTION: 'production-unrelated-secret-value',
    });

    assert.ok(retired.patches.length > 0);
    for (const { target, patch } of retired.patches) {
      assert.ok(Object.values(targets).includes(target));
      assert.equal(patch.length, 4);
      assert.deepEqual(
        patch.map(({ op, path }) => ({ op, path })),
        [
          { op: 'test', path: '/metadata/uid' },
          { op: 'test', path: '/metadata/resourceVersion' },
          { op: 'test', path: '/type' },
          { op: 'remove', path: patch[3].path },
        ],
      );
      assert.equal(legacyKeys.has(patch[3].path.slice('/data/'.length)), true);
      assert.doesNotMatch(JSON.stringify(patch), /-secret-value/);
    }

    const productionRv = retired.secrets[targets.production].resourceVersion;
    const second = runHelper(fixture, 'production');
    assert.equal(second.status, 0, second.stderr);
    assertNoValuesLeaked(second);
    assert.match(
      second.stdout,
      /environment=production .*changed=false .*resourceVersion_changed=false .*legacy_keys_absent=true/,
    );
    assert.equal(readState(fixture).secrets[targets.production].resourceVersion, productionRv);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('retries a resourceVersion conflict without widening the mutation set', () => {
  const fixture = createFixture({ conflictTarget: targets.test });
  try {
    const result = runHelper(fixture, 'test');
    assert.equal(result.status, 0, result.stderr);
    assertNoValuesLeaked(result);
    const state = readState(fixture);
    assert.equal(state.conflictInjected, true);
    assert.deepEqual(state.secrets[targets.test].data, {
      KEEP_TEST: 'test-unrelated-secret-value',
    });
    assert.ok(
      state.patches.every(({ patch }) => legacyKeys.has(patch[3].path.slice('/data/'.length))),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a missing-path error that does not name the exact requested key', () => {
  const fixture = createFixture({ missingPathOverride: '/data/UNRELATED_KEY' });
  try {
    const before = readState(fixture).secrets[targets.preview];
    const result = runHelper(fixture, 'preview');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /atomic Secret patch failed: preview/);
    assertNoValuesLeaked(result);
    assert.deepEqual(readState(fixture).secrets[targets.preview], before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects missing confirmation before invoking kubectl', () => {
  const fixture = createFixture();
  try {
    const result = runHelper(fixture, 'all', '--confirm=WRONG');
    assert.equal(result.status, 2);
    const state = readState(fixture);
    assert.equal(state.operations.length, 0);
    assert.equal(state.patches.length, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('keeps the production legacy-auth scanner allowlist exact', () => {
  assert.deepEqual([...legacyKeys], expectedLegacyKeys);
  assert.equal(productionArtifactCheck.includes('scripts/retire-legacy-auth-secrets\\\\.sh'), true);
  assert.equal(productionArtifactCheck.includes('readonly LEGACY_EXTERNAL_KEYS_CSV='), true);
  assert.doesNotMatch(helperSource, /kubectl[\s\S]{0,80}\b(delete|create|replace)\b/);
  assert.doesNotMatch(helperSource, /output=.*(?:json|yaml)|jsonpath=.*data/i);
});
