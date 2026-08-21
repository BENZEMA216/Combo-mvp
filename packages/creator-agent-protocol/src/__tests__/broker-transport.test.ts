import { describe, expect, it } from 'vitest';

import {
  BROKER_TRANSPORT_MAX_FRAME_BYTES,
  BROKER_TRANSPORT_PROTOCOL,
  BrokerTransportFrameSchema,
  BrokerTransportPayloadSchema,
  createBrokerTransportFrame,
  parseBrokerTransportFrame,
  type BrokerTransportBody,
  type BrokerTransportFrameInput,
} from '../broker-transport.js';
import { canonicalizeJson } from '../canonical.js';
import { Sha256DigestSchema } from '../primitives.js';

const fingerprint = Sha256DigestSchema.parse(`sha256:${'a'.repeat(64)}`);

function frameInput(
  body: BrokerTransportBody,
  overrides: Partial<BrokerTransportFrameInput> = {},
): BrokerTransportFrameInput {
  return {
    direction: body.type === 'worker.message' ? 'WORKER_TO_CLOUD' : 'CLOUD_TO_WORKER',
    connectionId: 'connection.001',
    sequence: body.type === 'lease.grant' ? 0 : 1,
    installationId: 'installation.001',
    deploymentId: 'deployment.001',
    workerSessionId: 'session.001',
    leaseId: 'lease.001',
    fence: 7,
    messageId: 'message.001',
    body,
    ...overrides,
  };
}

const grant = {
  type: 'lease.grant',
  leaseExpiresAtMs: 1_787_281_260_000,
} as const;
const command = {
  type: 'command',
  commandType: 'invocation.prepare',
  payload: { invocationId: 'invocation.001', nested: { accepted: true } },
} as const;
const workerMessage = {
  type: 'worker.message',
  messageType: 'invocation.started',
  sourceId: 'fact.started.001',
  sourceFingerprint: fingerprint,
  payload: { invocationId: 'invocation.001' },
} as const;
const persistedAck = {
  type: 'message.ack',
  acknowledgedMessageId: 'command.001',
  acknowledgedSemanticFingerprint: fingerprint,
  acknowledgedWireFingerprint: fingerprint,
  level: 'PERSISTED',
  decision: 'APPLIED',
} as const;
const cloudAck = {
  type: 'message.ack',
  acknowledgedMessageId: 'delivery.001',
  acknowledgedSemanticFingerprint: fingerprint,
  acknowledgedWireFingerprint: fingerprint,
  level: 'CLOUD_COMMITTED',
  decision: 'IDEMPOTENT_REPLAY',
} as const;

describe('Broker transport canonical wire authority', () => {
  it('creates and parses one detached, deeply frozen exact frame', () => {
    const created = createBrokerTransportFrame(frameInput(command));
    expect(created.frame.protocol).toBe(BROKER_TRANSPORT_PROTOCOL);
    expect(created.frame.semanticFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(created.wireFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(created.canonicalText).toBe(canonicalizeJson(created.frame));

    const parsed = parseBrokerTransportFrame(created.canonicalText);
    expect(parsed).toEqual(created);
    expect(parsed.frame).not.toBe(created.frame);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.frame)).toBe(true);
    expect(Object.isFrozen(parsed.frame.body)).toBe(true);
    if (parsed.frame.body.type !== 'command') throw new Error('expected command');
    expect(Object.isFrozen(parsed.frame.body.payload)).toBe(true);
    expect(Object.isFrozen(parsed.frame.body.payload.nested)).toBe(true);
  });

  it('rejects whitespace, property reordering, duplicate keys, and unknown fields', () => {
    const created = createBrokerTransportFrame(frameInput(command));
    expect(() => parseBrokerTransportFrame(` ${created.canonicalText}`)).toThrow(/canonical/u);
    expect(() =>
      parseBrokerTransportFrame(
        (() => {
          const { protocol, ...rest } = created.frame;
          return JSON.stringify({ protocol, ...rest });
        })(),
      ),
    ).toThrow(/canonical/u);
    expect(() =>
      parseBrokerTransportFrame(created.canonicalText.replace('"body":', '"body":{},"body":')),
    ).toThrow(/canonical/u);

    const withUnknown = { ...created.frame, unknown: true };
    expect(() => parseBrokerTransportFrame(canonicalizeJson(withUnknown))).toThrow();
  });

  it('binds semantic identity to messageId/body and wire identity to the whole frame', () => {
    const first = createBrokerTransportFrame(frameInput(workerMessage));
    const reframed = createBrokerTransportFrame(
      frameInput(workerMessage, {
        connectionId: 'connection.002',
        sequence: 9,
        workerSessionId: 'session.002',
        leaseId: 'lease.002',
        fence: 8,
      }),
    );
    expect(reframed.frame.semanticFingerprint).toBe(first.frame.semanticFingerprint);
    expect(reframed.wireFingerprint).not.toBe(first.wireFingerprint);

    const changedMessage = createBrokerTransportFrame(
      frameInput(workerMessage, { messageId: 'message.002' }),
    );
    const changedBody = createBrokerTransportFrame(
      frameInput({ ...workerMessage, payload: { invocationId: 'invocation.002' } }),
    );
    expect(changedMessage.frame.semanticFingerprint).not.toBe(first.frame.semanticFingerprint);
    expect(changedBody.frame.semanticFingerprint).not.toBe(first.frame.semanticFingerprint);

    const firstAck = createBrokerTransportFrame(
      frameInput(persistedAck, {
        direction: 'WORKER_TO_CLOUD',
      }),
    );
    const reboundAck = createBrokerTransportFrame(
      frameInput(
        {
          ...persistedAck,
          acknowledgedSemanticFingerprint: Sha256DigestSchema.parse(`sha256:${'b'.repeat(64)}`),
        },
        {
          direction: 'WORKER_TO_CLOUD',
        },
      ),
    );
    expect(reboundAck.frame.semanticFingerprint).not.toBe(firstAck.frame.semanticFingerprint);
    const rewiredAck = createBrokerTransportFrame(
      frameInput(
        {
          ...persistedAck,
          acknowledgedWireFingerprint: Sha256DigestSchema.parse(`sha256:${'c'.repeat(64)}`),
        },
        { direction: 'WORKER_TO_CLOUD' },
      ),
    );
    expect(rewiredAck.frame.semanticFingerprint).not.toBe(firstAck.frame.semanticFingerprint);

    const tampered = JSON.parse(first.canonicalText) as Record<string, unknown>;
    tampered.messageId = 'message.tampered';
    expect(() => parseBrokerTransportFrame(canonicalizeJson(tampered))).toThrow(
      /semanticFingerprint/u,
    );
  });

  it.each([
    [grant, 'CLOUD_TO_WORKER', 0],
    [command, 'CLOUD_TO_WORKER', 1],
    [workerMessage, 'WORKER_TO_CLOUD', 1],
    [persistedAck, 'WORKER_TO_CLOUD', 1],
    [cloudAck, 'CLOUD_TO_WORKER', 1],
  ] as const)('accepts the exact direction and sequence for %s', (body, direction, sequence) => {
    expect(() =>
      createBrokerTransportFrame(frameInput(body, { direction, sequence })),
    ).not.toThrow();
  });

  it.each([
    [grant, 'WORKER_TO_CLOUD', 0],
    [grant, 'CLOUD_TO_WORKER', 1],
    [command, 'WORKER_TO_CLOUD', 1],
    [command, 'CLOUD_TO_WORKER', 0],
    [workerMessage, 'CLOUD_TO_WORKER', 1],
    [persistedAck, 'CLOUD_TO_WORKER', 1],
    [cloudAck, 'WORKER_TO_CLOUD', 1],
    [cloudAck, 'CLOUD_TO_WORKER', 0],
  ] as const)('rejects a direction/sequence contradiction for %s', (body, direction, sequence) => {
    expect(() => createBrokerTransportFrame(frameInput(body, { direction, sequence }))).toThrow(
      /Direction and sequence/u,
    );
  });

  it('enforces ASCII identifiers, safe integers, strict body fields, and canonical payloads', () => {
    expect(() =>
      createBrokerTransportFrame(frameInput(command, { connectionId: 'bad/id' })),
    ).toThrow();
    expect(() =>
      createBrokerTransportFrame(frameInput(command, { sequence: Number.MAX_SAFE_INTEGER + 1 })),
    ).toThrow();
    expect(() => createBrokerTransportFrame(frameInput(command, { fence: -1 }))).toThrow();
    expect(() =>
      createBrokerTransportFrame(
        frameInput({ ...grant, leaseExpiresAtMs: Number.MAX_SAFE_INTEGER + 1 }),
      ),
    ).toThrow();
    expect(() =>
      createBrokerTransportFrame(
        frameInput({ ...persistedAck, decision: 'SECURITY_BLOCK' } as never),
      ),
    ).toThrow();
    expect(() =>
      createBrokerTransportFrame(
        frameInput({
          ...persistedAck,
          acknowledgedSemanticFingerprint: fingerprint.slice(1),
        } as never),
      ),
    ).toThrow();
    const { acknowledgedSemanticFingerprint: _missing, ...ackWithoutBinding } = persistedAck;
    expect(() => createBrokerTransportFrame(frameInput(ackWithoutBinding as never))).toThrow();
    const { acknowledgedWireFingerprint: _wire, ...ackWithoutWireBinding } = persistedAck;
    expect(() => createBrokerTransportFrame(frameInput(ackWithoutWireBinding as never))).toThrow();
    expect(() =>
      createBrokerTransportFrame(frameInput({ ...command, extra: true } as never)),
    ).toThrow();
    expect(() =>
      createBrokerTransportFrame(frameInput({ ...command, payload: [] } as never)),
    ).toThrow();
    expect(() =>
      createBrokerTransportFrame(
        frameInput({ ...command, payload: { value: undefined } } as never),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createBrokerTransportFrame(frameInput({ ...command, payload: { value: '\ud800' } } as never)),
    ).toThrow();
  });

  it('rejects accessors before invoking them', () => {
    let reads = 0;
    const payload = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'forbidden';
      },
    });
    expect(() => createBrokerTransportFrame(frameInput({ ...command, payload } as never))).toThrow(
      /data property/u,
    );
    expect(reads).toBe(0);
  });

  it('rejects prototype-sensitive payload keys instead of normalizing them away', () => {
    const payload = JSON.parse('{"__proto__":{"admin":true}}') as Record<string, unknown>;
    expect(BrokerTransportPayloadSchema.safeParse(payload).success).toBe(false);
    expect(
      BrokerTransportPayloadSchema.safeParse(
        JSON.parse('{"constructor":{},"prototype":{}}') as unknown,
      ).success,
    ).toBe(false);
    expect(() => createBrokerTransportFrame(frameInput({ ...command, payload } as never))).toThrow(
      /prototype-sensitive/u,
    );

    const benign = createBrokerTransportFrame(frameInput({ ...command, payload: {} }));
    const malicious = benign.canonicalText.replace(
      '"payload":{}',
      '"payload":{"__proto__":{"admin":true}}',
    );
    expect(() => parseBrokerTransportFrame(malicious)).toThrow(/prototype-sensitive/u);
  });

  it('accepts exactly 65536 UTF-8 bytes and rejects the next byte', () => {
    const empty = createBrokerTransportFrame(frameInput({ ...command, payload: { text: '' } }));
    const remaining = BROKER_TRANSPORT_MAX_FRAME_BYTES - Buffer.byteLength(empty.canonicalText);
    const exact = createBrokerTransportFrame(
      frameInput({ ...command, payload: { text: 'x'.repeat(remaining) } }),
    );
    expect(Buffer.byteLength(exact.canonicalText)).toBe(BROKER_TRANSPORT_MAX_FRAME_BYTES);
    expect(() =>
      createBrokerTransportFrame(
        frameInput({ ...command, payload: { text: 'x'.repeat(remaining + 1) } }),
      ),
    ).toThrow(/65536/u);
    expect(() => parseBrokerTransportFrame('x'.repeat(65_537))).toThrow(RangeError);
  });

  it('keeps the Broker subpath authority out of the root consumer surface', async () => {
    const root = await import('../index.js');
    expect(root).not.toHaveProperty('createBrokerTransportFrame');
    expect(root).not.toHaveProperty('BrokerTransportFrameSchema');
    expect(BrokerTransportFrameSchema.safeParse({}).success).toBe(false);
  });
});
