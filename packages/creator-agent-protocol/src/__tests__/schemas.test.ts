import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
// VNext registry cases: SCH-001 SCH-002 SCH-003 SCH-005 SCH-008
import { describe, expect, it } from 'vitest';
import { AgentVersionManifestSchema, computeAgentVersionDigests } from '../agent-version.js';
import { canonicalSha256, canonicalizeJson } from '../canonical.js';
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
import {
  EvidenceBundleIndexSchema,
  EvidenceBundleManifestSchema,
  EvidenceCaseResultSchema,
  EvidenceEnvironmentSchema,
  EvidenceEnvironmentsSchema,
  EvidencePrivacyScanSchema,
  EvidenceReviewerSignoffSchema,
  EvidenceSupportingArtifactPathSchema,
  evidenceBundleIndexDigest,
  evidenceBundleManifestDigest,
  evidencePrivacyScanScopeDigest,
  evidenceReleaseTupleDigest,
  evidenceReviewerSigningBytes,
  evidenceTestSuiteDigest,
  validateEvidenceBundleChain,
  validateEvidenceReviewerSignoff,
  type EvidenceReviewerSignoff,
} from '../evidence.js';
import {
  IsoDateTimeSchema,
  Uint63StringSchema,
  Utf8TextSchema,
  UuidSchema,
} from '../primitives.js';
import { TestCaseRegistrySchema } from '../registry.js';
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

function signEvidenceReview(
  review: EvidenceReviewerSignoff,
  privateKey: KeyObject,
): EvidenceReviewerSignoff {
  const signature = sign('sha256', evidenceReviewerSigningBytes(review), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return EvidenceReviewerSignoffSchema.parse({ ...review, signature });
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

  it('Broker sensitive payload binds AEAD bytes and exact invocation/envelope context', async () => {
    const prepare = (await readFixture('broker-invocation-prepare.v1.json')) as {
      body: {
        userMessageCiphertext: {
          ciphertext: string;
          aad: { invocationId: string };
        };
      };
    };
    const succeeded = (await readFixture('broker-invocation-succeeded.v1.json')) as {
      lease: { workerSessionId: string };
      body: { conversationId: string; resultCiphertext: unknown };
    };

    const wrongInvocation = structuredClone(prepare);
    wrongInvocation.body.userMessageCiphertext.aad.invocationId =
      '0198f00d-9999-7999-8999-999999999999';
    expect(BrokerEnvelopeSchema.safeParse(wrongInvocation).success).toBe(false);

    const changedCiphertext = structuredClone(prepare);
    const originalCiphertext = changedCiphertext.body.userMessageCiphertext.ciphertext;
    changedCiphertext.body.userMessageCiphertext.ciphertext = `${
      originalCiphertext[0] === 'A' ? 'B' : 'A'
    }${originalCiphertext.slice(1)}`;
    expect(BrokerEnvelopeSchema.safeParse(changedCiphertext).success).toBe(false);

    const crossEnvelopeReplay = structuredClone(succeeded);
    crossEnvelopeReplay.body.resultCiphertext = structuredClone(prepare.body.userMessageCiphertext);
    expect(BrokerEnvelopeSchema.safeParse(crossEnvelopeReplay).success).toBe(false);

    const wrongResponseConversation = structuredClone(succeeded);
    wrongResponseConversation.body.conversationId = '0198f00d-9999-7999-8999-999999999998';
    expect(BrokerEnvelopeSchema.safeParse(wrongResponseConversation).success).toBe(false);

    const wrongWorkerSession = structuredClone(succeeded);
    wrongWorkerSession.lease.workerSessionId = '0198f00d-9999-7999-8999-999999999997';
    expect(BrokerEnvelopeSchema.safeParse(wrongWorkerSession).success).toBe(false);
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

  it('all wire timestamps use canonical UTC with exactly millisecond precision', () => {
    expect(IsoDateTimeSchema.safeParse('2026-08-13T08:00:00.000Z').success).toBe(true);
    for (const rejected of [
      '2026-08-13T08:00:00Z',
      '2026-08-13T08:00:00.00Z',
      '2026-08-13T08:00:00.0000Z',
      '2026-08-13T16:00:00.000+08:00',
    ]) {
      expect(IsoDateTimeSchema.safeParse(rejected).success, rejected).toBe(false);
    }
  });

  it('all opaque wire IDs use canonical lowercase UUIDv7', () => {
    const id = '0198f00d-6000-7000-8000-000000000001';
    expect(UuidSchema.safeParse(id).success).toBe(true);
    expect(UuidSchema.safeParse(id.toUpperCase()).success).toBe(false);
    expect(UuidSchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(false);
    expect(UuidSchema.safeParse('0198f00d-6000-7000-7000-000000000001').success).toBe(false);
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

  it('Evidence Bundle manifest/index/environment/result/signoff fixtures 严格解析', async () => {
    const manifest = EvidenceBundleManifestSchema.parse(
      await readFixture('evidence-bundle-manifest.v1.json'),
    );
    const index = EvidenceBundleIndexSchema.parse(
      await readFixture('evidence-bundle-index.v1.json'),
    );
    expect(evidenceBundleIndexDigest(index)).toBe(manifest.artifactIndexDigest);
    expect(index.artifacts.map((artifact) => artifact.path)).not.toContain('manifest.json');
    expect(index.artifacts.map((artifact) => artifact.path)).not.toContain('reviewer-signoff.json');
    const environment = EvidenceEnvironmentSchema.parse(
      await readFixture('evidence-environment.v1.json'),
    );
    expect(
      EvidenceEnvironmentsSchema.safeParse(await readFixture('evidence-environments.v1.json'))
        .success,
    ).toBe(true);
    expect(
      EvidencePrivacyScanSchema.safeParse(await readFixture('evidence-privacy-scan.v1.json'))
        .success,
    ).toBe(true);
    expect(
      EvidenceEnvironmentSchema.safeParse({
        ...environment,
        substitutedComponents: [...environment.substitutedComponents].reverse(),
      }).success,
    ).toBe(false);
    expect(
      EvidenceBundleIndexSchema.safeParse({
        ...index,
        artifacts: [...index.artifacts].reverse(),
      }).success,
    ).toBe(false);
    const result = await readFixture('evidence-case-result.v1.json');
    expect(EvidenceCaseResultSchema.safeParse(result).success).toBe(true);
    expect(
      EvidenceCaseResultSchema.safeParse({
        ...(result as Record<string, unknown>),
        status: 'PASS',
        assertionCount: 0,
      }).success,
    ).toBe(false);
    expect(
      EvidenceCaseResultSchema.safeParse({
        ...(result as Record<string, unknown>),
        status: 'PASS',
        artifactDigests: [],
      }).success,
    ).toBe(false);
    expect(
      EvidenceBundleIndexSchema.safeParse({
        ...index,
        artifacts: index.artifacts.map((artifact, indexPosition) =>
          indexPosition === 0 ? { ...artifact, bytes: 0 } : artifact,
        ),
      }).success,
    ).toBe(false);
    const signoff = EvidenceReviewerSignoffSchema.parse(
      await readFixture('evidence-reviewer-signoff.v1.json'),
    ) satisfies EvidenceReviewerSignoff;
    expect(signoff.manifestDigest).toBe(evidenceBundleManifestDigest(manifest));
    expect(manifest.results).toEqual({ pass: 7, fail: 0, blocked: 0, notRun: 59 });
    expect(signoff.verdict).toBe('BLOCKED');
    const reviewerPublicKey = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAENUe+OQgcgEmgbFDlfd9/cZjZPq9l
h6QkoGPwYui0+ZMdS6RsuAIK5/GZVL2mLvj3oJH9oMWoC7VdzF+SE9iduQ==
-----END PUBLIC KEY-----`;
    const expected = {
      rcId: signoff.rcId,
      manifestDigest: signoff.manifestDigest,
      reviewerKeyId: signoff.reviewerKeyId,
      reviewedGates: signoff.reviewedGates,
    };
    expect(
      validateEvidenceReviewerSignoff(signoff, expected, reviewerPublicKey, new Set()),
    ).toEqual({ ok: true });
    expect(
      validateEvidenceReviewerSignoff(
        { ...signoff, manifestDigest: `sha256:${'f'.repeat(64)}` },
        expected,
        reviewerPublicKey,
        new Set(),
      ),
    ).toMatchObject({ ok: false, reasons: ['signature'] });
    expect(
      validateEvidenceReviewerSignoff(
        signoff,
        expected,
        reviewerPublicKey,
        new Set([signoff.reviewerKeyId]),
      ),
    ).toMatchObject({ ok: false, reasons: ['reviewer-key-revoked'] });

    const provisionalArtifactBytes = Object.fromEntries(
      EvidenceSupportingArtifactPathSchema.options
        .filter((path) => path !== 'environment.json' && path !== 'privacy-scan.json')
        .map((path) => [path, Buffer.from(`synthetic evidence artifact for ${path}\n`, 'utf8')]),
    ) as Record<string, Uint8Array>;
    const provisionalArtifacts = EvidenceSupportingArtifactPathSchema.options
      .filter((path) => path !== 'environment.json' && path !== 'privacy-scan.json')
      .map((path) => {
        const bytes = provisionalArtifactBytes[path]!;
        return {
          path,
          bytes: bytes.byteLength,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        };
      });
    const environmentSummary = {
      protocol: 'combo.vnext-evidence-bundle/1',
      schemaVersion: 1,
      environments: [environment],
    };
    const environmentBytes = Buffer.from(canonicalizeJson(environmentSummary), 'utf8');
    const environmentArtifact = {
      path: 'environment.json' as const,
      bytes: environmentBytes.byteLength,
      digest: `sha256:${createHash('sha256').update(environmentBytes).digest('hex')}`,
    };
    const artifactsBeforePrivacy = [environmentArtifact, ...provisionalArtifacts];
    const privacyScan = {
      protocol: 'combo.vnext-evidence-bundle/1',
      schemaVersion: 1,
      rcId: manifest.rcId,
      scannerId: 'evidence-privacy-scanner',
      scannerVersion: '1.0.0',
      scannedArtifacts: artifactsBeforePrivacy.map(({ path, digest }) => ({ path, digest })),
      scopeDigest: evidencePrivacyScanScopeDigest(
        artifactsBeforePrivacy.map(({ path, digest }) => ({ path, digest })),
      ),
      findingCounts: {
        credentials: 0,
        authorizationMaterial: 0,
        consumerPlaintext: 0,
        creatorProjectContent: 0,
        absolutePaths: 0,
        hiddenReasoning: 0,
        rawRuntimeEvents: 0,
        realThreadTurnIds: 0,
      },
      totalForbiddenFindings: 0,
      status: 'CLEAN',
      scannedAt: '2026-08-13T09:00:00.000Z',
    };
    const privacyScanBytes = Buffer.from(canonicalizeJson(privacyScan), 'utf8');
    const privacyArtifact = {
      path: 'privacy-scan.json' as const,
      bytes: privacyScanBytes.byteLength,
      digest: `sha256:${createHash('sha256').update(privacyScanBytes).digest('hex')}`,
    };
    const liveIndex = EvidenceBundleIndexSchema.parse({
      ...index,
      artifacts: [...artifactsBeforePrivacy, privacyArtifact],
    });
    const supportingArtifacts = {
      ...provisionalArtifactBytes,
      'environment.json': environmentBytes,
      'privacy-scan.json': privacyScanBytes,
    } as unknown as Record<
      (typeof EvidenceSupportingArtifactPathSchema.options)[number],
      Uint8Array
    >;
    const liveTestCaseRegistry = TestCaseRegistrySchema.parse({
      protocol: 'combo.vnext-test-registry/1',
      schemaVersion: 1,
      cases: [
        {
          id: 'SCH-001',
          title: 'synthetic evidence-chain contract case',
          level: 'E1',
          environment: 'T0-LINUX-CI',
          invariants: ['INV-001'],
          fixture: ['synthetic-artifact'],
          fault: [],
          steps: ['verify the complete evidence chain'],
          assertions: ['all artifact bytes and case results are digest-bound'],
          evidence: ['synthetic evidence artifact'],
          frequency: 'every-pr',
          owner: 'Protocol',
          reviewer: 'Independent Verifier',
          gate: 'G0',
          implementation: {
            status: 'implemented',
            testFiles: ['packages/creator-agent-protocol/src/__tests__/schemas.test.ts'],
          },
          releaseTuple: ['sourceSha'],
          fixtureDigests: [liveIndex.artifacts[0]!.digest],
        },
      ],
    });
    const manifestWithAuthority = EvidenceBundleManifestSchema.parse({
      ...manifest,
      artifactIndexDigest: evidenceBundleIndexDigest(liveIndex),
      testCaseRegistryDigest: `sha256:${canonicalSha256(liveTestCaseRegistry)}`,
      results: { pass: 1, fail: 0, blocked: 0, notRun: 0 },
    });
    const liveResult = EvidenceCaseResultSchema.parse({
      ...(result as Record<string, unknown>),
      evidenceLevel: 'E1',
      environmentId: 'T0-LINUX-CI',
      releaseTupleDigest: evidenceReleaseTupleDigest(manifestWithAuthority),
      artifactDigests: [liveIndex.artifacts[0]!.digest],
    });
    const liveManifest = EvidenceBundleManifestSchema.parse({
      ...manifestWithAuthority,
      testSuiteDigest: evidenceTestSuiteDigest([liveResult]),
    });
    const liveReviewerKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const unsignedLiveSignoff = EvidenceReviewerSignoffSchema.parse({
      ...signoff,
      manifestDigest: evidenceBundleManifestDigest(liveManifest),
      reviewerKeyId: 'reviewer-key-live-001',
      verdict: 'PASS',
      reviewedGates: ['G0'],
      signature: 'A'.repeat(86),
    });
    const liveSignoff = signEvidenceReview(unsignedLiveSignoff, liveReviewerKeys.privateKey);
    const liveExpected = {
      rcId: liveSignoff.rcId,
      manifestDigest: liveSignoff.manifestDigest,
      reviewerKeyId: liveSignoff.reviewerKeyId,
      reviewedGates: liveSignoff.reviewedGates,
    };
    expect(
      validateEvidenceBundleChain({
        index: liveIndex,
        supportingArtifacts,
        caseResults: [liveResult],
        testCaseRegistry: liveTestCaseRegistry,
        manifest: liveManifest,
        signoff: liveSignoff,
        expected: liveExpected,
        registeredReviewerPublicKey: liveReviewerKeys.publicKey,
        revokedReviewerKeyIds: new Set(),
      }),
    ).toEqual({ ok: true });

    expect(
      validateEvidenceBundleChain({
        index: liveIndex,
        supportingArtifacts,
        caseResults: [{ ...liveResult, evidenceLevel: 'E0' }],
        testCaseRegistry: liveTestCaseRegistry,
        manifest: liveManifest,
        signoff: liveSignoff,
        expected: liveExpected,
        registeredReviewerPublicKey: liveReviewerKeys.publicKey,
        revokedReviewerKeyIds: new Set(),
      }),
    ).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['case:SCH-001:evidenceLevel', 'testSuiteDigest']),
    });

    expect(
      validateEvidenceBundleChain({
        index: liveIndex,
        supportingArtifacts,
        caseResults: [{ ...liveResult, releaseTupleDigest: `sha256:${'0'.repeat(64)}` }],
        testCaseRegistry: liveTestCaseRegistry,
        manifest: liveManifest,
        signoff: liveSignoff,
        expected: liveExpected,
        registeredReviewerPublicKey: liveReviewerKeys.publicKey,
        revokedReviewerKeyIds: new Set(),
      }),
    ).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['case:SCH-001:releaseTupleDigest', 'testSuiteDigest']),
    });

    const wrongGateRegistry = TestCaseRegistrySchema.parse({
      ...liveTestCaseRegistry,
      cases: [{ ...liveTestCaseRegistry.cases[0]!, gate: 'G8' }],
    });
    expect(
      validateEvidenceBundleChain({
        index: liveIndex,
        supportingArtifacts,
        caseResults: [liveResult],
        testCaseRegistry: wrongGateRegistry,
        manifest: liveManifest,
        signoff: liveSignoff,
        expected: liveExpected,
        registeredReviewerPublicKey: liveReviewerKeys.publicKey,
        revokedReviewerKeyIds: new Set(),
      }),
    ).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['testCaseRegistryDigest', 'reviewedGates']),
    });

    const plannedRegistry = TestCaseRegistrySchema.parse({
      ...liveTestCaseRegistry,
      cases: [
        {
          ...liveTestCaseRegistry.cases[0]!,
          implementation: { status: 'planned', testFiles: [] },
        },
      ],
    });
    expect(
      validateEvidenceBundleChain({
        index: liveIndex,
        supportingArtifacts,
        caseResults: [liveResult],
        testCaseRegistry: plannedRegistry,
        manifest: liveManifest,
        signoff: liveSignoff,
        expected: liveExpected,
        registeredReviewerPublicKey: liveReviewerKeys.publicKey,
        revokedReviewerKeyIds: new Set(),
      }),
    ).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['testCaseRegistryDigest', 'case:SCH-001:planned-result']),
    });

    const uncleanPrivacyScan = {
      ...privacyScan,
      findingCounts: { ...privacyScan.findingCounts, credentials: 1 },
      totalForbiddenFindings: 1,
      status: 'FINDINGS',
    };
    const uncleanPrivacyScanBytes = Buffer.from(canonicalizeJson(uncleanPrivacyScan), 'utf8');
    const uncleanPrivacyArtifact = {
      path: 'privacy-scan.json' as const,
      bytes: uncleanPrivacyScanBytes.byteLength,
      digest: `sha256:${createHash('sha256').update(uncleanPrivacyScanBytes).digest('hex')}`,
    };
    const uncleanIndex = EvidenceBundleIndexSchema.parse({
      ...liveIndex,
      artifacts: [...artifactsBeforePrivacy, uncleanPrivacyArtifact],
    });
    const uncleanManifest = EvidenceBundleManifestSchema.parse({
      ...liveManifest,
      artifactIndexDigest: evidenceBundleIndexDigest(uncleanIndex),
    });
    const unsignedUncleanSignoff = EvidenceReviewerSignoffSchema.parse({
      ...liveSignoff,
      manifestDigest: evidenceBundleManifestDigest(uncleanManifest),
      signature: 'A'.repeat(86),
    });
    const uncleanSignoff = signEvidenceReview(unsignedUncleanSignoff, liveReviewerKeys.privateKey);
    expect(
      validateEvidenceBundleChain({
        index: uncleanIndex,
        supportingArtifacts: {
          ...supportingArtifacts,
          'privacy-scan.json': uncleanPrivacyScanBytes,
        },
        caseResults: [liveResult],
        testCaseRegistry: liveTestCaseRegistry,
        manifest: uncleanManifest,
        signoff: uncleanSignoff,
        expected: {
          ...liveExpected,
          manifestDigest: uncleanSignoff.manifestDigest,
        },
        registeredReviewerPublicKey: liveReviewerKeys.publicKey,
        revokedReviewerKeyIds: new Set(),
      }),
    ).toMatchObject({
      ok: false,
      reasons: ['verdict'],
    });

    const omittedCaseRegistry = TestCaseRegistrySchema.parse({
      ...liveTestCaseRegistry,
      cases: [...liveTestCaseRegistry.cases, { ...liveTestCaseRegistry.cases[0]!, id: 'SCH-002' }],
    });
    expect(
      validateEvidenceBundleChain({
        index: liveIndex,
        supportingArtifacts,
        caseResults: [liveResult],
        testCaseRegistry: omittedCaseRegistry,
        manifest: liveManifest,
        signoff: liveSignoff,
        expected: liveExpected,
        registeredReviewerPublicKey: liveReviewerKeys.publicKey,
        revokedReviewerKeyIds: new Set(),
      }),
    ).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['testCaseRegistryDigest', 'testCaseCoverage']),
    });

    const replacedSummary = {
      ...supportingArtifacts,
      'metrics-summary.json': Buffer.from(supportingArtifacts['metrics-summary.json']),
    };
    replacedSummary['metrics-summary.json'][0] = replacedSummary['metrics-summary.json'][0]! ^ 0xff;
    expect(
      validateEvidenceBundleChain({
        index: liveIndex,
        supportingArtifacts: replacedSummary,
        caseResults: [liveResult],
        testCaseRegistry: liveTestCaseRegistry,
        manifest: liveManifest,
        signoff: liveSignoff,
        expected: liveExpected,
        registeredReviewerPublicKey: liveReviewerKeys.publicKey,
        revokedReviewerKeyIds: new Set(),
      }),
    ).toMatchObject({ ok: false, reasons: ['artifact:metrics-summary.json:digest'] });

    expect(
      validateEvidenceBundleChain({
        index: liveIndex,
        supportingArtifacts,
        caseResults: [{ ...liveResult, assertionCount: liveResult.assertionCount + 1 }],
        testCaseRegistry: liveTestCaseRegistry,
        manifest: liveManifest,
        signoff: liveSignoff,
        expected: liveExpected,
        registeredReviewerPublicKey: liveReviewerKeys.publicKey,
        revokedReviewerKeyIds: new Set(),
      }),
    ).toMatchObject({ ok: false, reasons: ['testSuiteDigest'] });

    expect(
      validateEvidenceBundleChain({
        index: liveIndex,
        supportingArtifacts,
        caseResults: [liveResult],
        testCaseRegistry: liveTestCaseRegistry,
        manifest: {
          ...liveManifest,
          results: { pass: 0, fail: 0, blocked: 0, notRun: 1 },
        },
        signoff: liveSignoff,
        expected: liveExpected,
        registeredReviewerPublicKey: liveReviewerKeys.publicKey,
        revokedReviewerKeyIds: new Set(),
      }),
    ).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['manifestDigest', 'resultCounts', 'verdict']),
    });
  });
});
