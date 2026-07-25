import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'a970c93ba8628734a63d96be0b5ca87d716f8038';
const frozen = '3fc5690f2dbd298d38e6b49a22861b7e1607e863';
const auditPath = join(repo, 'docs/goal-b-frozen-preview-audit.md');

function frozenPaths() {
  return execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', base, frozen], {
    cwd: repo,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
}

function auditRows() {
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => {
      const fields = line
        .split('|')
        .slice(1, -1)
        .map((field) => field.trim());
      assert.equal(fields.length, 5, `审计行必须有 5 列：${line}`);
      return {
        path: fields[0].replace(/^`|`$/g, ''),
        merge: fields[1],
        area: fields[2],
        disposition: fields[3],
        verification: fields[4],
      };
    });
}

test('frozen Preview audit covers every one of the 256 paths exactly once', () => {
  assert.match(readFileSync(auditPath, 'utf8'), new RegExp(frozen));
  const expected = frozenPaths();
  const rows = auditRows();
  assert.equal(expected.length, 256);
  assert.equal(rows.length, 256);
  assert.equal(new Set(rows.map((row) => row.path)).size, 256);
  assert.deepEqual(rows.map((row) => row.path).sort(), expected);
  assert.deepEqual(
    Object.fromEntries(
      ['冲突', '自动新增', '自动合并'].map((status) => [
        status,
        rows.filter((row) => row.merge === status).length,
      ]),
    ),
    { 冲突: 173, 自动新增: 66, 自动合并: 17 },
  );
  for (const row of rows) {
    assert.match(row.merge, /^(冲突|自动新增|自动合并)$/);
    assert.match(row.disposition, /^(保留 main|main 等价替代|迁移行为|明确废弃)$/);
    assert.notEqual(row.area, '');
    assert.notEqual(row.verification, '');
  }
});

test('audit rejects the frozen migrations and Cloud Review topology', () => {
  const rows = auditRows();
  const forbidden = rows.filter((row) =>
    /(?:^\.github\/workflows\/cloud-review\.yml$|^db\/migrations\/001[78]_|cloud-review|deploy-cloud-review|recover-cloud-review|release-cloud-review-nodeports)/.test(
      row.path,
    ),
  );
  assert.ok(forbidden.length > 0);
  assert.ok(forbidden.every((row) => row.disposition === '明确废弃'));
  for (const path of [
    '.github/workflows/cloud-review.yml',
    'db/migrations/0017_backfill_creator_profiles_for_publishers.sql',
    'db/migrations/0018_studio_revisions_and_tests.sql',
    'infra/k8s/overlays/cloud-review',
  ]) {
    assert.equal(existsSync(join(repo, path)), false, `${path} 不得存在`);
  }
  assert.equal(existsSync(join(repo, 'tools/combo-import')), false);
});

test('Goal B keeps the migration source exactly at 0000 through 0006', () => {
  expectMigrationFiles([
    '0000_baseline_schema.sql',
    '0001_expired_upload_reconciliation.sql',
    '0002_drop_stream_events.sql',
    '0003_turns.sql',
    '0004_studio_sessions.sql',
    '0005_capability_current_ui.sql',
    '0006_one_running_turn_per_session.sql',
  ]);
});

test('audit records an explicit conclusion for all six Goal B product areas', () => {
  const source = readFileSync(auditPath, 'utf8');
  for (const area of [
    'Creation Journey',
    'Studio 与可视化编辑',
    'Authoring',
    'Runtime 与数据模型',
    'Preview UI 与访问闸',
    'Cloud Review 与发布架构',
  ]) {
    assert.ok(source.includes(`- ${area}`), `${area} 缺少结论`);
  }
});

function expectMigrationFiles(expected) {
  assert.deepEqual(
    readdirSync(join(repo, 'db/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort(),
    expected,
  );
}
