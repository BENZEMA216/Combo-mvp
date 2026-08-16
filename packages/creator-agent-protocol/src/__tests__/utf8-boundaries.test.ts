import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import { Utf8TextSchema } from '../primitives.js';
import { ProtocolUtf8BoundaryCorpusSchema } from '../utf8-boundaries.js';

type CheckedArtifactName = 'contract-schemas' | 'broker-contract' | 'openapi';

const fixtureUrl = new URL('../../fixtures/protocol-utf8-boundaries.v1.json', import.meta.url);
const artifactUrls = {
  'contract-schemas': new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  'broker-contract': new URL('../../schemas/broker-contract.v1.json', import.meta.url),
  openapi: new URL('../../openapi/creator-agent-v1.openapi.json', import.meta.url),
} as const satisfies Record<CheckedArtifactName, URL>;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function exactUtf8Bytes(targetBytes: number, generator: 'ascii' | 'cjk' | 'emoji'): string {
  const symbol = generator === 'ascii' ? 'a' : generator === 'cjk' ? '界' : '😀';
  const symbolBytes = Buffer.byteLength(symbol, 'utf8');
  const repeats = Math.floor(targetBytes / symbolBytes);
  return symbol.repeat(repeats) + 'a'.repeat(targetBytes - repeats * symbolBytes);
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function collectUtf8Pointers(
  artifact: CheckedArtifactName,
  value: unknown,
  path: readonly string[] = [],
  output: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectUtf8Pointers(artifact, item, [...path, String(index)], output),
    );
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'x-combo-maxUtf8Bytes')) {
    output.push(`${artifact}:/${path.map(escapePointerSegment).join('/')}`);
  }
  for (const [key, item] of Object.entries(record)) {
    collectUtf8Pointers(artifact, item, [...path, key], output);
  }
  return output;
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  let current = document;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`UTF8_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`UTF8_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
}

describe('digest-bound public UTF-8 byte boundaries', () => {
  it('pins every advertised UTF-8 keyword in all three checked artifacts', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    expect(fixture.scope).toBe('utf8-byte-limits-only');
    const documents = Object.fromEntries(
      await Promise.all(
        Object.entries(artifactUrls).map(async ([name, url]) => [
          name,
          JSON.parse(await readFile(url, 'utf8')),
        ]),
      ),
    ) as Record<CheckedArtifactName, unknown>;
    const artifactBytes = {
      contractSchemas: await readFile(artifactUrls['contract-schemas']),
      brokerContract: await readFile(artifactUrls['broker-contract']),
      openApi: await readFile(artifactUrls.openapi),
    };
    expect(fixture.checkedArtifactDigests).toEqual({
      contractSchemas: sha256(artifactBytes.contractSchemas),
      brokerContract: sha256(artifactBytes.brokerContract),
      openApi: sha256(artifactBytes.openApi),
    });

    const expectedPointers = fixture.boundaries
      .flatMap(({ artifactPointers }) =>
        artifactPointers.map(({ artifact, pointer }) => `${artifact}:${pointer}`),
      )
      .sort();
    const actualPointers = (Object.entries(documents) as [CheckedArtifactName, unknown][])
      .flatMap(([artifact, document]) => collectUtf8Pointers(artifact, document))
      .sort();
    expect(actualPointers).toEqual(expectedPointers);

    for (const boundary of fixture.boundaries) {
      for (const { artifact, pointer } of boundary.artifactPointers) {
        const node = lookupPointer(documents[artifact], pointer);
        expect(node.maxLength, `${artifact}:${pointer}`).toBe(boundary.maxBytes);
        expect(node['x-combo-maxUtf8Bytes'], `${artifact}:${pointer}`).toBe(boundary.maxBytes);
        expect(node.description, `${artifact}:${pointer}`).toBe(
          `UTF-8 text with a maximum of ${boundary.maxBytes} bytes`,
        );
      }
    }
  });

  it('enforces max minus one, max, and max plus one for ASCII CJK and emoji', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    for (const boundary of fixture.boundaries) {
      const schema = Utf8TextSchema(boundary.maxBytes);
      for (const generator of boundary.generators) {
        const below = exactUtf8Bytes(boundary.maxBytes - 1, generator);
        const exact = exactUtf8Bytes(boundary.maxBytes, generator);
        const above = exactUtf8Bytes(boundary.maxBytes + 1, generator);
        expect(Buffer.byteLength(below, 'utf8')).toBe(boundary.maxBytes - 1);
        expect(Buffer.byteLength(exact, 'utf8')).toBe(boundary.maxBytes);
        expect(Buffer.byteLength(above, 'utf8')).toBe(boundary.maxBytes + 1);
        expect(schema.safeParse(below).success, `${boundary.maxBytes}:${generator}:N-1`).toBe(true);
        expect(schema.safeParse(exact).success, `${boundary.maxBytes}:${generator}:N`).toBe(true);
        expect(schema.safeParse(above).success, `${boundary.maxBytes}:${generator}:N+1`).toBe(
          false,
        );
      }
    }
  });

  it('registers the custom byte keyword where standard maxLength still accepts multibyte N plus one', async () => {
    const fixture = ProtocolUtf8BoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const contractSchemas = JSON.parse(
      await readFile(artifactUrls['contract-schemas'], 'utf8'),
    ) as unknown;
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    ajv.addKeyword({
      keyword: 'x-combo-maxUtf8Bytes',
      type: 'string',
      schemaType: 'number',
      errors: false,
      validate(maximumBytes: number, value: string): boolean {
        return Buffer.byteLength(value, 'utf8') <= maximumBytes;
      },
    });
    for (const boundary of fixture.boundaries) {
      const pointer = boundary.artifactPointers.find(
        ({ artifact }) => artifact === 'contract-schemas',
      );
      if (pointer === undefined) throw new Error('UTF8_CONTRACT_SCHEMA_POINTER_MISSING');
      const node = lookupPointer(contractSchemas, pointer.pointer);
      const validate = ajv.compile(node as AnySchema);
      for (const generator of ['cjk', 'emoji'] as const) {
        const above = exactUtf8Bytes(boundary.maxBytes + 1, generator);
        expect([...above].length).toBeLessThanOrEqual(boundary.maxBytes);
        expect(validate(above), `${boundary.maxBytes}:${generator}:N+1`).toBe(false);
        expect(validate(exactUtf8Bytes(boundary.maxBytes, generator))).toBe(true);
      }
    }
  });
});
