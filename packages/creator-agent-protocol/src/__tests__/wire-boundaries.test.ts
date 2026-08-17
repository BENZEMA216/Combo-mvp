import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { BROKER_MAX_FRAME_BYTES, parseBrokerFrame, parseBrokerHandshake } from '../broker.js';
import { EVIDENCE_MAX_STRUCTURED_JSON_BYTES } from '../evidence.js';
import {
  ProtocolWireBoundaryCorpusSchema,
  type ProtocolWireBoundaryCorpus,
} from '../wire-boundaries.js';
import { readFixture } from './fixture-helpers.js';

const UTF8_SENTINEL = 'UTF8_SENTINEL';
const corpusUrl = new URL('../../fixtures/protocol-wire-boundaries.v1.json', import.meta.url);

async function readCorpus(): Promise<ProtocolWireBoundaryCorpus> {
  return ProtocolWireBoundaryCorpusSchema.parse(JSON.parse(await readFile(corpusUrl, 'utf8')));
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function padJsonToBytes(json: string, targetBytes: number): Buffer {
  const bytes = Buffer.from(json, 'utf8');
  const paddingBytes = targetBytes - bytes.byteLength;
  if (paddingBytes < 0) throw new RangeError('WIRE_BOUNDARY_BASE_FIXTURE_EXCEEDS_TARGET');
  return Buffer.concat([bytes, Buffer.alloc(paddingBytes, 0x20)]);
}

function replaceUtf8SentinelWithBytes(json: string, replacement: readonly number[]): Buffer {
  const input = Buffer.from(json, 'utf8');
  const sentinel = Buffer.from(UTF8_SENTINEL, 'utf8');
  const offset = input.indexOf(sentinel);
  if (offset < 0) throw new TypeError('UTF8_SENTINEL_MISSING');
  return Buffer.concat([
    input.subarray(0, offset),
    Buffer.from(replacement),
    input.subarray(offset + sentinel.byteLength),
  ]);
}

function expectStableBrokerRawInputError(
  action: () => unknown,
  expectedCode: 'BROKER_HANDSHAKE_INVALID' | 'BROKER_FRAME_INVALID',
  canary?: string,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({
    name: 'ProtocolRawInputError',
    message: expectedCode,
    code: expectedCode,
  });
  const surface = `${String((thrown as { message?: unknown }).message)}\n${JSON.stringify(thrown)}`;
  if (canary !== undefined) expect(surface).not.toContain(canary);
  expect(thrown).not.toHaveProperty('cause');
  expect(thrown).not.toHaveProperty('issues');
  expect(thrown).not.toHaveProperty('input');
}

function versionRejectedFrame(errorCode: string): Record<string, unknown> {
  return {
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    messageId: '0198f00d-4000-7000-8000-000000000031',
    type: 'version.rejected',
    correlationId: '0198f00d-3000-7000-8000-000000000032',
    connectionId: '0198f00d-3000-7000-8000-000000000033',
    sequence: '1',
    sentAt: '2026-08-13T08:00:01.000Z',
    expiresAt: '2026-08-13T08:00:31.000Z',
    lease: {
      deploymentId: '0198f00d-3000-7000-8000-000000000034',
      leaseId: '0198f00d-3000-7000-8000-000000000035',
      workerSessionId: '0198f00d-1111-7111-8111-111111111112',
      fence: '42',
    },
    body: { generation: '1', errorCode },
  };
}

describe('Broker wire byte boundaries', () => {
  it('binds independent wire literals and base fixture digests to both runtime authorities', async () => {
    const corpus = await readCorpus();
    expect(corpus.authorities).toEqual({
      brokerFrameBytes: BROKER_MAX_FRAME_BYTES,
      structuredEvidenceJsonBytes: EVIDENCE_MAX_STRUCTURED_JSON_BYTES,
    });
    expect(corpus.sizeOffsets).toEqual([-1, 0, 1]);
    expect(corpus.paddingByteHex).toBe('20');
    expect(corpus.duplicateKeyOwners).toEqual(['root', 'nested']);
    expect(corpus.structuredEvidenceOwners).toEqual([
      'index',
      'caseResults',
      'testCaseRegistry',
      'manifest',
      'signoff',
      'supportingArtifacts.environment.json',
      'supportingArtifacts.privacy-scan.json',
    ]);

    for (const fixture of corpus.baseFixtures) {
      const bytes = await readFile(new URL(`../../fixtures/${fixture.path}`, import.meta.url));
      expect(sha256(bytes), fixture.path).toBe(fixture.digest);
    }
  });

  it('accepts valid handshake and frame JSON at N-1/N and rejects N+1 before parsing', async () => {
    const corpus = await readCorpus();
    const parsers = [
      ['broker-handshake.v1.json', parseBrokerHandshake],
      ['broker-invocation-prepare.v1.json', parseBrokerFrame],
    ] as const;

    for (const [fixturePath, parser] of parsers) {
      const input = JSON.parse(
        await readFile(new URL(`../../fixtures/${fixturePath}`, import.meta.url), 'utf8'),
      );
      const json = JSON.stringify(input);
      for (const offset of [-1, 0] as const) {
        const bytes = padJsonToBytes(json, corpus.authorities.brokerFrameBytes + offset);
        expect(bytes.byteLength).toBe(corpus.authorities.brokerFrameBytes + offset);
        expect(() => parser(bytes), `${fixturePath}:${offset}`).not.toThrow();
      }
      const oversized = padJsonToBytes(json, corpus.authorities.brokerFrameBytes + 1);
      expect(() => parser(oversized), `${fixturePath}:+1`).toThrow();
    }
  });

  it('SCH-005 rejects every representative malformed UTF-8 class in binary handshake and frame input', async () => {
    const handshake = {
      ...((await readFixture('broker-handshake.v1.json')) as Record<string, unknown>),
      workerVersion: UTF8_SENTINEL,
    };
    const frame = versionRejectedFrame(UTF8_SENTINEL);
    const corpus = await readCorpus();
    for (const malformedHex of corpus.malformedUtf8Hex) {
      const malformed = [...Buffer.from(malformedHex, 'hex')];
      expectStableBrokerRawInputError(
        () =>
          parseBrokerHandshake(replaceUtf8SentinelWithBytes(JSON.stringify(handshake), malformed)),
        'BROKER_HANDSHAKE_INVALID',
      );
      expectStableBrokerRawInputError(
        () => parseBrokerFrame(replaceUtf8SentinelWithBytes(JSON.stringify(frame), malformed)),
        'BROKER_FRAME_INVALID',
      );
    }
  });

  it('preserves string validation, valid binary JSON, duplicate-key and byte-cap behavior', async () => {
    const handshake = {
      ...((await readFixture('broker-handshake.v1.json')) as Record<string, unknown>),
      workerVersion: UTF8_SENTINEL,
    };
    const frame = versionRejectedFrame(UTF8_SENTINEL);
    const handshakeJson = JSON.stringify(handshake);
    const frameJson = JSON.stringify(frame);

    expect(parseBrokerHandshake(Buffer.from(handshakeJson, 'utf8'))).toEqual(
      parseBrokerHandshake(handshakeJson),
    );
    expect(parseBrokerFrame(Buffer.from(frameJson, 'utf8'))).toEqual(parseBrokerFrame(frameJson));
    expectStableBrokerRawInputError(
      () => parseBrokerFrame(Buffer.from('{"protocol":"x","protocol":"y"}', 'utf8')),
      'BROKER_FRAME_INVALID',
    );
    const nestedDuplicateFrame = frameJson.replace(
      '"generation":"1"',
      '"generation":"1","generation":"2"',
    );
    expect(nestedDuplicateFrame).not.toBe(frameJson);
    expectStableBrokerRawInputError(
      () => parseBrokerFrame(nestedDuplicateFrame),
      'BROKER_FRAME_INVALID',
    );
    const duplicateHandshake = handshakeJson.replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    expect(duplicateHandshake).not.toBe(handshakeJson);
    expectStableBrokerRawInputError(
      () => parseBrokerHandshake(duplicateHandshake),
      'BROKER_HANDSHAKE_INVALID',
    );
    expect(() => parseBrokerFrame(new Uint8Array(BROKER_MAX_FRAME_BYTES + 1))).toThrow(/65536/u);

    const handshakeStringWithUnpairedSurrogate = handshakeJson.replace(UTF8_SENTINEL, '\ud800');
    expectStableBrokerRawInputError(
      () => parseBrokerHandshake(handshakeStringWithUnpairedSurrogate),
      'BROKER_HANDSHAKE_INVALID',
    );
    const frameStringWithUnpairedSurrogate = frameJson.replace(UTF8_SENTINEL, '\ud800');
    expectStableBrokerRawInputError(
      () => parseBrokerFrame(frameStringWithUnpairedSurrogate),
      'BROKER_FRAME_INVALID',
    );

    for (const input of [`\ufeff${handshakeJson}`, Buffer.from(`\ufeff${handshakeJson}`, 'utf8')]) {
      expectStableBrokerRawInputError(
        () => parseBrokerHandshake(input),
        'BROKER_HANDSHAKE_INVALID',
      );
    }
    for (const input of [`\ufeff${frameJson}`, Buffer.from(`\ufeff${frameJson}`, 'utf8')]) {
      expectStableBrokerRawInputError(() => parseBrokerFrame(input), 'BROKER_FRAME_INVALID');
    }

    const syntaxCanary = 'BROKER_SYNTAX_CANARY_DO_NOT_ECHO';
    expectStableBrokerRawInputError(
      () => parseBrokerHandshake(`{"${syntaxCanary}":`),
      'BROKER_HANDSHAKE_INVALID',
      syntaxCanary,
    );
    expectStableBrokerRawInputError(
      () => parseBrokerFrame(`{"${syntaxCanary}":`),
      'BROKER_FRAME_INVALID',
      syntaxCanary,
    );
  });
});
