import { describe, expect, it } from 'vitest';
import { AgentVersionManifestSchema, computeAgentVersionDigests } from '../agent-version.js';
import {
  BrokerEnvelopeSchema,
  BrokerHandshakeSchema,
  parseBrokerFrame,
  parseBrokerHandshake,
} from '../broker.js';
import { EvidenceBundleManifestSchema } from '../evidence.js';
import { Uint63StringSchema } from '../primitives.js';
import {
  SandboxAttestationSchema,
  SandboxSpecSchema,
  validateAttestationBinding,
} from '../sandbox.js';
import {
  isCompressionRatioAllowed,
  SnapshotManifestSchema,
  SnapshotPathSchema,
  snapshotDigest,
} from '../snapshot.js';
import { readFixture, readFixtureText } from './fixture-helpers.js';

describe('六类共享协议运行时 schema', () => {
  it('解析 Snapshot 和 AgentVersion golden fixtures，并产生稳定 digest', async () => {
    const snapshot = SnapshotManifestSchema.parse(await readFixture('snapshot-manifest.v1.json'));
    const version = AgentVersionManifestSchema.parse(
      await readFixture('agent-version-manifest.v1.json'),
    );
    expect(snapshotDigest(snapshot)).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeAgentVersionDigests(version).versionDigest).toMatch(/^[a-f0-9]{64}$/u);

    const reordered = {
      modelPolicy: version.modelPolicy,
      codexRuntime: version.codexRuntime,
      ioContract: version.ioContract,
      runtimePolicy: version.runtimePolicy,
      behaviorContract: version.behaviorContract,
      snapshotDigest: version.snapshotDigest,
      schemaVersion: 1 as const,
      protocol: 'combo.agent-version-manifest/1' as const,
    };
    expect(computeAgentVersionDigests(reordered).versionDigest).toBe(
      computeAgentVersionDigests(version).versionDigest,
    );
    expect(
      computeAgentVersionDigests({
        ...version,
        behaviorContract: { ...version.behaviorContract, objective: '只改一个语义值' },
      }).versionDigest,
    ).not.toBe(computeAgentVersionDigests(version).versionDigest);
  });

  it('Snapshot 拒绝排序、case-fold collision、危险路径与压缩炸弹', async () => {
    const snapshot = SnapshotManifestSchema.parse(await readFixture('snapshot-manifest.v1.json'));
    expect(
      SnapshotManifestSchema.safeParse({ ...snapshot, files: [...snapshot.files].reverse() })
        .success,
    ).toBe(false);
    const collision = {
      ...snapshot,
      files: [
        { ...snapshot.files[0]!, path: 'A.md' },
        { ...snapshot.files[1]!, path: 'a.md' },
        snapshot.files[2]!,
      ],
    };
    expect(SnapshotManifestSchema.safeParse(collision).success).toBe(false);
    for (const path of ['/etc/passwd', '../secret', '.env', 'a\\b', 'x\u0000y']) {
      expect(SnapshotPathSchema.safeParse(path).success, path).toBe(false);
    }
    expect(isCompressionRatioAllowed(1_000, 100_000)).toBe(true);
    expect(isCompressionRatioAllowed(1_000, 100_001)).toBe(false);
  });

  it('Broker handshake、command、event golden fixtures 都严格解析', async () => {
    const handshakeText = await readFixtureText('broker-handshake.v1.json');
    expect(BrokerHandshakeSchema.parse(JSON.parse(handshakeText)).protocol).toBe(
      'combo.creator-broker/1',
    );
    expect(parseBrokerHandshake(handshakeText).installationId).toMatch(/^[a-f0-9-]{36}$/u);

    for (const fixture of [
      'broker-invocation-prepare.v1.json',
      'broker-invocation-succeeded.v1.json',
    ]) {
      const text = await readFixtureText(fixture);
      expect(BrokerEnvelopeSchema.safeParse(JSON.parse(text)).success, fixture).toBe(true);
      expect(parseBrokerFrame(text).protocol, fixture).toBe('combo.creator-broker/1');
    }
  });

  it('Broker exact keys、重复 JSON key、unknown protocol 与 frame size fail closed', async () => {
    const command = (await readFixture('broker-invocation-prepare.v1.json')) as Record<
      string,
      unknown
    >;
    expect(BrokerEnvelopeSchema.safeParse({ ...command, unexpected: true }).success).toBe(false);
    expect(BrokerEnvelopeSchema.safeParse({ ...command, schemaVersion: 2 }).success).toBe(false);
    expect(() => parseBrokerFrame('{"protocol":"x","protocol":"y"}')).toThrow(/重复 JSON key/u);
    expect(() => parseBrokerFrame(' '.repeat(65_537))).toThrow(/65536/u);
  });

  it('uint63 wire boundary 精确拒绝 number、前导零、符号、exponent 和 overflow', () => {
    for (const accepted of ['0', '9007199254740991', '9007199254740992', '9223372036854775807']) {
      expect(Uint63StringSchema.safeParse(accepted).success, accepted).toBe(true);
    }
    for (const rejected of [-1, 42, '-1', '+1', '01', '1e3', '', '9223372036854775808']) {
      expect(Uint63StringSchema.safeParse(rejected).success, String(rejected)).toBe(false);
    }
  });

  it('Sandbox spec/attestation 与 exact binding、expiry、active registry 联动', async () => {
    expect(SandboxSpecSchema.safeParse(await readFixture('sandbox-spec.v1.json')).success).toBe(
      true,
    );
    const attestation = SandboxAttestationSchema.parse(
      await readFixture('sandbox-attestation.v1.json'),
    );
    const expected = {
      sandboxInstanceId: attestation.sandboxInstanceId,
      conversationId: attestation.conversationId,
      invocationId: attestation.invocationId,
      workerSessionId: attestation.workerSessionId,
      leaseId: attestation.leaseId,
      fencingToken: attestation.fencingToken,
      agentVersionDigest: attestation.agentVersionDigest,
      snapshotDigest: attestation.snapshotDigest,
      protocolSchemaDigest: attestation.protocolSchemaDigest,
      proxyTransportBinding: attestation.proxyTransportBinding,
    };
    const active = new Set([`${attestation.sandboxInstanceId}:${attestation.bootNonce}`]);
    expect(
      validateAttestationBinding(attestation, expected, new Date('2026-08-13T08:01:00Z'), active),
    ).toMatchObject({ ok: true });
    expect(
      validateAttestationBinding(
        attestation,
        { ...expected, invocationId: '0198f00d-9999-7999-8999-999999999999' },
        new Date('2026-08-13T08:01:00Z'),
        active,
      ),
    ).toMatchObject({ ok: false, reasons: ['binding:invocationId'] });
    expect(
      validateAttestationBinding(attestation, expected, new Date('2026-08-13T08:03:00Z'), active),
    ).toMatchObject({ ok: false, reasons: ['expired'] });
  });

  it('Evidence Bundle manifest fixture 可解析且时间单调', async () => {
    expect(
      EvidenceBundleManifestSchema.safeParse(await readFixture('evidence-bundle-manifest.v1.json'))
        .success,
    ).toBe(true);
  });
});
