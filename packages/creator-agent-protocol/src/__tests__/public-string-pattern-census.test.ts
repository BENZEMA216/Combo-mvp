import { describe, expect, it } from 'vitest';

import { collectPublicSourceBoundaryRows } from '../public-boundary-closure.js';
import {
  PUBLIC_STRING_PATTERN_CENSUS_PROTOCOL,
  PUBLIC_STRING_PATTERN_CENSUS_EXCLUSIONS,
  PUBLIC_STRING_PATTERN_PROBE_IDS,
  PublicStringPatternFamilySchema,
  collectPublicStringLengthRows,
  collectPublicStringPatternRows,
  runPublicStringRuntimeProbes,
} from '../public-string-pattern-census.js';

describe('SCH-004 actual Zod string-pattern census', () => {
  it('classifies every ContractSchemaDefinitions pattern/format row into finite families', () => {
    expect(PUBLIC_STRING_PATTERN_CENSUS_PROTOCOL).toBe('combo.public-string-pattern-census/1');
    expect(PUBLIC_STRING_PATTERN_PROBE_IDS).toEqual([
      'pattern-accepted',
      'pattern-rejected',
      'boundary-n-minus-one',
      'boundary-n',
      'boundary-n-plus-one',
    ]);
    expect(PUBLIC_STRING_PATTERN_CENSUS_EXCLUSIONS).toEqual([
      'cross-field-super-refine-is-outside-string-leaf-census',
      'decoded-byte-refinements-remain-delegated-to-decoded-boundary-corpus',
    ]);

    const patternRows = collectPublicStringPatternRows();
    const lengthRows = collectPublicStringLengthRows();
    expect(patternRows.length).toBeGreaterThan(0);
    expect(lengthRows.length).toBeGreaterThan(0);
    expect(new Set(patternRows.map(({ id }) => id)).size).toBe(patternRows.length);
    expect(new Set(lengthRows.map(({ id }) => id)).size).toBe(lengthRows.length);

    const sourceStringRowIds = collectPublicSourceBoundaryRows()
      .map(({ id }) => id)
      .filter((id) => /:string-(?:regex|uuid|url|datetime|email)-\d+$/u.test(id))
      .sort();
    expect(patternRows.map(({ id }) => id)).toEqual(sourceStringRowIds);

    const sourceLengthRowIds = collectPublicSourceBoundaryRows()
      .map(({ id }) => id)
      .filter((id) => /:string-(?:max|length)-\d+$/u.test(id))
      .sort();
    expect(lengthRows.map(({ id }) => id)).toEqual(sourceLengthRowIds);

    const representedFamilies = new Set(patternRows.map(({ family }) => family));
    for (const family of PublicStringPatternFamilySchema.options) {
      expect(representedFamilies.has(family), family).toBe(true);
    }
  });

  it('executes every machine probe against the actual ZodString leaf owner', () => {
    const patternRows = collectPublicStringPatternRows();
    const lengthRows = collectPublicStringLengthRows();
    const outcomes = runPublicStringRuntimeProbes();
    expect(outcomes).toHaveLength(patternRows.length * 2 + lengthRows.length * 3);
    expect(new Set(outcomes.map(({ rowId, probeId }) => `${rowId}:${probeId}`)).size).toBe(
      outcomes.length,
    );
    for (const outcome of outcomes) {
      expect(outcome.accepted, `${outcome.rowId}:${outcome.probeId}`).toBe(outcome.expected);
      expect(outcome.targetIssue, `${outcome.rowId}:${outcome.probeId}:target`).toBe(true);
    }
  });
});
