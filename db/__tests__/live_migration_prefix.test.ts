import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(directory, '..', 'migrations');

const LIVE_TEST_CHAIN = [
  ['0012_agent_builder_v1.sql', 'fca0a5de3f653cc6553dc0593e98b0d3f2e1b2bc1f2131724386d4d35ac4d445'],
  [
    '0013_external_mcp_oauth.sql',
    'd65694657a9d10fa5455a786aab88c99cf45281dfe0c69174e2f63180cc94911',
  ],
  [
    '0014_agent_test_reviews.sql',
    '49c37341ce6d8875372a8fcad4a58a53206466850b2401d2a00f564d2ad40ef1',
  ],
  [
    '0015_project_agent_shares.sql',
    'd5baf2cf5b8377d6d20a2911e68b0fd09ba83e35536b49a40ffaafdbbe4572fe',
  ],
  [
    '0016_project_history_agent_flow.sql',
    '4244f64ce8419f033f89e8a1a33a95f0d79787c0039849d6b0c478db3cfba95c',
  ],
  [
    '0017_agent_package_registry.sql',
    '6dcfba0c1417827e5cb92b4f22737ab1c29629e5794b706caf7a148c1caa47a2',
  ],
  [
    '0018_agent_session_usage_receipts.sql',
    '097965f54e287f8602f1020e7dd21883a6dc7c8734aaad5c673034ffbd12cd65',
  ],
  [
    '0019_pending_usage_recovery.sql',
    'e4820b0a9d980c7783cb1a35194720cf7c454cbcb439d1a70c716a708c150ab8',
  ],
] as const;

describe('live Test migration ledger compatibility', () => {
  it('retains the already-applied 0012-0019 names as one exact source suffix', () => {
    const filenames = readdirSync(migrationsDirectory)
      .filter((filename) => filename.endsWith('.sql'))
      .sort();
    const firstCompatibilityIndex = filenames.indexOf(LIVE_TEST_CHAIN[0][0]);

    expect(firstCompatibilityIndex).toBeGreaterThan(0);
    expect(filenames.slice(firstCompatibilityIndex - 1)).toEqual([
      '0011_recharge_qr_only.sql',
      ...LIVE_TEST_CHAIN.map(([filename]) => filename),
    ]);
  });

  it.each(LIVE_TEST_CHAIN)('preserves %s byte-for-byte', (filename, sha256) => {
    const bytes = readFileSync(join(migrationsDirectory, filename));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
  });
});
