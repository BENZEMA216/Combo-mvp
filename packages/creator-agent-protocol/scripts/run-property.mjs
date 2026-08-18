/* global process */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const valueFor = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const seed = valueFor('--seed', process.env.VNEXT_PROPERTY_SEED ?? '12648430');
const runs = valueFor('--runs', process.env.VNEXT_PROPERTY_RUNS ?? '100000');
const seeds = valueFor('--seeds', process.env.VNEXT_PROPERTY_SEEDS ?? '100');

if (
  !/^\d+$/u.test(seed) ||
  Number(seed) > 0xffff_ffff ||
  !/^\d+$/u.test(runs) ||
  Number(runs) < 1 ||
  !/^\d+$/u.test(seeds) ||
  Number(seeds) < 1 ||
  Number(seeds) > Number(runs)
) {
  throw new Error(
    '用法：pnpm vnext:test:property --seed <uint32> [--seeds <positive-int>] [--runs <positive-int>]',
  );
}

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    'src/__tests__/invocation.property.test.ts',
    'src/__tests__/conversation-ready-facts.property.test.ts',
    'src/__tests__/broker-contract.property.test.ts',
    'src/__tests__/capability.property.test.ts',
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VNEXT_PROPERTY_SEED: seed,
      VNEXT_PROPERTY_RUNS: runs,
      VNEXT_PROPERTY_SEEDS: seeds,
    },
    stdio: 'inherit',
  },
);
process.exit(result.status ?? 1);
