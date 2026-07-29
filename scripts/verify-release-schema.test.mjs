import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import {
  buildCatalogQuery,
  buildPassedEvidence,
  SCHEMA_CONTRACT,
} from './verify-release-schema.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./verify-release-schema.mjs', import.meta.url));
const SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';
const MIGRATION_HEAD = '0008_application_database_roles.sql';

function fixtureDirectory(response = SCHEMA_CONTRACT) {
  const directory = mkdtempSync(join(tmpdir(), 'combo-schema-proof-'));
  const binDirectory = join(directory, 'bin');
  const responsePath = join(directory, 'response.json');
  const sqlPath = join(directory, 'query.sql');
  const argsPath = join(directory, 'args.txt');
  const outputPath = join(directory, 'evidence.json');
  spawnSync('mkdir', ['-m', '0700', binDirectory]);
  writeFileSync(responsePath, JSON.stringify(response), { mode: 0o600 });
  const kubectlPath = join(binDirectory, 'kubectl');
  writeFileSync(
    kubectlPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >"$MOCK_ARGS_PATH"
cat >"$MOCK_SQL_PATH"
cat "$MOCK_RESPONSE_PATH"
printf '\\n'
`,
    { mode: 0o700 },
  );
  chmodSync(kubectlPath, 0o700);
  return { directory, binDirectory, responsePath, sqlPath, argsPath, outputPath };
}

function runVerifier(fixture, extraArguments = [], extraEnvironment = {}) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      '--environment',
      'preview',
      '--namespace',
      'combo-review',
      '--source-sha',
      SOURCE_SHA,
      '--migration-head',
      MIGRATION_HEAD,
      '--output',
      fixture.outputPath,
      ...extraArguments,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.binDirectory}:${process.env.PATH}`,
        MOCK_ARGS_PATH: fixture.argsPath,
        MOCK_SQL_PATH: fixture.sqlPath,
        MOCK_RESPONSE_PATH: fixture.responsePath,
        ...extraEnvironment,
      },
    },
  );
}

test('catalog query is read-only and only uses catalog or ledger metadata', () => {
  const query = buildCatalogQuery();
  assert.match(query, /BEGIN READ ONLY;/);
  assert.match(query, /information_schema\.columns/);
  assert.match(query, /pg_catalog\.pg_constraint/);
  assert.match(query, /pg_catalog\.aclexplode/);
  assert.match(query, /public\.schema_migrations/);
  assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/u);
});

test('writes an exact-key, mode 0600, digest-matched passed proof', () => {
  const fixture = fixtureDirectory();
  const result = runVerifier(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^sha256:[0-9a-f]{64}\n$/);
  assert.equal(result.stderr, '');

  const evidence = JSON.parse(readFileSync(fixture.outputPath, 'utf8'));
  assert.deepEqual(Object.keys(evidence), [
    'schemaVersion',
    'status',
    'contractVersion',
    'environment',
    'namespace',
    'sourceSha',
    'migrationHead',
    'contractDigest',
    'actualDigest',
    'verified',
    'counts',
    'verifiedAt',
  ]);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.contractVersion, 'combo-schema-0008-v1');
  assert.equal(evidence.environment, 'preview');
  assert.equal(evidence.namespace, 'combo-review');
  assert.equal(evidence.sourceSha, SOURCE_SHA);
  assert.equal(evidence.migrationHead, MIGRATION_HEAD);
  assert.equal(evidence.contractDigest, evidence.actualDigest);
  assert.equal(evidence.verified, true);
  assert.deepEqual(Object.keys(evidence.counts), [
    'relations',
    'columns',
    'constraints',
    'indexes',
    'functions',
    'roles',
    'grants',
  ]);
  assert.match(evidence.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(statSync(fixture.outputPath).mode & 0o777, 0o600);

  const args = readFileSync(fixture.argsPath, 'utf8');
  assert.match(args, /--namespace combo-review exec -i pod\/release-postgres-0/);
  assert.match(args, /--container postgres/);
  assert.match(args, /PGPASSWORD="\$POSTGRES_PASSWORD"/);
  assert.doesNotMatch(args, /0123456789abcdef/);
  const sql = readFileSync(fixture.sqlPath, 'utf8');
  assert.match(sql, /BEGIN READ ONLY;/);
});

test('contract mismatch fails closed without writing evidence', () => {
  const response = structuredClone(SCHEMA_CONTRACT);
  response.columns = response.columns.filter(
    (fact) => fact !== 'artifacts|turn_id|pg_catalog.uuid|nullable',
  );
  const fixture = fixtureDirectory(response);
  const result = runVerifier(fixture);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'schema_verification_failed\n');
  assert.throws(() => statSync(fixture.outputPath), /ENOENT/);
});

test('namespace mismatch fails before kubectl is invoked', () => {
  const fixture = fixtureDirectory();
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      '--environment',
      'production',
      '--namespace',
      'combo-review',
      '--source-sha',
      SOURCE_SHA,
      '--migration-head',
      MIGRATION_HEAD,
      '--output',
      fixture.outputPath,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.binDirectory}:${process.env.PATH}`,
        MOCK_ARGS_PATH: fixture.argsPath,
        MOCK_SQL_PATH: fixture.sqlPath,
        MOCK_RESPONSE_PATH: fixture.responsePath,
      },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'schema_verification_failed\n');
  assert.throws(() => statSync(fixture.argsPath), /ENOENT/);
});

test('kubectl diagnostics and credentials are never forwarded', () => {
  const fixture = fixtureDirectory();
  const kubectlPath = join(fixture.binDirectory, 'kubectl');
  writeFileSync(
    kubectlPath,
    '#!/bin/sh\ncat >/dev/null\nprintf "%s\\n" "sensitive-token-value" >&2\nexit 2\n',
    { mode: 0o700 },
  );
  const result = runVerifier(fixture);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'schema_verification_failed\n');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /sensitive-token-value/);
});

test('refuses a symlink evidence target', () => {
  const fixture = fixtureDirectory();
  const target = join(fixture.directory, 'other.json');
  writeFileSync(target, '{}\n', { mode: 0o600 });
  symlinkSync(target, fixture.outputPath);
  const result = runVerifier(fixture);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'schema_verification_failed\n');
  assert.equal(readFileSync(target, 'utf8'), '{}\n');
});

test('buildPassedEvidence locks the public evidence schema', () => {
  const evidence = buildPassedEvidence(
    {
      environment: 'production',
      namespace: 'combo',
      sourceSha: SOURCE_SHA,
      migrationHead: MIGRATION_HEAD,
    },
    SCHEMA_CONTRACT,
    '2026-07-29T00:00:00.000Z',
  );
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    status: 'passed',
    contractVersion: 'combo-schema-0008-v1',
    environment: 'production',
    namespace: 'combo',
    sourceSha: SOURCE_SHA,
    migrationHead: MIGRATION_HEAD,
    contractDigest: evidence.contractDigest,
    actualDigest: evidence.contractDigest,
    verified: true,
    counts: {
      relations: SCHEMA_CONTRACT.relations.length,
      columns: SCHEMA_CONTRACT.columns.length,
      constraints: SCHEMA_CONTRACT.constraints.length,
      indexes: SCHEMA_CONTRACT.indexes.length,
      functions: SCHEMA_CONTRACT.functions.length,
      roles: SCHEMA_CONTRACT.roles.length,
      grants: SCHEMA_CONTRACT.grants.length,
    },
    verifiedAt: '2026-07-29T00:00:00.000Z',
  });
});
