import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
// VNext registry cases: SCH-001 SCH-002 SCH-003 SCH-005 SCH-008
import { describe, expect, it } from 'vitest';
import { AgentVersionManifestSchema, computeAgentVersionDigests } from '../agent-version.js';
import { currentBrokerContractDigest } from '../artifacts.js';
import { canonicalSha256, canonicalizeJson } from '../canonical.js';
import { ProtocolVersionCorpusSchema } from '../compatibility.js';
import {
  BrokerConversationOpenCommandSchema,
  BrokerEnvelopeSchema,
  BrokerHandshakeSchema,
  BrokerHandshakeUnsignedSchema,
  BROKER_MAX_FRAME_BYTES,
  BROKER_MAX_SENSITIVE_CIPHERTEXT_BYTES,
  BrokerRegistrationCapabilitiesSchema,
  BrokerAuthenticationError,
  BrokerAuthenticationFailureCode,
  BrokerCloseCode,
  BrokerCloseReason,
  ExecutionCapabilitySchema,
  ExecutionCapabilityUseRecordSchema,
  decideExecutionCapabilityUse,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  brokerConversationOpenLogicalCommand,
  brokerConversationOpenLogicalDigest,
  brokerHandshakeSigningBytes,
  classifyBrokerRemoteClose,
  executionCapabilityDigest,
  executionCapabilityBindingFrom,
  executionCapabilitySigningBytes,
  parseBrokerFrame,
  parseBrokerHandshake,
  validateExecutionCapabilityBinding,
  type ExecutionCapability,
} from '../broker.js';
import {
  EVIDENCE_MAX_STRUCTURED_JSON_BYTES,
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
  type EvidenceBundleChainInput,
  type EvidenceReviewerSignoff,
} from '../evidence.js';
import {
  WorkerInvocationSucceededFactObjectSchema,
  workerInvocationFactDigest,
} from '../invocation-facts.js';
import {
  SnapshotPublicationCommitMarkerSchema,
  SnapshotPublicationPreparationMarkerSchema,
  DeploymentGenerationEtagSchema,
  LastEventIdSchema,
  PublicAgentSlugSchema,
  SnapshotUploadCreateRequestSchema,
  SnapshotUploadCreateResponseSchema,
  parseSnapshotPublicationCommitMarker,
  parseSnapshotPublicationPreparationMarker,
  snapshotPublicationCommitMarkerBytes,
  snapshotPublicationPreparationDigest,
  snapshotPublicationPreparationMarkerBytes,
} from '../http.js';
import { VnextErrorResponseSchema, errorResponseFor } from '../invocation.js';
import {
  IsoDateTimeSchema,
  UnicodeCodePointStringSchema,
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
  SnapshotArchiveEnvelopeSchema,
  SnapshotManifestEnvelopeSchema,
  SnapshotManifestSchema,
  SnapshotPathSchema,
  snapshotArchiveEnvelopeAadBytes,
  snapshotArchiveEnvelopeAadDigest,
  snapshotDigest,
  snapshotManifestEnvelopeAadDigest,
  snapshotManifestObjectKey,
  snapshotPublicationPreparationObjectKey,
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

type EvidenceBundleChainObjectInput = Omit<
  EvidenceBundleChainInput,
  'index' | 'caseResults' | 'testCaseRegistry' | 'manifest' | 'signoff'
> & {
  readonly index: unknown;
  readonly caseResults: unknown;
  readonly testCaseRegistry: unknown;
  readonly manifest: unknown;
  readonly signoff: unknown;
};

function evidenceJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalizeJson(value), 'utf8');
}

function evidenceBundleChainBytes(input: EvidenceBundleChainObjectInput): EvidenceBundleChainInput {
  return {
    ...input,
    index: evidenceJsonBytes(input.index),
    caseResults: evidenceJsonBytes(input.caseResults),
    testCaseRegistry: evidenceJsonBytes(input.testCaseRegistry),
    manifest: evidenceJsonBytes(input.manifest),
    signoff: evidenceJsonBytes(input.signoff),
  };
}

function expectStableRawInputError(
  action: () => unknown,
  expectedCode:
    | 'BROKER_HANDSHAKE_INVALID'
    | 'BROKER_FRAME_INVALID'
    | 'SNAPSHOT_PREPARATION_MARKER_INVALID'
    | 'SNAPSHOT_COMMIT_MARKER_INVALID',
  canary?: string,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  const surface = `${String((thrown as { message?: unknown }).message)}\n${JSON.stringify(thrown)}`;
  if (canary !== undefined) expect(surface).not.toContain(canary);
  expect(thrown).toMatchObject({
    name: 'ProtocolRawInputError',
    message: expectedCode,
    code: expectedCode,
  });
  expect(thrown).not.toHaveProperty('cause');
  expect(thrown).not.toHaveProperty('issues');
  expect(thrown).not.toHaveProperty('input');
}

function validateEvidenceBundleChainObjects(input: EvidenceBundleChainObjectInput) {
  return validateEvidenceBundleChain(evidenceBundleChainBytes(input));
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

  it('parses the Snapshot archive Envelope golden and freezes canonical AAD bytes', async () => {
    const envelope = SnapshotArchiveEnvelopeSchema.parse(
      await readFixture('snapshot-envelope.v1.json'),
    );
    expect(snapshotArchiveEnvelopeAadDigest(envelope.aad)).toBe(
      '66583db71c725d152aef1224efbb0095c438927c67da51e1db750871dbeeaff9',
    );
    expect(snapshotArchiveEnvelopeAadBytes(envelope.aad).toString('utf8')).toBe(
      '{"archiveDigest":"59b430c694a6b4dc0faf03d1aaaab29a2dfb083c00a1fe9916afd5e532431378","cipherObjectFormat":"combo.snapshot-binary/1","creatorId":"0198f00d-8000-7000-8000-000000000001","keyId":"combo-kek/test-2026-08","objectKey":"creators/0198f00d-8000-7000-8000-000000000001/snapshots/sha256/05/05b3abf2579a5eb66403cd78be557fd860633a1fe2103c7642030defe32c657f.tar.zst.enc","plaintextBytes":37,"protocol":"combo.snapshot-envelope/1","schemaVersion":1,"snapshotDigest":"05b3abf2579a5eb66403cd78be557fd860633a1fe2103c7642030defe32c657f"}',
    );
    for (const mutation of [
      { ...envelope, schemaVersion: 2 },
      { ...envelope, unexpected: true },
      { ...envelope, cipherBytes: envelope.cipherBytes + 1 },
      { ...envelope, aadDigest: '0'.repeat(64) },
      { ...envelope, nonce: `${envelope.nonce}=` },
      { ...envelope, nonce: Buffer.alloc(11).toString('base64url') },
      { ...envelope, authTag: Buffer.alloc(15).toString('base64url') },
      { ...envelope, wrappedDek: Buffer.alloc(39).toString('base64url') },
      {
        ...envelope,
        aad: {
          ...envelope.aad,
          objectKey: `${envelope.aad.objectKey}.wrong`,
        },
      },
    ]) {
      expect(SnapshotArchiveEnvelopeSchema.safeParse(mutation).success).toBe(false);
    }
  });

  it('parses the independent encrypted manifest Envelope and freezes its AAD identity', async () => {
    const envelope = SnapshotManifestEnvelopeSchema.parse(
      await readFixture('snapshot-manifest-envelope.v1.json'),
    );
    expect(snapshotManifestEnvelopeAadDigest(envelope.aad)).toBe(
      'a73a5f805e2eed35f94233bcf305e3f2f0dde98b3696fd34b8e5aecacd36f014',
    );
    expect(envelope.aad.objectKey).toBe(
      snapshotManifestObjectKey(envelope.aad.creatorId, envelope.aad.snapshotDigest),
    );
    for (const mutation of [
      { ...envelope, schemaVersion: 2 },
      { ...envelope, unexpected: true },
      { ...envelope, cipherBytes: envelope.cipherBytes + 1 },
      { ...envelope, aadDigest: '0'.repeat(64) },
      { ...envelope, nonce: `${envelope.nonce}=` },
      {
        ...envelope,
        aad: { ...envelope.aad, objectKey: `${envelope.aad.objectKey}.wrong` },
      },
    ]) {
      expect(SnapshotManifestEnvelopeSchema.safeParse(mutation).success).toBe(false);
    }
  });

  it('requires both encrypted objects before upload session creation and returns two exact PUTs', async () => {
    const archive = SnapshotArchiveEnvelopeSchema.parse(
      await readFixture('snapshot-envelope.v1.json'),
    );
    const manifestFixture = SnapshotManifestEnvelopeSchema.parse(
      await readFixture('snapshot-manifest-envelope.v1.json'),
    );
    const manifestAad = {
      ...manifestFixture.aad,
      creatorId: archive.aad.creatorId,
      snapshotDigest: archive.aad.snapshotDigest,
      objectKey: snapshotManifestObjectKey(archive.aad.creatorId, archive.aad.snapshotDigest),
      keyId: archive.aad.keyId,
    };
    const manifest = SnapshotManifestEnvelopeSchema.parse({
      ...manifestFixture,
      aad: manifestAad,
      aadDigest: snapshotManifestEnvelopeAadDigest(manifestAad),
      wrappedDek: archive.wrappedDek,
    });
    const archiveChecksum = Buffer.from(archive.cipherDigest, 'hex').toString('base64');
    const manifestChecksum = Buffer.from(manifest.cipherDigest, 'hex').toString('base64');
    const request = SnapshotUploadCreateRequestSchema.parse({
      archive: { envelope: archive, checksumSha256: archiveChecksum },
      manifest: { envelope: manifest, checksumSha256: manifestChecksum },
      expandedBytes: 1,
      fileCount: 1,
    });
    expect(
      SnapshotUploadCreateRequestSchema.safeParse({
        ...request,
        manifest: { ...request.manifest, checksumSha256: archiveChecksum },
      }).success,
    ).toBe(false);
    expect(
      SnapshotUploadCreateRequestSchema.safeParse({
        ...request,
        manifest: {
          ...request.manifest,
          envelope: { ...request.manifest.envelope, nonce: request.archive.envelope.nonce },
        },
      }).success,
    ).toBe(false);

    const target = (
      kind: 'archive' | 'manifest',
      cipherBytes: number,
      cipherDigest: string,
      objectChecksum: string,
    ) => ({
      method: 'PUT',
      putUrl: `https://uploads.example.invalid/${kind}`,
      cipherBytes,
      cipherDigest,
      requiredHeaders: {
        'cache-control': 'no-store',
        'content-length': String(cipherBytes),
        'content-type': 'application/octet-stream',
        'if-none-match': '*',
        'x-amz-checksum-sha256': objectChecksum,
        'x-amz-meta-archive-digest': archive.aad.archiveDigest,
        'x-amz-meta-cipher-bytes': String(cipherBytes),
        'x-amz-meta-cipher-digest': cipherDigest,
        'x-amz-meta-object-kind': kind,
        'x-amz-meta-object-state': 'upload',
        'x-amz-meta-protocol': 'combo.snapshot-object-storage/1',
        'x-amz-meta-snapshot-digest': archive.aad.snapshotDigest,
      },
    });
    expect(
      SnapshotUploadCreateResponseSchema.parse({
        protocol: 'combo.creator-agent-http/1',
        uploadId: '0198f00d-8000-7000-8000-000000000011',
        state: 'CREATED',
        uploads: {
          archive: target('archive', archive.cipherBytes, archive.cipherDigest, archiveChecksum),
          manifest: target(
            'manifest',
            manifest.cipherBytes,
            manifest.cipherDigest,
            manifestChecksum,
          ),
        },
        expiresAt: '2026-08-13T08:15:00.000Z',
      }),
    ).toBeDefined();
    const sameObjectResponse = {
      protocol: 'combo.creator-agent-http/1',
      uploadId: '0198f00d-8000-7000-8000-000000000011',
      state: 'CREATED',
      uploads: {
        archive: target('archive', archive.cipherBytes, archive.cipherDigest, archiveChecksum),
        manifest: {
          ...target('manifest', manifest.cipherBytes, manifest.cipherDigest, manifestChecksum),
          putUrl: 'https://uploads.example.invalid/archive?different-signature=true',
        },
      },
      expiresAt: '2026-08-13T08:15:00.000Z',
    };
    expect(SnapshotUploadCreateResponseSchema.safeParse(sameObjectResponse).success).toBe(false);
    expect(
      SnapshotUploadCreateResponseSchema.safeParse({
        ...sameObjectResponse,
        uploads: {
          ...sameObjectResponse.uploads,
          manifest: {
            ...sameObjectResponse.uploads.manifest,
            putUrl: 'https://user:password@uploads.example.invalid/manifest#ignored',
          },
        },
      }).success,
    ).toBe(false);
    const archiveCipherMaximum = 50 * 1024 * 1024 + 36;
    const manifestCipherMaximum = 4 * 1024 * 1024 + 36;
    const exactBoundaryResponse = {
      protocol: 'combo.creator-agent-http/1',
      uploadId: '0198f00d-8000-7000-8000-000000000011',
      state: 'CREATED',
      uploads: {
        archive: target('archive', archiveCipherMaximum, archive.cipherDigest, archiveChecksum),
        manifest: target(
          'manifest',
          manifestCipherMaximum,
          manifest.cipherDigest,
          manifestChecksum,
        ),
      },
      expiresAt: '2026-08-13T08:15:00.000Z',
    };
    expect(SnapshotUploadCreateResponseSchema.safeParse(exactBoundaryResponse).success).toBe(true);
    expect(
      SnapshotUploadCreateResponseSchema.safeParse({
        ...exactBoundaryResponse,
        uploads: {
          ...exactBoundaryResponse.uploads,
          archive: target(
            'archive',
            archiveCipherMaximum + 1,
            archive.cipherDigest,
            archiveChecksum,
          ),
        },
      }).success,
    ).toBe(false);
    const oversizedManifestBytes = manifestCipherMaximum + 1;
    expect(
      SnapshotUploadCreateResponseSchema.safeParse({
        protocol: 'combo.creator-agent-http/1',
        uploadId: '0198f00d-8000-7000-8000-000000000011',
        state: 'CREATED',
        uploads: {
          archive: target('archive', archive.cipherBytes, archive.cipherDigest, archiveChecksum),
          manifest: target(
            'manifest',
            oversizedManifestBytes,
            manifest.cipherDigest,
            manifestChecksum,
          ),
        },
        expiresAt: '2026-08-13T08:15:00.000Z',
      }).success,
    ).toBe(false);

    const preparation = SnapshotPublicationPreparationMarkerSchema.parse({
      protocol: 'combo.snapshot-publication-preparation/1',
      schemaVersion: 1,
      creatorId: archive.aad.creatorId,
      snapshotDigest: archive.aad.snapshotDigest,
      selectedUploadId: '0198f00d-8000-7000-8000-000000000011',
      request,
    });
    const preparationBytes = snapshotPublicationPreparationMarkerBytes(preparation);
    expect(parseSnapshotPublicationPreparationMarker(preparationBytes)).toEqual(preparation);
    for (const [scope, candidate] of [
      ['top', { ...preparation, SNAPSHOT_PREPARATION_TOP_CANARY_DO_NOT_ECHO: true }],
      [
        'nested',
        {
          ...preparation,
          request: {
            ...preparation.request,
            SNAPSHOT_PREPARATION_NESTED_CANARY_DO_NOT_ECHO: true,
          },
        },
      ],
    ] as const) {
      expectStableRawInputError(
        () =>
          parseSnapshotPublicationPreparationMarker(
            Buffer.from(canonicalizeJson(candidate), 'utf8'),
          ),
        'SNAPSHOT_PREPARATION_MARKER_INVALID',
        `SNAPSHOT_PREPARATION_${scope.toUpperCase()}_CANARY_DO_NOT_ECHO`,
      );
    }
    expectStableRawInputError(
      () =>
        parseSnapshotPublicationPreparationMarker(
          Buffer.from(` ${preparationBytes.toString('utf8')}`, 'utf8'),
        ),
      'SNAPSHOT_PREPARATION_MARKER_INVALID',
    );
    expectStableRawInputError(
      () =>
        parseSnapshotPublicationPreparationMarker(
          Buffer.from(
            preparationBytes
              .toString('utf8')
              .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
            'utf8',
          ),
        ),
      'SNAPSHOT_PREPARATION_MARKER_INVALID',
    );
    expectStableRawInputError(
      () => parseSnapshotPublicationPreparationMarker(Buffer.from([0x7b, 0x22, 0xc3, 0x28])),
      'SNAPSHOT_PREPARATION_MARKER_INVALID',
    );

    const commit = SnapshotPublicationCommitMarkerSchema.parse({
      protocol: 'combo.snapshot-publication-commit/1',
      schemaVersion: 1,
      creatorId: archive.aad.creatorId,
      snapshotDigest: archive.aad.snapshotDigest,
      preparationKey: snapshotPublicationPreparationObjectKey(
        archive.aad.creatorId,
        archive.aad.snapshotDigest,
      ),
      preparationDigest: snapshotPublicationPreparationDigest(preparation),
    });
    expect(
      parseSnapshotPublicationCommitMarker(snapshotPublicationCommitMarkerBytes(commit)),
    ).toEqual(commit);
    expectStableRawInputError(
      () =>
        parseSnapshotPublicationCommitMarker(
          Buffer.from(
            canonicalizeJson({ ...commit, SNAPSHOT_COMMIT_TOP_CANARY_DO_NOT_ECHO: true }),
            'utf8',
          ),
        ),
      'SNAPSHOT_COMMIT_MARKER_INVALID',
      'SNAPSHOT_COMMIT_TOP_CANARY_DO_NOT_ECHO',
    );
    // The frozen commit marker has no nested object owner. This nested-shaped invalid value proves
    // the catch-all surface without mislabelling it as a nested unknown-key schema rejection.
    expectStableRawInputError(
      () =>
        parseSnapshotPublicationCommitMarker(
          Buffer.from(
            canonicalizeJson({
              ...commit,
              preparationKey: {
                value: commit.preparationKey,
                SNAPSHOT_COMMIT_NESTED_SHAPE_CANARY_DO_NOT_ECHO: true,
              },
            }),
            'utf8',
          ),
        ),
      'SNAPSHOT_COMMIT_MARKER_INVALID',
      'SNAPSHOT_COMMIT_NESTED_SHAPE_CANARY_DO_NOT_ECHO',
    );
    expectStableRawInputError(
      () =>
        parseSnapshotPublicationCommitMarker(
          Buffer.from(`{"SNAPSHOT_COMMIT_SYNTAX_CANARY_DO_NOT_ECHO":`, 'utf8'),
        ),
      'SNAPSHOT_COMMIT_MARKER_INVALID',
      'SNAPSHOT_COMMIT_SYNTAX_CANARY_DO_NOT_ECHO',
    );
    const duplicateCommit = snapshotPublicationCommitMarkerBytes(commit)
      .toString('utf8')
      .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    expectStableRawInputError(
      () => parseSnapshotPublicationCommitMarker(Buffer.from(duplicateCommit, 'utf8')),
      'SNAPSHOT_COMMIT_MARKER_INVALID',
    );
    expectStableRawInputError(
      () => parseSnapshotPublicationCommitMarker(Buffer.from([0x7b, 0x22, 0xc3, 0x28])),
      'SNAPSHOT_COMMIT_MARKER_INVALID',
    );
    expect(
      SnapshotPublicationCommitMarkerSchema.safeParse({
        ...commit,
        preparationKey: `${commit.preparationKey}.cross-tenant`,
      }).success,
    ).toBe(false);
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
    const handshake = BrokerHandshakeSchema.parse(JSON.parse(handshakeText));
    expect(handshake.protocol).toBe('combo.creator-broker/1');
    expect(parseBrokerHandshake(handshakeText).installationId).toMatch(/^[a-f0-9-]{36}$/u);

    for (const [scope, candidate] of [
      ['top', { ...handshake, BROKER_HANDSHAKE_TOP_CANARY_DO_NOT_ECHO: true }],
      [
        'nested',
        {
          ...handshake,
          capacity: {
            ...handshake.capacity,
            BROKER_HANDSHAKE_NESTED_CANARY_DO_NOT_ECHO: true,
          },
        },
      ],
    ] as const) {
      expectStableRawInputError(
        () => parseBrokerHandshake(JSON.stringify(candidate)),
        'BROKER_HANDSHAKE_INVALID',
        `BROKER_HANDSHAKE_${scope.toUpperCase()}_CANARY_DO_NOT_ECHO`,
      );
    }

    for (const fixture of [
      'broker-conversation-open.v1.json',
      'broker-conversation-ready.v1.json',
      'broker-invocation-prepare.v1.json',
      'broker-invocation-prepared.v1.json',
      'broker-invocation-started.v1.json',
      'broker-invocation-succeeded.v1.json',
    ]) {
      const text = await readFixtureText(fixture);
      expect(BrokerEnvelopeSchema.safeParse(JSON.parse(text)).success, fixture).toBe(true);
      expect(parseBrokerFrame(text).protocol, fixture).toBe('combo.creator-broker/1');
    }

    const frame = BrokerEnvelopeSchema.parse(
      await readFixture('broker-invocation-prepared.v1.json'),
    );
    for (const [scope, candidate] of [
      ['top', { ...frame, BROKER_FRAME_TOP_CANARY_DO_NOT_ECHO: true }],
      [
        'nested',
        {
          ...frame,
          body: { ...frame.body, BROKER_FRAME_NESTED_CANARY_DO_NOT_ECHO: true },
        },
      ],
    ] as const) {
      expectStableRawInputError(
        () => parseBrokerFrame(JSON.stringify(candidate)),
        'BROKER_FRAME_INVALID',
        `BROKER_FRAME_${scope.toUpperCase()}_CANARY_DO_NOT_ECHO`,
      );
    }
  });

  it('binds the compatibility corpus to the current signed fixture and trusted registration rejects', async () => {
    const corpus = ProtocolVersionCorpusSchema.parse(
      await readFixture('protocol-compatibility.v1.json'),
    );
    const handshakeText = await readFixtureText('broker-handshake.v1.json');
    const handshake = BrokerHandshakeSchema.parse(JSON.parse(handshakeText));
    expect(corpus.current).toMatchObject({
      wireProtocol: handshake.protocol,
      wireSchemaVersion: handshake.schemaVersion,
      supportedProtocolVersions: handshake.supportedProtocolVersions,
      brokerContractDigest: currentBrokerContractDigest(),
    });
    expect(corpus.current.handshakeFixtureDigest).toBe(
      `sha256:${createHash('sha256').update(handshakeText).digest('hex')}`,
    );
    expect(corpus.declaredPrevious).toEqual([]);

    const currentRegistration = {
      codexRuntimeArtifacts: handshake.codexRuntimeArtifacts,
      codexProtocolSchemaDigests: handshake.codexProtocolSchemaDigests,
      isolationModes: handshake.isolationModes,
      brokerContractDigest: handshake.brokerContractDigest,
    };
    expect(BrokerRegistrationCapabilitiesSchema.safeParse(currentRegistration).success).toBe(true);
    for (const rejected of corpus.rejectedRegistrations) {
      expect(rejected.advertisementLocus).toBe('creator-oauth-registration');
      if (rejected.id === 'future-protocol-v2') {
        expect(
          BrokerHandshakeUnsignedSchema.safeParse({
            ...handshake,
            supportedProtocolVersions: rejected.protocolVersions,
          }).success,
        ).toBe(false);
      } else if (rejected.id === 'unknown-capability-key') {
        expect(
          BrokerRegistrationCapabilitiesSchema.safeParse({
            ...currentRegistration,
            futureCapability: rejected.advertisedValue,
          }).success,
        ).toBe(false);
      } else if (rejected.id === 'stale-broker-contract') {
        expect(rejected.advertisedValue).toBe(
          'sha256:9db3770041d2da6ee3daae07c1a0a4ce05094cb3852887a72c20f4f8f2319b73',
        );
        expect(rejected.advertisedValue).not.toBe(currentBrokerContractDigest());
        expect(
          BrokerRegistrationCapabilitiesSchema.safeParse({
            ...currentRegistration,
            brokerContractDigest: rejected.advertisedValue,
          }).success,
        ).toBe(true);
      } else {
        const mutation =
          rejected.id === 'unaccepted-codex-runtime'
            ? { codexRuntimeArtifacts: [rejected.advertisedValue] }
            : rejected.id === 'unaccepted-codex-protocol'
              ? { codexProtocolSchemaDigests: [rejected.advertisedValue] }
              : { isolationModes: [rejected.advertisedValue] };
        expect(
          BrokerRegistrationCapabilitiesSchema.safeParse({
            ...currentRegistration,
            ...mutation,
          }).success,
        ).toBe(true);
      }
    }
  });

  it('Broker DeviceSigner receives canonical unsigned handshake bytes only', async () => {
    const handshake = BrokerHandshakeSchema.parse(await readFixture('broker-handshake.v1.json'));
    const { challengeSignature: _challengeSignature, ...unsignedInput } = handshake;
    const unsigned = BrokerHandshakeUnsignedSchema.parse(unsignedInput);
    const reordered = BrokerHandshakeUnsignedSchema.parse({
      challengeId: unsigned.challengeId,
      capacity: unsigned.capacity,
      brokerContractDigest: unsigned.brokerContractDigest,
      isolationModes: unsigned.isolationModes,
      codexProtocolSchemaDigests: unsigned.codexProtocolSchemaDigests,
      codexRuntimeArtifacts: unsigned.codexRuntimeArtifacts,
      supportedProtocolVersions: unsigned.supportedProtocolVersions,
      workerVersion: unsigned.workerVersion,
      installationId: unsigned.installationId,
      schemaVersion: unsigned.schemaVersion,
      protocol: unsigned.protocol,
    });
    expect(brokerHandshakeSigningBytes(reordered)).toEqual(brokerHandshakeSigningBytes(unsigned));
    expect(brokerHandshakeSigningBytes(unsigned).toString('utf8')).not.toContain(
      handshake.challengeSignature,
    );
    expect(unsigned.brokerContractDigest).toBe(currentBrokerContractDigest());
    expect(brokerHandshakeSigningBytes(unsigned).toString('utf8')).toContain(
      unsigned.brokerContractDigest,
    );
    expect(
      brokerHandshakeSigningBytes({
        ...unsigned,
        brokerContractDigest: `sha256:${'0'.repeat(64)}`,
      }),
    ).not.toEqual(brokerHandshakeSigningBytes(unsigned));

    const missingDigest = { ...handshake } as Record<string, unknown>;
    delete missingDigest.brokerContractDigest;
    expect(BrokerHandshakeSchema.safeParse(missingDigest).success).toBe(false);

    const registration = BrokerRegistrationCapabilitiesSchema.parse({
      codexRuntimeArtifacts: unsigned.codexRuntimeArtifacts,
      codexProtocolSchemaDigests: unsigned.codexProtocolSchemaDigests,
      isolationModes: unsigned.isolationModes,
      brokerContractDigest: unsigned.brokerContractDigest,
    });
    expect(registration.brokerContractDigest).toBe(currentBrokerContractDigest());
    expect(
      BrokerRegistrationCapabilitiesSchema.safeParse({ ...registration, unexpected: true }).success,
    ).toBe(false);
  });

  it('conversation.open freezes original authority and causally binds conversation.ready', async () => {
    const open = BrokerConversationOpenCommandSchema.parse(
      await readFixture('broker-conversation-open.v1.json'),
    );
    const ready = (await readFixture('broker-conversation-ready.v1.json')) as {
      correlationId: string;
      body: {
        sourceEventId: string;
        openCommandId: string;
        conversationId: string;
        deploymentId: string;
        agentVersionId: string;
        agentVersionDigest: string;
        snapshotDigest: string;
        installationId: string;
        workerSessionId: string;
        leaseId: string;
        fence: string;
      };
    };

    expect(open.messageId).not.toBe(open.correlationId);
    expect(open.correlationId).toBe(open.body.conversationId);
    expect(open.lease.deploymentId).toBe(open.body.openAuthority.deploymentId);
    expect(open.lease.workerSessionId).not.toBe(open.body.openAuthority.workerSessionId);
    expect(open.lease.leaseId).not.toBe(open.body.openAuthority.leaseId);
    expect(open.lease.fence).not.toBe(open.body.openAuthority.fence);
    expect(ready.body).toMatchObject({
      sourceEventId: open.messageId,
      openCommandId: open.messageId,
      conversationId: open.body.conversationId,
      deploymentId: open.body.openAuthority.deploymentId,
      agentVersionId: open.body.agentVersionId,
      agentVersionDigest: open.body.agentVersionDigest,
      snapshotDigest: open.body.snapshotDigest,
      installationId: open.body.openAuthority.installationId,
      workerSessionId: open.body.openAuthority.workerSessionId,
      leaseId: open.body.openAuthority.leaseId,
      fence: open.body.openAuthority.fence,
    });
    expect(ready.correlationId).toBe(open.correlationId);

    const baseline = brokerConversationOpenLogicalDigest(
      brokerConversationOpenLogicalCommand(open),
    );
    expect(
      brokerConversationOpenLogicalDigest(
        brokerConversationOpenLogicalCommand({
          ...open,
          connectionId: '0198f00d-4000-7000-8000-000000000091',
          sequence: '9223372036854775807',
          sentAt: '2026-08-13T08:00:02.000Z',
          expiresAt: '2026-08-13T08:00:32.000Z',
          lease: {
            ...open.lease,
            workerSessionId: '0198f00d-4000-7000-8000-000000000092',
            leaseId: '0198f00d-4000-7000-8000-000000000093',
            fence: '99',
          },
        }),
      ),
    ).toBe(baseline);

    expect(
      BrokerConversationOpenCommandSchema.safeParse({ ...open, correlationId: open.messageId })
        .success,
    ).toBe(false);
    expect(
      BrokerConversationOpenCommandSchema.safeParse({
        ...open,
        lease: {
          ...open.lease,
          deploymentId: '0198f00d-4000-7000-8000-000000000094',
        },
      }).success,
    ).toBe(false);
  });

  it('shares one machine-readable Broker close authority across Gateway and Worker', () => {
    expect(BrokerCloseCode.CAPACITY).toBe(4004);
    expect(
      classifyBrokerRemoteClose(BrokerCloseCode.CAPACITY, BrokerCloseReason.TRANSPORT_CAPACITY),
    ).toBe('RETRY');
    expect(
      classifyBrokerRemoteClose(BrokerCloseCode.AUTH_FAILED, BrokerCloseReason.SESSION_EXPIRED),
    ).toBe('RETRY');
    for (const reason of [
      BrokerCloseReason.INSTALLATION_REVOKED,
      BrokerCloseReason.WORKER_INCOMPATIBLE,
      BrokerCloseReason.AUTHENTICATION_REJECTED,
    ]) {
      expect(classifyBrokerRemoteClose(BrokerCloseCode.AUTH_FAILED, reason)).toBe('BLOCK');
    }
    expect(
      classifyBrokerRemoteClose(
        BrokerCloseCode.SESSION_REPLACED,
        BrokerCloseReason.SESSION_REPLACED,
      ),
    ).toBe('BLOCK');
    expect(new BrokerAuthenticationError(BrokerAuthenticationFailureCode.SESSION_EXPIRED)).toEqual(
      expect.objectContaining({ code: 'SESSION_EXPIRED' }),
    );
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

    const malformedAad = structuredClone(prepare);
    malformedAad.body.userMessageCiphertext.aad.invocationId = 'not-a-uuid';
    expect(() => BrokerEnvelopeSchema.safeParse(malformedAad)).not.toThrow();
    expect(BrokerEnvelopeSchema.safeParse(malformedAad).success).toBe(false);

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

  it('Broker Worker facts reject digest mutation and keep source identity separate from messageId', async () => {
    const prepared = (await readFixture('broker-invocation-prepared.v1.json')) as {
      messageId: string;
      correlationId: string;
      connectionId: string;
      sequence: string;
      lease: { leaseId: string; workerSessionId: string; fence: string };
      body: {
        sourceEventId: string;
        factDigest: string;
        fence: string;
        prepareCommandId: string;
      };
    };
    expect(prepared.body.sourceEventId).not.toBe(prepared.messageId);

    const changedDigest = structuredClone(prepared);
    changedDigest.body.factDigest = '0'.repeat(64);
    expect(BrokerEnvelopeSchema.safeParse(changedDigest).success).toBe(false);

    const changedFact = structuredClone(prepared);
    changedFact.body.fence = '43';
    expect(BrokerEnvelopeSchema.safeParse(changedFact).success).toBe(false);

    const changedCorrelation = structuredClone(prepared);
    changedCorrelation.correlationId = '0198f00d-9999-7999-8999-999999999996';
    expect(BrokerEnvelopeSchema.safeParse(changedCorrelation).success).toBe(false);

    const transportDerivedSource = structuredClone(prepared);
    transportDerivedSource.messageId = transportDerivedSource.body.sourceEventId;
    expect(BrokerEnvelopeSchema.safeParse(transportDerivedSource).success).toBe(false);

    const reEnveloped = structuredClone(prepared);
    reEnveloped.messageId = '0198f00d-9999-7999-8999-999999999991';
    reEnveloped.connectionId = '0198f00d-9999-7999-8999-999999999992';
    reEnveloped.sequence = '9007199254740992';
    reEnveloped.lease.leaseId = '0198f00d-9999-7999-8999-999999999993';
    reEnveloped.lease.workerSessionId = '0198f00d-9999-7999-8999-999999999994';
    reEnveloped.lease.fence = '43';
    expect(BrokerEnvelopeSchema.safeParse(reEnveloped).success).toBe(true);
    expect(reEnveloped.body).toEqual(prepared.body);

    const succeeded = (await readFixture('broker-invocation-succeeded.v1.json')) as {
      correlationId: string;
      body: { invocationId: string };
    };
    const wrongTerminalCorrelation = structuredClone(succeeded);
    wrongTerminalCorrelation.correlationId = '0198f00d-9999-7999-8999-999999999995';
    expect(BrokerEnvelopeSchema.safeParse(wrongTerminalCorrelation).success).toBe(false);
  });

  it('Broker conversation.ready preserves one durable fact across current-authority re-enveloping', async () => {
    const ready = (await readFixture('broker-conversation-ready.v1.json')) as {
      messageId: string;
      correlationId: string;
      connectionId: string;
      sequence: string;
      lease: { leaseId: string; workerSessionId: string; fence: string };
      body: {
        sourceEventId: string;
        conversationId: string;
        openCommandId: string;
        workerSessionId: string;
        leaseId: string;
        fence: string;
        factDigest: string;
      };
    };

    expect(BrokerEnvelopeSchema.safeParse(ready).success).toBe(true);
    expect(ready.body.sourceEventId).toBe(ready.body.openCommandId);
    expect(ready.body.sourceEventId).not.toBe(ready.messageId);
    expect(ready.correlationId).toBe(ready.body.conversationId);
    expect(ready.lease.workerSessionId).not.toBe(ready.body.workerSessionId);
    expect(ready.lease.leaseId).not.toBe(ready.body.leaseId);
    expect(ready.lease.fence).not.toBe(ready.body.fence);

    const changedDigest = structuredClone(ready);
    changedDigest.body.factDigest = '0'.repeat(64);
    expect(BrokerEnvelopeSchema.safeParse(changedDigest).success).toBe(false);

    const changedFact = structuredClone(ready);
    changedFact.body.fence = '44';
    expect(BrokerEnvelopeSchema.safeParse(changedFact).success).toBe(false);

    const unstableSource = structuredClone(ready);
    unstableSource.body.sourceEventId = '0198f00d-5000-7000-8000-000000000099';
    expect(BrokerEnvelopeSchema.safeParse(unstableSource).success).toBe(false);

    const transportDerivedSource = structuredClone(ready);
    transportDerivedSource.messageId = transportDerivedSource.body.sourceEventId;
    expect(BrokerEnvelopeSchema.safeParse(transportDerivedSource).success).toBe(false);

    const wrongCorrelation = structuredClone(ready);
    wrongCorrelation.correlationId = '0198f00d-5000-7000-8000-000000000098';
    expect(BrokerEnvelopeSchema.safeParse(wrongCorrelation).success).toBe(false);

    const reEnveloped = structuredClone(ready);
    reEnveloped.messageId = '0198f00d-5000-7000-8000-000000000090';
    reEnveloped.connectionId = '0198f00d-5000-7000-8000-000000000091';
    reEnveloped.sequence = '9223372036854775807';
    reEnveloped.lease.leaseId = '0198f00d-5000-7000-8000-000000000092';
    reEnveloped.lease.workerSessionId = '0198f00d-5000-7000-8000-000000000093';
    reEnveloped.lease.fence = '99';
    expect(BrokerEnvelopeSchema.safeParse(reEnveloped).success).toBe(true);
    expect(reEnveloped.body).toEqual(ready.body);
  });

  it('Broker exact keys、重复 JSON key、unknown protocol 与 frame size fail closed', async () => {
    const command = (await readFixture('broker-invocation-prepare.v1.json')) as Record<
      string,
      unknown
    >;
    expect(BrokerEnvelopeSchema.safeParse({ ...command, unexpected: true }).success).toBe(false);
    expect(BrokerEnvelopeSchema.safeParse({ ...command, schemaVersion: 2 }).success).toBe(false);
    expectStableRawInputError(
      () => parseBrokerFrame('{"protocol":"x","protocol":"y"}'),
      'BROKER_FRAME_INVALID',
    );
    expect(() => parseBrokerFrame(' '.repeat(65_537))).toThrow(/65536/u);
  });

  it('Broker AEAD ciphertext maximum is attainable in maximal prepare/succeeded envelopes and at the exact whole-frame boundary', async () => {
    const parsed = BrokerEnvelopeSchema.parse(
      await readFixture('broker-invocation-prepare.v1.json'),
    );
    if (parsed.type !== 'invocation.prepare') throw new TypeError('EXPECTED_INVOCATION_PREPARE');

    const atCiphertextMaximum = structuredClone(parsed);
    const maximumUint63 = '9223372036854775807';
    atCiphertextMaximum.sequence = maximumUint63;
    atCiphertextMaximum.lease.fence = maximumUint63;
    const sensitive = atCiphertextMaximum.body.userMessageCiphertext;
    sensitive.keyId = `a${'z'.repeat(127)}`;
    sensitive.aad.keyId = sensitive.keyId;
    sensitive.ciphertext = Buffer.alloc(BROKER_MAX_SENSITIVE_CIPHERTEXT_BYTES, 0xa5).toString(
      'base64url',
    );
    sensitive.cipherDigest = brokerSensitiveMessageCipherDigest(
      sensitive.nonce,
      sensitive.ciphertext,
      sensitive.authTag,
    );
    sensitive.aadDigest = brokerSensitiveMessageAadDigest(sensitive.aad);
    const capability = atCiphertextMaximum.body.executionCapability;
    capability.fence = maximumUint63;
    capability.model = '\\'.repeat(128);
    capability.reasoningEffort = 'medium';
    capability.budget = {
      maxInputTokens: 200_000,
      maxOutputTokens: 32_768,
      maxCostMicros: 100_000_000,
    };
    capability.nonce = 'A'.repeat(128);
    const attainableFrame = JSON.stringify(atCiphertextMaximum);
    expect(Buffer.byteLength(attainableFrame, 'utf8')).toBeLessThan(BROKER_MAX_FRAME_BYTES);
    expect(parseBrokerFrame(attainableFrame)).toEqual(atCiphertextMaximum);

    const parsedSucceeded = BrokerEnvelopeSchema.parse(
      await readFixture('broker-invocation-succeeded.v1.json'),
    );
    if (parsedSucceeded.type !== 'invocation.succeeded') {
      throw new TypeError('EXPECTED_INVOCATION_SUCCEEDED');
    }
    const maximalSucceeded = structuredClone(parsedSucceeded);
    maximalSucceeded.sequence = maximumUint63;
    maximalSucceeded.lease.fence = maximumUint63;
    maximalSucceeded.body.fence = maximumUint63;
    maximalSucceeded.body.runtimeThreadId = 'A'.repeat(256);
    maximalSucceeded.body.runtimeTurnId = 'A'.repeat(256);
    const result = maximalSucceeded.body.resultCiphertext;
    result.keyId = `a${'z'.repeat(127)}`;
    result.aad.keyId = result.keyId;
    result.ciphertext = Buffer.alloc(BROKER_MAX_SENSITIVE_CIPHERTEXT_BYTES, 0x5a).toString(
      'base64url',
    );
    result.cipherDigest = brokerSensitiveMessageCipherDigest(
      result.nonce,
      result.ciphertext,
      result.authTag,
    );
    result.aadDigest = brokerSensitiveMessageAadDigest(result.aad);
    const {
      conversationId: _conversationId,
      resultCiphertext: _resultCiphertext,
      factDigest: _factDigest,
      ...succeededFact
    } = maximalSucceeded.body;
    maximalSucceeded.body.factDigest = workerInvocationFactDigest(
      WorkerInvocationSucceededFactObjectSchema.parse(succeededFact),
    );
    const maximalSucceededFrame = JSON.stringify(maximalSucceeded);
    expect(Buffer.byteLength(maximalSucceededFrame, 'utf8')).toBeLessThan(BROKER_MAX_FRAME_BYTES);
    expect(parseBrokerFrame(maximalSucceededFrame)).toEqual(maximalSucceeded);

    const exactWholeFrame = attainableFrame.padEnd(BROKER_MAX_FRAME_BYTES, ' ');
    expect(Buffer.byteLength(exactWholeFrame, 'utf8')).toBe(BROKER_MAX_FRAME_BYTES);
    expect(parseBrokerFrame(exactWholeFrame)).toEqual(atCiphertextMaximum);
    expect(() => parseBrokerFrame(`${exactWholeFrame} `)).toThrow(/65536/u);

    const aboveCiphertextMaximum = structuredClone(atCiphertextMaximum);
    aboveCiphertextMaximum.body.userMessageCiphertext.ciphertext = Buffer.alloc(
      BROKER_MAX_SENSITIVE_CIPHERTEXT_BYTES + 1,
      0xa5,
    ).toString('base64url');
    const stillInsideWholeFrame = JSON.stringify(aboveCiphertextMaximum);
    expect(Buffer.byteLength(stillInsideWholeFrame, 'utf8')).toBeLessThan(BROKER_MAX_FRAME_BYTES);
    expect(() =>
      brokerSensitiveMessageCipherDigest(
        aboveCiphertextMaximum.body.userMessageCiphertext.nonce,
        aboveCiphertextMaximum.body.userMessageCiphertext.ciphertext,
        aboveCiphertextMaximum.body.userMessageCiphertext.authTag,
      ),
    ).toThrow();
    expect(() => parseBrokerFrame(stillInsideWholeFrame)).toThrow();
  });

  it('uint63 wire boundary 精确拒绝 number、前导零、符号、exponent 和 overflow', () => {
    for (const accepted of ['0', '9007199254740991', '9007199254740992', '9223372036854775807']) {
      expect(Uint63StringSchema.safeParse(accepted).success, accepted).toBe(true);
    }
    for (const rejected of [-1, 42, '-1', '+1', '01', '1e3', '', '9223372036854775808']) {
      expect(Uint63StringSchema.safeParse(rejected).success, String(rejected)).toBe(false);
    }
  });

  it('aligns Unicode code-point boundaries with JSON Schema length semantics', () => {
    const schema = UnicodeCodePointStringSchema(8, 128);
    expect(schema.safeParse('😀'.repeat(7)).success).toBe(false);
    expect(schema.safeParse('😀'.repeat(8)).success).toBe(true);
    expect(schema.safeParse('😀'.repeat(128)).success).toBe(true);
    expect(schema.safeParse('😀'.repeat(129)).success).toBe(false);

    const base = errorResponseFor('INVALID_INPUT', 'request-1234');
    expect(VnextErrorResponseSchema.safeParse({ ...base, message: '😀'.repeat(512) }).success).toBe(
      true,
    );
    expect(VnextErrorResponseSchema.safeParse({ ...base, message: '😀'.repeat(513) }).success).toBe(
      false,
    );
    expect(VnextErrorResponseSchema.safeParse({ ...base, requestId: '😀'.repeat(8) }).success).toBe(
      true,
    );
    expect(VnextErrorResponseSchema.safeParse({ ...base, requestId: '😀'.repeat(7) }).success).toBe(
      false,
    );
  });

  it('bounds public slug, Last-Event-ID and deployment If-Match with runtime schemas', () => {
    for (const accepted of ['a', 'agent-1', `a${'b'.repeat(62)}c`]) {
      expect(PublicAgentSlugSchema.safeParse(accepted).success, accepted).toBe(true);
    }
    for (const rejected of ['', 'A', 'a-', `a${'b'.repeat(64)}`]) {
      expect(PublicAgentSlugSchema.safeParse(rejected).success, rejected).toBe(false);
    }

    for (const accepted of ['0', '9223372036854775807']) {
      expect(LastEventIdSchema.safeParse(accepted).success, accepted).toBe(true);
      expect(
        DeploymentGenerationEtagSchema.safeParse(`"generation-${accepted}"`).success,
        accepted,
      ).toBe(true);
    }
    for (const rejected of ['9223372036854775808', '0'.repeat(100_000)]) {
      expect(LastEventIdSchema.safeParse(rejected).success, rejected.slice(0, 32)).toBe(false);
      expect(
        DeploymentGenerationEtagSchema.safeParse(`"generation-${rejected}"`).success,
        rejected.slice(0, 32),
      ).toBe(false);
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
    const liveChainInput = {
      index: liveIndex,
      supportingArtifacts,
      caseResults: [liveResult],
      testCaseRegistry: liveTestCaseRegistry,
      manifest: liveManifest,
      signoff: liveSignoff,
      expected: liveExpected,
      registeredReviewerPublicKey: liveReviewerKeys.publicKey,
      revokedReviewerKeyIds: new Set<string>(),
    } satisfies EvidenceBundleChainObjectInput;
    const liveRawChainInput = evidenceBundleChainBytes(liveChainInput);
    expect(validateEvidenceBundleChain(liveRawChainInput)).toEqual({ ok: true });

    const coreRawFields = [
      ['index', 'index-json'],
      ['caseResults', 'case-results-json'],
      ['testCaseRegistry', 'test-case-registry-json'],
      ['manifest', 'manifest-json'],
      ['signoff', 'signoff-json'],
    ] as const;
    for (const [field, reason] of coreRawFields) {
      const rawBytes = liveRawChainInput[field];
      for (const offset of [-1, 0] as const) {
        const boundaryBytes = Buffer.concat([
          Buffer.from(rawBytes),
          Buffer.alloc(EVIDENCE_MAX_STRUCTURED_JSON_BYTES + offset - rawBytes.byteLength, 0x20),
        ]);
        expect(boundaryBytes.byteLength).toBe(EVIDENCE_MAX_STRUCTURED_JSON_BYTES + offset);
        expect(
          validateEvidenceBundleChain({ ...liveRawChainInput, [field]: boundaryBytes }),
          `${field}:${offset}`,
        ).toEqual({ ok: true });
      }
      const oversized = Buffer.concat([
        Buffer.from(rawBytes),
        Buffer.alloc(EVIDENCE_MAX_STRUCTURED_JSON_BYTES - rawBytes.byteLength + 1, 0x20),
      ]);
      const oversizedBefore = Buffer.from(oversized);
      expect(validateEvidenceBundleChain({ ...liveRawChainInput, [field]: oversized })).toEqual({
        ok: false,
        reasons: [reason],
      });
      expect(oversized).toEqual(oversizedBefore);
    }

    const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]);
    const duplicateManifestKeys = Buffer.from(
      canonicalizeJson(liveManifest).replace(
        '"schemaVersion":1',
        '"schemaVersion":1,"schemaVersion":1',
      ),
      'utf8',
    );
    const duplicatePrivacyScanKeys = Buffer.from(
      canonicalizeJson(privacyScan).replace(
        '"schemaVersion":1',
        '"schemaVersion":1,"schemaVersion":1',
      ),
      'utf8',
    );
    for (const [field, bytes, reason] of [
      ['caseResults', invalidUtf8, 'case-results-json'],
      ['manifest', duplicateManifestKeys, 'manifest-json'],
    ] as const) {
      const bytesBefore = Buffer.from(bytes);
      expect(validateEvidenceBundleChain({ ...liveRawChainInput, [field]: bytes })).toEqual({
        ok: false,
        reasons: [reason],
      });
      expect(bytes).toEqual(bytesBefore);
    }
    for (const [path, bytes] of [
      ['environment.json', invalidUtf8],
      ['privacy-scan.json', duplicatePrivacyScanKeys],
    ] as const) {
      const bytesBefore = Buffer.from(bytes);
      expect(
        validateEvidenceBundleChain({
          ...liveRawChainInput,
          supportingArtifacts: { ...supportingArtifacts, [path]: bytes },
        }),
      ).toEqual({ ok: false, reasons: [`artifact:${path}:json`] });
      expect(bytes).toEqual(bytesBefore);
    }

    for (const path of ['environment.json', 'privacy-scan.json'] as const) {
      const rawBytes = supportingArtifacts[path];
      for (const offset of [-1, 0] as const) {
        const boundaryBytes = Buffer.concat([
          Buffer.from(rawBytes),
          Buffer.alloc(EVIDENCE_MAX_STRUCTURED_JSON_BYTES + offset - rawBytes.byteLength, 0x20),
        ]);
        const result = validateEvidenceBundleChain({
          ...liveRawChainInput,
          supportingArtifacts: { ...supportingArtifacts, [path]: boundaryBytes },
        });
        expect(result.ok, `${path}:${offset}`).toBe(false);
        if (result.ok) throw new TypeError('EXPECTED_SUPPORTING_ARTIFACT_DIGEST_MISMATCH');
        expect(result.reasons).not.toContain(`artifact:${path}:json`);
      }
      const oversized = Buffer.concat([
        Buffer.from(rawBytes),
        Buffer.alloc(EVIDENCE_MAX_STRUCTURED_JSON_BYTES - rawBytes.byteLength + 1, 0x20),
      ]);
      expect(
        validateEvidenceBundleChain({
          ...liveRawChainInput,
          supportingArtifacts: { ...supportingArtifacts, [path]: oversized },
        }),
      ).toEqual({ ok: false, reasons: [`artifact:${path}:json`] });
    }

    const opaqueLargeBytes = Buffer.alloc(EVIDENCE_MAX_STRUCTURED_JSON_BYTES + 1, 0xff);
    expect(
      EvidenceBundleIndexSchema.safeParse({
        ...liveIndex,
        artifacts: liveIndex.artifacts.map((artifact) =>
          artifact.path === 'metrics-summary.json'
            ? { ...artifact, bytes: opaqueLargeBytes.byteLength }
            : artifact,
        ),
      }).success,
    ).toBe(true);
    expect(
      validateEvidenceBundleChain({
        ...liveRawChainInput,
        supportingArtifacts: {
          ...supportingArtifacts,
          'metrics-summary.json': opaqueLargeBytes,
        },
      }),
    ).toEqual({
      ok: false,
      reasons: ['artifact:metrics-summary.json:bytes', 'artifact:metrics-summary.json:digest'],
    });

    expect(
      validateEvidenceBundleChainObjects({
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
      validateEvidenceBundleChainObjects({
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
      validateEvidenceBundleChainObjects({
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
      validateEvidenceBundleChainObjects({
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
      validateEvidenceBundleChainObjects({
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
      validateEvidenceBundleChainObjects({
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
      validateEvidenceBundleChainObjects({
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
      validateEvidenceBundleChainObjects({
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
      validateEvidenceBundleChainObjects({
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
