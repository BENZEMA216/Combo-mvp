import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { URL } from 'node:url';

const protocolRequire = createRequire(
  new URL('../packages/creator-agent-protocol/package.json', import.meta.url),
);
const YAML = protocolRequire('yaml');
const rootUrl = new URL('../', import.meta.url);

test('the golden decision table freezes all 20 formal failpoints with unique golden rows', async () => {
  const [source, testPlanSource] = await Promise.all([
    readFile(new URL('tests/vnext/golden-decision-table.yaml', rootUrl), 'utf8'),
    readFile(new URL('docs/vnext/creator-hosted-agent-vnext-test-plan.md', rootUrl), 'utf8'),
  ]);
  const table = YAML.parse(source);
  assert.equal(table.protocol, 'combo.vnext-golden-decision-table/1');
  assert.equal(table.schemaVersion, 1);
  const rows = table.rows;
  assert.equal(rows.length, 20);
  const ids = rows.map((row) => row.id);
  const expectedIds = Array.from(
    { length: 20 },
    (_, index) => 'FLT-' + String(index + 1).padStart(3, '0'),
  );
  assert.deepEqual(ids, expectedIds);
  assert.equal(new Set(ids).size, 20);
  for (const row of rows) {
    assert.match(row.id, /^FLT-\d{3}$/u, `bad id ${row.id}`);
    assert.ok(row.kill && row.expected && row.inv, `row ${row.id} incomplete`);
    assert.ok(['SIMULATED_RECOVERY_E1', 'MODEL_ONLY_E1', 'BLOCKED_E2_E6'].includes(row.e1));
    assert.equal(row.t1, 'planned');
  }
  // the table as a whole must bind both invariants that drive this baseline, and every row
  // must carry at least one invariant binding
  const allInvariants = rows.map((row) => row.inv).join('/');
  assert.ok(allInvariants.includes('INV-010'), 'table must bind INV-010');
  assert.ok(allInvariants.includes('INV-016'), 'table must bind INV-016');
  for (const row of rows) {
    assert.match(row.inv, /^INV-\d{3}(\/INV-\d{3})*$/u, `row ${row.id} bad invariant list`);
  }

  const formalSection = testPlanSource.match(
    /### 12\.2 正式 Failpoint\n\n([\s\S]*?)\n### 12\.3 Fault Harness/u,
  );
  assert.ok(formalSection, 'frozen test plan must contain the formal failpoint table');
  const planRows = Array.from(
    formalSection[1].matchAll(/^\| `(FLT-\d{3})` \| ([^|]+) \| ([^|]+) \|$/gmu),
    (match) => ({ id: match[1], kill: match[2].trim(), expected: match[3].trim() }),
  );
  assert.deepEqual(
    rows.map(({ id, kill, expected }) => ({ id, kill, expected })),
    planRows,
    'golden rows must match frozen test plan section 12.2 exactly',
  );
});
