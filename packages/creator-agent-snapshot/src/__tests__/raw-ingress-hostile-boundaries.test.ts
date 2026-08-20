import { readFile } from 'node:fs/promises';

import {
  ProtocolRawIngressHostileBoundaryCorpusSchema,
  canonicalizeJson,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import { isSnapshotError, parseSnapshotManifest, snapshotManifestBytes } from '../index.js';

const corpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/protocol-raw-ingress-hostile-boundaries.v1.json',
  import.meta.url,
);
const manifestUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-manifest.v1.json',
  import.meta.url,
);

type PathSegment = string | number;
type HostileProbe = Readonly<{ id: string; canary: string; bytes: Buffer }>;

function pointerSegments(pointer: string): PathSegment[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => (/^\d+$/u.test(segment) ? Number(segment) : segment));
}

function replacePointer(input: unknown, pointer: string, replacement: unknown): unknown {
  const clone = structuredClone(input);
  const segments = pointerSegments(pointer);
  let current = clone;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== 'object') throw new Error('RAW_POINTER_INVALID');
    current = (current as Record<PathSegment, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') throw new Error('RAW_POINTER_INVALID');
  (current as Record<PathSegment, unknown>)[segments.at(-1)!] = replacement;
  return clone;
}

function replaceAscii(bytes: Buffer, sentinel: string, replacement: Uint8Array): Buffer {
  const needle = Buffer.from(sentinel, 'utf8');
  const offset = bytes.indexOf(needle);
  if (offset < 0 || bytes.indexOf(needle, offset + needle.byteLength) >= 0) {
    throw new Error(`RAW_SENTINEL_NOT_UNIQUE:${sentinel}`);
  }
  return Buffer.concat([
    bytes.subarray(0, offset),
    Buffer.from(replacement),
    bytes.subarray(offset + needle.byteLength),
  ]);
}

function hostileProbes(
  base: unknown,
  targetPointer: string,
  recipe: {
    canaryPrefix: string;
    malformedUtf8Hex: readonly string[];
    loneSurrogateEscapes: readonly string[];
    forbiddenControlRanges: readonly { start: number; end: number }[];
    allowedControlCodeUnits: readonly number[];
  },
): HostileProbe[] {
  const output: HostileProbe[] = [];
  for (const hex of recipe.malformedUtf8Hex) {
    const canary = `${recipe.canaryPrefix}MALFORMED_${hex}_`;
    const sentinel = `MALFORMED_SENTINEL_${hex}`;
    const seeded = Buffer.from(
      canonicalizeJson(replacePointer(base, targetPointer, `${canary}${sentinel}`)),
      'utf8',
    );
    output.push({
      id: `malformed-${hex}`,
      canary,
      bytes: replaceAscii(seeded, sentinel, Buffer.from(hex, 'hex')),
    });
  }
  recipe.loneSurrogateEscapes.forEach((escape, index) => {
    const canary = `${recipe.canaryPrefix}SURROGATE_${index}_`;
    const sentinel = `SURROGATE_SENTINEL_${index}`;
    const seeded = Buffer.from(
      canonicalizeJson(replacePointer(base, targetPointer, `${canary}${sentinel}`)),
      'utf8',
    );
    output.push({
      id: `surrogate-${index}`,
      canary,
      bytes: replaceAscii(seeded, sentinel, Buffer.from(escape, 'ascii')),
    });
  });
  const allowed = new Set(recipe.allowedControlCodeUnits);
  for (const range of recipe.forbiddenControlRanges) {
    for (let codeUnit = range.start; codeUnit <= range.end; codeUnit += 1) {
      if (allowed.has(codeUnit)) continue;
      const canary = `${recipe.canaryPrefix}CONTROL_${codeUnit.toString(16).padStart(2, '0')}_`;
      output.push({
        id: `control-${codeUnit.toString(16).padStart(2, '0')}`,
        canary,
        bytes: Buffer.from(
          canonicalizeJson(
            replacePointer(base, targetPointer, `${canary}${String.fromCharCode(codeUnit)}`),
          ),
          'utf8',
        ),
      });
    }
  }
  const structuralCanary = (id: string) => `${recipe.canaryPrefix}${id.toUpperCase()}_`;
  const bomCanary = structuralCanary('bom');
  output.push(
    {
      id: 'bom',
      canary: bomCanary,
      bytes: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          canonicalizeJson(replacePointer(base, targetPointer, `${bomCanary}value`)),
          'utf8',
        ),
      ]),
    },
    {
      id: 'syntax',
      canary: structuralCanary('syntax'),
      bytes: Buffer.from(`{"${structuralCanary('syntax')}":`, 'utf8'),
    },
    {
      id: 'duplicate-root',
      canary: structuralCanary('duplicate-root'),
      bytes: Buffer.from(
        `{"${structuralCanary('duplicate-root')}":1,"${structuralCanary('duplicate-root')}":2}`,
        'utf8',
      ),
    },
    {
      id: 'duplicate-nested',
      canary: structuralCanary('duplicate-nested'),
      bytes: Buffer.from(
        `{"nested":{"${structuralCanary('duplicate-nested')}":1,"${structuralCanary('duplicate-nested')}":2}}`,
        'utf8',
      ),
    },
  );
  const rootCanary = structuralCanary('unknown-root');
  const nestedCanary = structuralCanary('unknown-nested');
  output.push(
    {
      id: 'unknown-root',
      canary: rootCanary,
      bytes: Buffer.from(canonicalizeJson({ ...(base as object), [rootCanary]: true }), 'utf8'),
    },
    {
      id: 'unknown-nested',
      canary: nestedCanary,
      bytes: Buffer.from(
        canonicalizeJson({ ...(base as object), nested: { [nestedCanary]: true } }),
        'utf8',
      ),
    },
  );
  return output;
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('production Snapshot Manifest raw ingress hostile boundary', () => {
  it('runs 76 immutable inputs through the stable public parser', async () => {
    const corpus = ProtocolRawIngressHostileBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const owner = corpus.owners[11];
    expect(owner.id).toBe('snapshot-manifest');
    const base = JSON.parse(await readFile(manifestUrl, 'utf8')) as unknown;
    const baseline = snapshotManifestBytes(base as Parameters<typeof snapshotManifestBytes>[0]);
    expect(parseSnapshotManifest(baseline)).toBeDefined();
    const baselineBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), baseline]);
    const baselineBomBefore = Buffer.from(baselineBom);
    expect(
      isSnapshotError(
        caught(() => parseSnapshotManifest(baselineBom)),
        owner.expectedCode,
      ),
    ).toBe(true);
    expect(baselineBom).toEqual(baselineBomBefore);
    let outcomes = 1;
    const probes = hostileProbes(base, owner.targetPointer, corpus.probes);
    expect(probes).toHaveLength(corpus.outcomeCounts.perOwner - 1);
    for (const probe of probes) {
      expect(probe.bytes.includes(Buffer.from(probe.canary, 'utf8')), `${probe.id}:canary`).toBe(
        true,
      );
      const before = Buffer.from(probe.bytes);
      const error = caught(() => parseSnapshotManifest(probe.bytes));
      expect(isSnapshotError(error, owner.expectedCode), probe.id).toBe(true);
      expect(error, probe.id).not.toHaveProperty('cause');
      expect(error, probe.id).not.toHaveProperty('issues');
      expect(error, probe.id).not.toHaveProperty('input');
      expect(`${String(error)} ${JSON.stringify(error)}`, probe.id).not.toContain(probe.canary);
      expect(probe.bytes, `${probe.id}:input`).toEqual(before);
      outcomes += 1;
    }
    expect(outcomes).toBe(corpus.outcomeCounts.snapshotErrors);
  }, 15_000);
});
