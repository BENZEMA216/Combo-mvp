const DEFAULT_PROPERTY_RUNS = 100_000;
const DEFAULT_PROPERTY_SEED_BASE = 12_648_430;
const DEFAULT_PROPERTY_SEED_COUNT = 100;
const PROPERTY_SEED_STEP = 0x9e37_79b9;

function positiveSafeInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw !== undefined && !/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error(`${name} must use canonical positive decimal syntax`);
  }
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function uint32(name: string, raw: string | undefined, fallback: number): number {
  if (raw !== undefined && !/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`${name} must use canonical uint32 decimal syntax`);
  }
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${name} must be a uint32`);
  }
  return value >>> 0;
}

export const PROPERTY_RUNS = positiveSafeInteger(
  'VNEXT_PROPERTY_RUNS',
  process.env.VNEXT_PROPERTY_RUNS,
  DEFAULT_PROPERTY_RUNS,
);
export const PROPERTY_SEED_BASE = uint32(
  'VNEXT_PROPERTY_SEED',
  process.env.VNEXT_PROPERTY_SEED,
  DEFAULT_PROPERTY_SEED_BASE,
);
export const PROPERTY_SEED_COUNT = positiveSafeInteger(
  'VNEXT_PROPERTY_SEEDS',
  process.env.VNEXT_PROPERTY_SEEDS,
  DEFAULT_PROPERTY_SEED_COUNT,
);
export const PROPERTY_SEED_CORPUS_SHA256 =
  'sha256:a608d11159dc2055653480d744a39af76ab84cf0bbef0c57f479e0a0f9f91a42' as const;

if (PROPERTY_SEED_COUNT > PROPERTY_RUNS) {
  throw new Error('VNEXT_PROPERTY_SEEDS must not exceed VNEXT_PROPERTY_RUNS');
}

export type PropertySeedRun = Readonly<{ seed: number; runs: number }>;

export function propertySeedMatrix(): readonly PropertySeedRun[] {
  const minimumRuns = Math.floor(PROPERTY_RUNS / PROPERTY_SEED_COUNT);
  const remainder = PROPERTY_RUNS % PROPERTY_SEED_COUNT;
  return Object.freeze(
    Array.from({ length: PROPERTY_SEED_COUNT }, (_, index) =>
      Object.freeze({
        seed: (PROPERTY_SEED_BASE + Math.imul(index, PROPERTY_SEED_STEP)) >>> 0,
        runs: minimumRuns + (index < remainder ? 1 : 0),
      }),
    ),
  );
}
