import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(repo, 'infra', 'k8s', 'v2');
const renderScript = join(repo, 'scripts', 'render-v2.mjs');

test('every V2 namespaced resource is explicitly pinned to combo-v2', () => {
  for (const file of readdirSync(sourceDirectory).filter((name) => name.endsWith('.yaml'))) {
    const source = readFileSync(join(sourceDirectory, file), 'utf8');
    for (const document of parseAllDocuments(source)) {
      const value = document.toJSON();
      if (!value) continue;
      if (value.kind === 'Namespace') {
        assert.equal(value.metadata?.name, 'combo-v2', file);
      } else {
        assert.equal(value.metadata?.namespace, 'combo-v2', `${file}:${value.kind}`);
      }
    }
  }
  assert.doesNotMatch(
    readFileSync(join(sourceDirectory, 'authz.yaml'), 'utf8'),
    /AUTHZ_DEV_OTP_CODE/,
  );
});

test('every V2 PostgreSQL client is pinned to the isolated combo_v2 database', () => {
  for (const file of ['authz.yaml', 'billing.yaml', 'job-migrate.yaml']) {
    const resources = parseAllDocuments(readFileSync(join(sourceDirectory, file), 'utf8'))
      .map((document) => document.toJSON())
      .filter(Boolean);
    const podSpec =
      resources[0]?.spec?.template?.spec ??
      resources.find((resource) => resource.spec?.template)?.spec?.template?.spec;
    const database = podSpec?.containers?.[0]?.env?.find((entry) => entry.name === 'PGDATABASE');
    assert.deepEqual(database, { name: 'PGDATABASE', value: 'combo_v2' }, file);
  }
});

test('V2 rendering resolves every digest and rejects a reused output directory', () => {
  const output = mkdtempSync(join(tmpdir(), 'combo-v2-render-'));
  try {
    execFileSync(
      process.execPath,
      [
        renderScript,
        '--platform',
        `sha256:${'a'.repeat(64)}`,
        '--restart-life',
        `sha256:${'b'.repeat(64)}`,
        '--out',
        output,
      ],
      { cwd: repo, stdio: 'pipe' },
    );
    const files = readdirSync(output).filter((name) => name.endsWith('.yaml'));
    assert.deepEqual(
      files,
      readdirSync(sourceDirectory).filter((name) => name.endsWith('.yaml')),
    );
    for (const file of files) {
      assert.doesNotMatch(readFileSync(join(output, file), 'utf8'), /COMBO_V2_[A-Z_]+_DIGEST/);
    }

    writeFileSync(join(output, 'stale.yaml'), 'stale\n');
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            renderScript,
            '--platform',
            `sha256:${'a'.repeat(64)}`,
            '--restart-life',
            `sha256:${'b'.repeat(64)}`,
            '--out',
            output,
          ],
          { cwd: repo, stdio: 'pipe' },
        ),
      /Command failed/,
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
