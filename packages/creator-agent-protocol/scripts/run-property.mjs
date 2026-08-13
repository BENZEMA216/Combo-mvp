import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const valueFor = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const seed = valueFor('--seed', process.env.VNEXT_PROPERTY_SEED ?? '12648430');
const runs = valueFor('--runs', process.env.VNEXT_PROPERTY_RUNS ?? '100000');

if (!/^\d+$/u.test(seed) || !/^\d+$/u.test(runs) || Number(runs) < 1) {
  throw new Error('用法：pnpm vnext:test:property --seed <uint32> [--runs <positive-int>]');
}

const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', 'src/__tests__/invocation.property.test.ts'],
  {
    cwd: process.cwd(),
    env: { ...process.env, VNEXT_PROPERTY_SEED: seed, VNEXT_PROPERTY_RUNS: runs },
    stdio: 'inherit',
  },
);
process.exit(result.status ?? 1);
