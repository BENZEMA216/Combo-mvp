import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(directory, '..', 'migrations');

const LIVE_TEST_PREFIX = [
  {
    filename: '0012_agent_builder_v1.sql',
    sha256: 'fca0a5de3f653cc6553dc0593e98b0d3f2e1b2bc1f2131724386d4d35ac4d445',
  },
  {
    filename: '0013_external_mcp_oauth.sql',
    sha256: 'd65694657a9d10fa5455a786aab88c99cf45281dfe0c69174e2f63180cc94911',
  },
  {
    filename: '0014_agent_test_reviews.sql',
    sha256: '49c37341ce6d8875372a8fcad4a58a53206466850b2401d2a00f564d2ad40ef1',
  },
  {
    filename: '0015_project_agent_shares.sql',
    sha256: 'd5baf2cf5b8377d6d20a2911e68b0fd09ba83e35536b49a40ffaafdbbe4572fe',
  },
  {
    filename: '0016_project_history_agent_flow.sql',
    sha256: '4244f64ce8419f033f89e8a1a33a95f0d79787c0039849d6b0c478db3cfba95c',
  },
] as const;

describe('live Test migration ledger compatibility', () => {
  it('retains the already-applied 0012-0016 names as one exact source prefix', () => {
    const filenames = readdirSync(migrationsDirectory)
      .filter((filename) => filename.endsWith('.sql'))
      .sort();
    const firstCompatibilityIndex = filenames.indexOf(LIVE_TEST_PREFIX[0].filename);

    expect(firstCompatibilityIndex).toBeGreaterThan(0);
    expect(
      filenames.slice(
        firstCompatibilityIndex - 1,
        firstCompatibilityIndex + LIVE_TEST_PREFIX.length,
      ),
    ).toEqual(['0011_recharge_qr_only.sql', ...LIVE_TEST_PREFIX.map(({ filename }) => filename)]);
  });

  it.each(LIVE_TEST_PREFIX)('preserves $filename byte-for-byte', ({ filename, sha256 }) => {
    const bytes = readFileSync(join(migrationsDirectory, filename));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
  });
});
