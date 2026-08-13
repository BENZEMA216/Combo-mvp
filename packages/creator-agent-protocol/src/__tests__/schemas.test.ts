import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentVersionManifestSchema, computeAgentVersionDigests } from '../agent-version.js';
import {
  BrokerEnvelopeSchema,
  BrokerHandshakeSchema,
  ExecutionCapabilitySchema,
  ExecutionCapabilityUseRecordSchema,
  decideExecutionCapabilityUse,
  executionCapabilityDigest,
  executionCapabilityBindingFrom,
  executionCapabilitySigningBytes,
  parseBrokerFrame,
  parseBrokerHandshake,
  validateExecutionCapabilityBinding,
  type ExecutionCapability,
} from '../broker.js';
import { EvidenceBundleManifestSchema } from '../evidence.js';
import { Uint63StringSchema, Utf8TextSchema } from '../primitives.js';
import {
  SandboxAttestationSchema,
  SandboxSpecSchema,
  attestationBindingFrom,
  sandboxAttestationSigningBytes,
  validateAttestationBinding,
  type SandboxAttestation,
} from '../sandbox.js';
import {
  isCompressionRatioAllowed,
  SnapshotManifestSchema,
  SnapshotPathSchema,
  snapshotDigest,
} from '../snapshot.js';
import { readFixture, readFixtureText } from './fixture-helpers.js';

function signAttestation(
  attestation: SandboxAttestation,
  privateKey: KeyObject,
): SandboxAttestation {
  const signature = sign('sha256', sandboxAttestationSigningBytes(attestation), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return SandboxAttestationSchema.parse({ ...attestation, supervisorSignature: signature });
}

function signCapability(
  capability: ExecutionCapability,
  privateKey: KeyObject,
): ExecutionCapability {
  const signature = sign('sha256', executionCapabilitySigningBytes(capability), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return ExecutionCapabilitySchema.parse({ ...capability, signature });
}

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
    for (const path of [
      '/etc/passwd',
      '../secret',
      '.env',
      '.ENV.production',
      '.GIT/config',
      '.GITMODULES',
      '.SsH/id_ed25519',
      '.CoDeX/auth.json',
      'Node_Modules/pkg/index.js',
      'a\\b',
      'x\u0000y',
      'x\ty',
      'x\u0085y',
    ]) {
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

  it('普通文字保留 TAB/LF/CR，但拒绝其他 C0/C1 控制字符', () => {
    const schema = Utf8TextSchema(64);
    expect(schema.safeParse('line 1\tvalue\r\nline 2').success).toBe(true);
    for (const rejected of ['a\u0000b', 'a\u0001b', 'a\u001fb', 'a\u007fb', 'a\u0085b']) {
      expect(schema.safeParse(rejected).success, JSON.stringify(rejected)).toBe(false);
    }
  });

  it('Sandbox Attestation 先验 P-256，再校验全部 binding、expiry 与 active registry', async () => {
    expect(SandboxSpecSchema.safeParse(await readFixture('sandbox-spec.v1.json')).success).toBe(
      true,
    );
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const fixture = SandboxAttestationSchema.parse(
      await readFixture('sandbox-attestation.v1.json'),
    );
    const attestation = signAttestation(fixture, keyPair.privateKey);
    const { supervisorSignature: _supervisorSignature, ...unsignedAttestation } = attestation;
    expect(sandboxAttestationSigningBytes(unsignedAttestation)).toEqual(
      sandboxAttestationSigningBytes(attestation),
    );
    const expected = attestationBindingFrom(attestation);
    const now = new Date('2026-08-13T08:01:00Z');
    const active = new Set([`${attestation.sandboxInstanceId}:${attestation.bootNonce}`]);
    expect(
      validateAttestationBinding(attestation, expected, now, active, keyPair.publicKey),
    ).toMatchObject({ ok: true });

    const badSignature = {
      ...attestation,
      supervisorSignature: `${attestation.supervisorSignature[0] === 'A' ? 'B' : 'A'}${attestation.supervisorSignature.slice(1)}`,
    };
    expect(
      validateAttestationBinding(badSignature, expected, now, active, keyPair.publicKey),
    ).toMatchObject({ ok: false, reasons: ['signature'] });

    const otherKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(
      validateAttestationBinding(attestation, expected, now, active, otherKeyPair.publicKey),
    ).toMatchObject({ ok: false, reasons: ['signature'] });

    const mutations: [keyof typeof expected, string][] = [
      ['conversationId', '0198f00d-9999-7999-8999-999999999991'],
      ['workerSessionId', '0198f00d-9999-7999-8999-999999999992'],
      ['agentVersionDigest', '0'.repeat(64)],
      ['behaviorDigest', '4'.repeat(64)],
      ['runtimePolicyDigest', '5'.repeat(64)],
      ['ioContractDigest', '6'.repeat(64)],
      ['codexImageDigest', `sha256:${'7'.repeat(64)}`],
      ['codexVersion', 'different-linux-arm64-codex'],
    ];
    for (const [field, value] of mutations) {
      const resigned = signAttestation({ ...attestation, [field]: value }, keyPair.privateKey);
      expect(
        validateAttestationBinding(
          resigned,
          expected,
          now,
          new Set([`${resigned.sandboxInstanceId}:${resigned.bootNonce}`]),
          keyPair.publicKey,
        ),
        field,
      ).toMatchObject({ ok: false, reasons: [`binding:${field}`] });
    }

    expect(
      validateAttestationBinding(
        attestation,
        { ...expected, invocationId: '0198f00d-9999-7999-8999-999999999999' },
        now,
        active,
        keyPair.publicKey,
      ),
    ).toMatchObject({ ok: false, reasons: ['binding:invocationId'] });
    expect(
      validateAttestationBinding(
        attestation,
        expected,
        new Date('2026-08-13T08:03:00Z'),
        active,
        keyPair.publicKey,
      ),
    ).toMatchObject({ ok: false, reasons: ['expired'] });
  });

  it('Execution Capability 先验 ES256，再校验 nonce/model/budget/request/fence exact binding', async () => {
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const prepare = (await readFixture('broker-invocation-prepare.v1.json')) as {
      body: { executionCapability: unknown };
    };
    const fixture = ExecutionCapabilitySchema.parse(prepare.body.executionCapability);
    const capability = signCapability(fixture, keyPair.privateKey);
    const { signature: _signature, ...unsignedCapability } = capability;
    expect(executionCapabilitySigningBytes(unsignedCapability)).toEqual(
      executionCapabilitySigningBytes(capability),
    );
    const expected = executionCapabilityBindingFrom(capability);
    const now = new Date('2026-08-13T08:01:00Z');
    expect(
      validateExecutionCapabilityBinding(capability, expected, now, new Set(), keyPair.publicKey),
    ).toMatchObject({ ok: true, capabilityDigest: executionCapabilityDigest(capability) });

    const invalidSignature = {
      ...capability,
      signature: `${capability.signature[0] === 'A' ? 'B' : 'A'}${capability.signature.slice(1)}`,
    };
    expect(
      validateExecutionCapabilityBinding(
        invalidSignature,
        expected,
        now,
        new Set(),
        keyPair.publicKey,
      ),
    ).toMatchObject({ ok: false, reasons: ['signature'] });

    const otherKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(
      validateExecutionCapabilityBinding(
        capability,
        expected,
        now,
        new Set(),
        otherKeyPair.publicKey,
      ),
    ).toMatchObject({ ok: false, reasons: ['signature'] });

    const mutations: [keyof typeof expected, unknown][] = [
      ['nonce', 'MDE5OGYwMGQtZGlmZmVyZW50LW5vbmNl'],
      ['model', 'different-model'],
      ['budget', { ...capability.budget, maxOutputTokens: capability.budget.maxOutputTokens + 1 }],
      ['requestDigest', `hmac-sha256:${'1'.repeat(64)}`],
      ['fence', '43'],
      ['conversationId', '0198f00d-9999-7999-8999-999999999993'],
      ['deploymentId', '0198f00d-9999-7999-8999-999999999994'],
    ];
    for (const [field, value] of mutations) {
      const resigned = signCapability({ ...capability, [field]: value }, keyPair.privateKey);
      expect(
        validateExecutionCapabilityBinding(resigned, expected, now, new Set(), keyPair.publicKey),
        field,
      ).toMatchObject({ ok: false, reasons: [`binding:${field}`] });
    }
    expect(
      validateExecutionCapabilityBinding(
        capability,
        expected,
        now,
        new Set([capability.capabilityId]),
        keyPair.publicKey,
      ),
    ).toMatchObject({ ok: false, reasons: ['revoked'] });

    const firstUse = decideExecutionCapabilityUse(capability, null);
    expect(firstUse).toMatchObject({
      action: 'DISPATCH_ONCE',
      nextRecord: { providerUpstreamRequestCount: 1, state: 'DISPATCHED' },
    });
    if (firstUse.action !== 'DISPATCH_ONCE') throw new Error('first use 必须 dispatch');
    expect(decideExecutionCapabilityUse(capability, firstUse.nextRecord)).toMatchObject({
      action: 'RETURN_IN_PROGRESS',
      record: { providerUpstreamRequestCount: 1 },
    });
    for (let replay = 0; replay < 100; replay += 1) {
      expect(decideExecutionCapabilityUse(capability, firstUse.nextRecord)).toMatchObject({
        action: 'RETURN_IN_PROGRESS',
        record: { providerUpstreamRequestCount: 1 },
      });
    }
    const durableRecord = ExecutionCapabilityUseRecordSchema.parse({
      ...firstUse.nextRecord,
      state: 'DURABLE_RESULT',
      resultDigest: `hmac-sha256:${'9'.repeat(64)}`,
    });
    expect(decideExecutionCapabilityUse(capability, durableRecord)).toMatchObject({
      action: 'RETURN_DURABLE_RESULT',
      record: { providerUpstreamRequestCount: 1, resultDigest: `hmac-sha256:${'9'.repeat(64)}` },
    });

    const secondTurnCapability = signCapability(
      {
        ...capability,
        invocationId: '0198f00d-9999-7999-8999-999999999995',
        providerRequestId: '0198f00d-9999-7999-8999-999999999996',
        requestDigest: `hmac-sha256:${'8'.repeat(64)}`,
        nonce: 'MDE5OGYwMGQtc2Vjb25kLXR1cm4tbm9uY2U',
      },
      keyPair.privateKey,
    );
    expect(decideExecutionCapabilityUse(secondTurnCapability, firstUse.nextRecord)).toEqual({
      action: 'SECURITY_BLOCK',
      code: 'CAPABILITY_REUSE_CONFLICT',
    });
    const changedDigest = signCapability(
      { ...capability, requestDigest: `hmac-sha256:${'7'.repeat(64)}` },
      keyPair.privateKey,
    );
    expect(decideExecutionCapabilityUse(changedDigest, firstUse.nextRecord)).toEqual({
      action: 'SECURITY_BLOCK',
      code: 'CAPABILITY_REUSE_CONFLICT',
    });
    expect(
      ExecutionCapabilityUseRecordSchema.safeParse({
        ...firstUse.nextRecord,
        providerUpstreamRequestCount: 2,
      }).success,
    ).toBe(false);
  });

  it('Evidence Bundle manifest fixture 可解析且时间单调', async () => {
    expect(
      EvidenceBundleManifestSchema.safeParse(await readFixture('evidence-bundle-manifest.v1.json'))
        .success,
    ).toBe(true);
  });
});
