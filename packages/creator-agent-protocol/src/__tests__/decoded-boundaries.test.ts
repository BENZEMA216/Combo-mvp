import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import {
  BrokerEnvelopeSchema,
  BrokerHandshakeSchema,
  BrokerHandshakeUnsignedSchema,
  brokerHandshakeSigningBytes,
  brokerSensitiveMessageCipherDigest,
  ExecutionCapabilitySchema,
  parseBrokerFrame,
  parseBrokerHandshake,
} from '../broker.js';
import { ProtocolDecodedBoundaryCorpusSchema } from '../decoded-boundaries.js';
import { EvidenceReviewerSignoffSchema } from '../evidence.js';
import { SandboxAttestationSchema } from '../sandbox.js';
import { SnapshotArchiveEnvelopeSchema, SnapshotManifestEnvelopeSchema } from '../snapshot.js';

type CheckedArtifactName = 'contract-schemas' | 'broker-contract' | 'openapi';

const fixtureUrl = new URL('../../fixtures/protocol-decoded-boundaries.v1.json', import.meta.url);
const artifactUrls = {
  'contract-schemas': new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  'broker-contract': new URL('../../schemas/broker-contract.v1.json', import.meta.url),
  openapi: new URL('../../openapi/creator-agent-v1.openapi.json', import.meta.url),
} as const satisfies Record<CheckedArtifactName, URL>;
const baseFixtureUrls = {
  brokerHandshake: new URL('../../fixtures/broker-handshake.v1.json', import.meta.url),
  brokerInvocationPrepare: new URL(
    '../../fixtures/broker-invocation-prepare.v1.json',
    import.meta.url,
  ),
  sandboxAttestation: new URL('../../fixtures/sandbox-attestation.v1.json', import.meta.url),
  evidenceReviewerSignoff: new URL(
    '../../fixtures/evidence-reviewer-signoff.v1.json',
    import.meta.url,
  ),
  snapshotEnvelope: new URL('../../fixtures/snapshot-envelope.v1.json', import.meta.url),
  snapshotManifestEnvelope: new URL(
    '../../fixtures/snapshot-manifest-envelope.v1.json',
    import.meta.url,
  ),
} as const;
const fixtureKeyByPath = {
  'broker-handshake.v1.json': 'brokerHandshake',
  'broker-invocation-prepare.v1.json': 'brokerInvocationPrepare',
  'sandbox-attestation.v1.json': 'sandboxAttestation',
  'evidence-reviewer-signoff.v1.json': 'evidenceReviewerSignoff',
  'snapshot-envelope.v1.json': 'snapshotEnvelope',
  'snapshot-manifest-envelope.v1.json': 'snapshotManifestEnvelope',
} as const;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  let current = document;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`DECODED_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error(`DECODED_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
}

function setPointer(document: Record<string, unknown>, pointer: string, value: string): void {
  const segments = pointerSegments(pointer);
  const field = segments.pop();
  if (field === undefined) throw new Error('DECODED_BOUNDARY_VALUE_POINTER_EMPTY');
  let current: Record<string, unknown> = document;
  for (const segment of segments) {
    const next = current[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`DECODED_BOUNDARY_VALUE_POINTER_MISSING:${pointer}`);
    }
    current = next as Record<string, unknown>;
  }
  current[field] = value;
}

function collectDecodedPointers(
  artifact: CheckedArtifactName,
  value: unknown,
  path: readonly string[] = [],
  output: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectDecodedPointers(artifact, item, [...path, String(index)], output),
    );
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'x-combo-canonicalBase64UrlBytes')) {
    output.push(`${artifact}:/${path.map(escapePointerSegment).join('/')}`);
  }
  for (const [key, item] of Object.entries(record)) {
    collectDecodedPointers(artifact, item, [...path, key], output);
  }
  return output;
}

function createDecodedBoundaryAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  ajv.addKeyword({
    keyword: 'x-combo-canonicalBase64UrlBytes',
    type: 'string',
    schemaType: 'object',
    errors: false,
    validate(boundary: { minimum: number; maximum: number }, value: string): boolean {
      const bytes = Buffer.from(value, 'base64url');
      return (
        bytes.byteLength >= boundary.minimum &&
        bytes.byteLength <= boundary.maximum &&
        bytes.toString('base64url') === value
      );
    },
  });
  return ajv;
}

function canonicalValue(byteLength: number): string {
  return Buffer.alloc(byteLength, 0xa5).toString('base64url');
}

const runtimeParsers = {
  BrokerHandshakeSchema,
  ExecutionCapabilitySchema,
  SandboxAttestationSchema,
  EvidenceReviewerSignoffSchema,
  SnapshotArchiveEnvelopeSchema,
  SnapshotManifestEnvelopeSchema,
  BrokerEnvelopeSchema,
} as const;

describe('digest-bound decoded and canonical base64url owner boundaries', () => {
  it('pins every advertised decoded-byte keyword and every base fixture digest', async () => {
    const corpus = ProtocolDecodedBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const documents = Object.fromEntries(
      await Promise.all(
        Object.entries(artifactUrls).map(async ([name, url]) => [
          name,
          JSON.parse(await readFile(url, 'utf8')),
        ]),
      ),
    ) as Record<CheckedArtifactName, unknown>;
    expect(corpus.checkedArtifactDigests).toEqual({
      contractSchemas: sha256(await readFile(artifactUrls['contract-schemas'])),
      brokerContract: sha256(await readFile(artifactUrls['broker-contract'])),
      openApi: sha256(await readFile(artifactUrls.openapi)),
    });
    for (const [name, url] of Object.entries(baseFixtureUrls)) {
      expect(sha256(await readFile(url)), name).toBe(
        corpus.baseFixtureDigests[name as keyof typeof baseFixtureUrls],
      );
    }

    const expectedPointers = corpus.boundaries
      .flatMap(({ artifactPointers }) =>
        artifactPointers.map(({ artifact, pointer }) => `${artifact}:${pointer}`),
      )
      .sort();
    const actualPointers = (Object.entries(documents) as [CheckedArtifactName, unknown][])
      .flatMap(([artifact, document]) => collectDecodedPointers(artifact, document))
      .sort();
    expect(actualPointers).toEqual(expectedPointers);

    for (const boundary of corpus.boundaries) {
      for (const { artifact, pointer } of boundary.artifactPointers) {
        const node = lookupPointer(documents[artifact], pointer);
        expect(node.minLength, `${artifact}:${pointer}:minLength`).toBe(
          Math.ceil((boundary.minimumBytes * 4) / 3),
        );
        expect(node.maxLength, `${artifact}:${pointer}:maxLength`).toBe(
          Math.ceil((boundary.maximumBytes * 4) / 3),
        );
        expect(node['x-combo-canonicalBase64UrlBytes'], `${artifact}:${pointer}`).toEqual({
          minimum: boundary.minimumBytes,
          maximum: boundary.maximumBytes,
        });
      }
    }
  });

  it('executes the custom keyword at every pointer for exact and ranged decoded bytes', async () => {
    const corpus = ProtocolDecodedBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const documents = Object.fromEntries(
      await Promise.all(
        Object.entries(artifactUrls).map(async ([name, url]) => [
          name,
          JSON.parse(await readFile(url, 'utf8')),
        ]),
      ),
    ) as Record<CheckedArtifactName, unknown>;
    for (const boundary of corpus.boundaries) {
      const probes = new Map<number, boolean>([
        [Math.max(0, boundary.minimumBytes - 1), false],
        [boundary.minimumBytes, true],
        [boundary.maximumBytes, true],
        [boundary.maximumBytes + 1, false],
      ]);
      for (const { artifact, pointer } of boundary.artifactPointers) {
        const validate = createDecodedBoundaryAjv().compile(
          lookupPointer(documents[artifact], pointer) as AnySchema,
        );
        for (const [byteLength, expected] of probes) {
          expect(
            validate(canonicalValue(byteLength)),
            `${artifact}:${pointer}:${byteLength}:${JSON.stringify(validate.errors)}`,
          ).toBe(expected);
        }
      }
    }

    const exact16 = corpus.boundaries.find(({ id }) => id === 'snapshot-auth-tag');
    if (exact16 === undefined) throw new Error('DECODED_BOUNDARY_EXACT16_MISSING');
    const pointer = exact16.artifactPointers[0]!;
    const node = lookupPointer(documents[pointer.artifact], pointer.pointer);
    const canonical = Buffer.alloc(16, 0xff).toString('base64url');
    const nonCanonical = `${canonical.slice(0, -1)}x`;
    expect(Buffer.from(nonCanonical, 'base64url')).toEqual(Buffer.from(canonical, 'base64url'));
    expect(Buffer.from(nonCanonical, 'base64url').toString('base64url')).not.toBe(nonCanonical);
    const structuralNode = { ...node };
    delete structuralNode['x-combo-canonicalBase64UrlBytes'];
    expect(
      new Ajv({ strict: false, validateFormats: false }).compile(structuralNode as AnySchema)(
        nonCanonical,
      ),
    ).toBe(true);
    expect(createDecodedBoundaryAjv().compile(node as AnySchema)(nonCanonical)).toBe(false);
  });

  it('drives every frozen runtime owner with the same decoded-byte probes', async () => {
    const corpus = ProtocolDecodedBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const fixtures = Object.fromEntries(
      await Promise.all(
        Object.entries(fixtureKeyByPath).map(async ([path, key]) => [
          path,
          JSON.parse(await readFile(baseFixtureUrls[key], 'utf8')) as Record<string, unknown>,
        ]),
      ),
    ) as Record<keyof typeof fixtureKeyByPath, Record<string, unknown>>;
    const boundaries = new Map(corpus.boundaries.map((boundary) => [boundary.id, boundary]));

    for (const ownerCase of corpus.ownerCases) {
      const boundary = boundaries.get(ownerCase.boundaryId);
      if (boundary === undefined) throw new Error(`DECODED_BOUNDARY_MISSING:${ownerCase.id}`);
      const probes = new Map<number, boolean>([
        [Math.max(0, boundary.minimumBytes - 1), false],
        [boundary.minimumBytes, true],
        [boundary.maximumBytes, true],
        [boundary.maximumBytes + 1, false],
      ]);
      for (const [byteLength, expected] of probes) {
        const candidate = structuredClone(fixtures[ownerCase.fixturePath]);
        const owner = lookupPointer(candidate, ownerCase.ownerPointer);
        setPointer(owner, ownerCase.valuePointer, canonicalValue(byteLength));
        if (ownerCase.repair === 'broker-sensitive-cipher-digest' && expected) {
          const body = candidate.body as Record<string, unknown>;
          const sensitive = body.userMessageCiphertext as Record<string, unknown>;
          sensitive.cipherDigest = brokerSensitiveMessageCipherDigest(
            sensitive.nonce as string,
            sensitive.ciphertext as string,
            sensitive.authTag as string,
          );
        }
        const parser = runtimeParsers[ownerCase.runtimeParser];
        expect(
          parser.safeParse(owner).success,
          `${ownerCase.id}:${byteLength}:${ownerCase.runtimeParser}`,
        ).toBe(expected);
        if (ownerCase.runtimeParser === 'BrokerHandshakeSchema') {
          const parse = () => parseBrokerHandshake(JSON.stringify(candidate));
          if (expected) expect(parse, `${ownerCase.id}:wire:${byteLength}`).not.toThrow();
          else expect(parse, `${ownerCase.id}:wire:${byteLength}`).toThrow();
        } else if (ownerCase.runtimeParser === 'BrokerEnvelopeSchema') {
          const parse = () => parseBrokerFrame(JSON.stringify(candidate));
          if (expected) expect(parse, `${ownerCase.id}:wire:${byteLength}`).not.toThrow();
          else expect(parse, `${ownerCase.id}:wire:${byteLength}`).toThrow();
        }
      }
    }
  });

  it('accepts a real P-256 signer output and rejects adjacent decoded sizes before authority', async () => {
    const fixture = JSON.parse(await readFile(baseFixtureUrls.brokerHandshake, 'utf8')) as Record<
      string,
      unknown
    >;
    const { challengeSignature: _signature, ...unsignedInput } = fixture;
    const unsigned = BrokerHandshakeUnsignedSchema.parse(unsignedInput);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const signature = sign('sha256', brokerHandshakeSigningBytes(unsigned), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
    expect(
      BrokerHandshakeSchema.safeParse({ ...unsigned, challengeSignature: signature }).success,
    ).toBe(true);
    for (const byteLength of [63, 65]) {
      expect(
        BrokerHandshakeSchema.safeParse({
          ...unsigned,
          challengeSignature: canonicalValue(byteLength),
        }).success,
      ).toBe(false);
    }
  });
});
