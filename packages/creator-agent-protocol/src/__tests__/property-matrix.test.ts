import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  PROPERTY_RUNS,
  PROPERTY_SEED_BASE,
  PROPERTY_SEED_COUNT,
  PROPERTY_SEED_CORPUS_SHA256,
  propertySeedMatrix,
} from './property-matrix.js';

describe('T0-LINUX-CI property seed matrix', () => {
  it('freezes 100 unique deterministic seeds over 100000 total runs per model', () => {
    const matrix = propertySeedMatrix();

    expect(PROPERTY_SEED_BASE).toBe(12_648_430);
    expect(PROPERTY_SEED_COUNT).toBe(100);
    expect(PROPERTY_RUNS).toBe(100_000);
    expect(matrix).toHaveLength(100);
    expect(new Set(matrix.map(({ seed }) => seed)).size).toBe(100);
    expect(matrix.reduce((sum, { runs }) => sum + runs, 0)).toBe(100_000);
    expect(matrix.every(({ runs }) => runs === 1_000)).toBe(true);
    expect(`sha256:${createHash('sha256').update(JSON.stringify(matrix)).digest('hex')}`).toBe(
      PROPERTY_SEED_CORPUS_SHA256,
    );
  });
});
