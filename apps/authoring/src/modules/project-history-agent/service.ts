import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  AGENT_PACKAGE_RUN_V2_SCHEMA_VERSION,
  AGENT_PACKAGE_RUN_V2_EXECUTION_BOUNDARY,
  AGENT_PACKAGE_SHARE_V2_SCHEMA_VERSION,
  createAgentPackageBundle,
  createAgentPackageLaunchPrompt,
  createAgentPackageRunEnvelopeV2,
  createAgentPackageRuntimeProjection,
  createAgentPackageShareV2,
  serializeAgentPackageRunEnvelopeV2,
  serializeAgentPackageShareV2,
  type AgentPackageShareV2,
} from '@cb/creator-agent-protocol/agent-package-share';
import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V3_PROTOCOL,
  CREATOR_AGENT_PACKAGE_DRAFT_V3_PROTOCOL,
  commitCreatorAgentPackageProjectHistoryCandidate,
  createCreatorAgentPackageCreatorRequestV3,
  createCreatorAgentPackageDraftSnapshotV3,
  type CreatorAgentPackageDraftSnapshotV3,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { ZodError } from 'zod';
import { buildCreatorAgentPackageFromProjectHistoryDraft } from './package-builder.js';

import {
  CreateAgentPackageDraftInputSchema,
  CreateAgentPackageShareInputSchema,
  PrepareAgentPackageRunInputSchema,
  PROJECT_HISTORY_AGENT_CONFIRMATION_SCHEME,
  PROJECT_HISTORY_AGENT_CONFIRMATION_TTL_MS,
  PROJECT_HISTORY_AGENT_DRAFT_CARD_SCHEMA_VERSION,
  PROJECT_HISTORY_AGENT_DRAFT_RESULT_SCHEMA_VERSION,
  PROJECT_HISTORY_AGENT_DRAFT_SUMMARY,
  PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_LABEL,
  PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE,
  PROJECT_HISTORY_AGENT_RUN_PREPARATION_SCHEMA_VERSION,
  PROJECT_HISTORY_AGENT_SHARE_RESULT_SCHEMA_VERSION,
  PROJECT_HISTORY_AGENT_SHARE_MAX_BYTES,
  ReadAgentPackageShareInputSchema,
  RenderAgentPackageDraftInputSchema,
  type CreateAgentPackageDraftInput,
  type CreateAgentPackageShareInput,
  type PrepareAgentPackageRunInput,
  type ReadAgentPackageShareInput,
  type RenderAgentPackageDraftInput,
} from './contracts.js';

export type ProjectHistoryAgentServiceErrorCode =
  | 'confirmation_invalid'
  | 'digest_mismatch'
  | 'draft_not_found'
  | 'draft_stale'
  | 'idempotency_conflict'
  | 'share_not_found'
  | 'starter_mismatch';

export class ProjectHistoryAgentServiceError extends Error {
  constructor(public readonly code: ProjectHistoryAgentServiceErrorCode) {
    super('Project-history Agent request could not be completed.');
    this.name = 'ProjectHistoryAgentServiceError';
  }
}

export class ProjectHistoryAgentCandidateValidationError extends TypeError {
  constructor() {
    super('Project-history Agent candidate cannot be compiled into the fixed Package flow.');
    this.name = 'ProjectHistoryAgentCandidateValidationError';
  }
}

export type StoredProjectHistoryAgentDraft = Readonly<{
  ownerUserId: string;
  draft: CreatorAgentPackageDraftSnapshotV3;
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: string;
}>;

export type StoredProjectHistoryAgentConfirmation = Readonly<{
  ownerUserId: string;
  draftId: string;
  revision: number;
  draftFingerprint: string;
  tokenDigest: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedShareToken: string | null;
}>;

export type StoredProjectHistoryAgentShare = Readonly<{
  ownerUserId: string;
  draftId: string;
  draftFingerprint: string;
  confirmationTokenDigest: string;
  idempotencyKey: string;
  requestFingerprint: string;
  shareToken: string;
  shareUrl: string;
  share: AgentPackageShareV2;
  copyPrompt: string;
}>;

type CreateDraftRepositoryResult =
  | { kind: 'created'; record: StoredProjectHistoryAgentDraft }
  | { kind: 'existing'; record: StoredProjectHistoryAgentDraft }
  | { kind: 'conflict' };

type ConfirmationResolution =
  | { kind: 'valid'; draft: StoredProjectHistoryAgentDraft }
  | { kind: 'invalid' }
  | { kind: 'stale' };

type CreateShareRepositoryResult =
  | { kind: 'created'; record: StoredProjectHistoryAgentShare }
  | { kind: 'existing'; record: StoredProjectHistoryAgentShare }
  | { kind: 'confirmation_invalid' }
  | { kind: 'draft_stale' }
  | { kind: 'idempotency_conflict' };

export interface ProjectHistoryAgentRepository {
  createDraft(record: StoredProjectHistoryAgentDraft): Promise<CreateDraftRepositoryResult>;
  readDraft(ownerUserId: string, draftId: string): Promise<StoredProjectHistoryAgentDraft | null>;
  issueConfirmation(
    record: StoredProjectHistoryAgentConfirmation,
  ): Promise<StoredProjectHistoryAgentConfirmation>;
  resolveConfirmation(input: {
    ownerUserId: string;
    draftId: string;
    draftFingerprint: string;
    tokenDigest: string;
    now: string;
  }): Promise<ConfirmationResolution>;
  readShareByIdempotency(
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<StoredProjectHistoryAgentShare | null>;
  consumeConfirmationAndCreateShare(input: {
    record: StoredProjectHistoryAgentShare;
    now: string;
  }): Promise<CreateShareRepositoryResult>;
  readShareByToken(shareToken: string): Promise<StoredProjectHistoryAgentShare | null>;
}

export interface ProjectHistoryAgentClock {
  now(): Date;
}

export type ProjectHistoryAgentService = ReturnType<typeof createProjectHistoryAgentService>;

export function createProjectHistoryAgentService(options: {
  repository: ProjectHistoryAgentRepository;
  publicOrigin: string;
  clock?: ProjectHistoryAgentClock;
  randomBytes?: (size: number) => Uint8Array;
}) {
  const publicOrigin = canonicalPublicOrigin(options.publicOrigin);
  const clock = options.clock ?? { now: () => new Date() };
  const random = options.randomBytes ?? nodeRandomBytes;

  const readShareRecord = async (rawInput: ReadAgentPackageShareInput) => {
    const input = ReadAgentPackageShareInputSchema.parse(rawInput);
    const shareToken = shareTokenFromUrl(input.shareUrl, publicOrigin);
    const record = await options.repository.readShareByToken(shareToken);
    if (!record || record.shareUrl !== input.shareUrl) {
      throw new ProjectHistoryAgentServiceError('share_not_found');
    }
    return record;
  };

  return Object.freeze({
    async createDraft(ownerUserId: string, rawInput: CreateAgentPackageDraftInput) {
      const input = CreateAgentPackageDraftInputSchema.parse(rawInput);
      const creatorRequest = createCreatorAgentPackageCreatorRequestV3({
        protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V3_PROTOCOL,
        intent: 'create_agent_package_from_project_task_history',
        request: input.creatorRequest.normalize('NFC').trim(),
      });
      const candidateCommitment = commitCreatorAgentPackageProjectHistoryCandidate({
        creatorRequest,
        candidate: input.candidate,
        sourceEvidence: input.sourceEvidence,
      });
      const draft = createCreatorAgentPackageDraftSnapshotV3({
        protocol: CREATOR_AGENT_PACKAGE_DRAFT_V3_PROTOCOL,
        draftId: `draft.agent-package.${hex(random(16), 16)}`,
        revision: 1,
        parentDraftFingerprint: null,
        creatorRequest,
        source: { ...input.sourceEvidence, candidateCommitment },
        content: input.candidate,
      });
      preflightProjectHistoryAgentPackage(draft, publicOrigin);
      const record: StoredProjectHistoryAgentDraft = Object.freeze({
        ownerUserId,
        draft,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: candidateCommitment,
        createdAt: clock.now().toISOString(),
      });
      const outcome = await options.repository.createDraft(record);
      if (outcome.kind === 'conflict')
        throw new ProjectHistoryAgentServiceError('idempotency_conflict');
      return Object.freeze({
        schemaVersion: PROJECT_HISTORY_AGENT_DRAFT_RESULT_SCHEMA_VERSION,
        created: outcome.kind === 'created',
        draft: outcome.record.draft,
      });
    },

    async renderDraft(ownerUserId: string, rawInput: RenderAgentPackageDraftInput) {
      const input = RenderAgentPackageDraftInputSchema.parse(rawInput);
      const record = await options.repository.readDraft(ownerUserId, input.draftId);
      if (!record) throw new ProjectHistoryAgentServiceError('draft_not_found');
      if (record.draft.draftFingerprint !== input.draftFingerprint) {
        throw new ProjectHistoryAgentServiceError('draft_stale');
      }
      const token = `cfrm_${base64url(random(32), 32)}`;
      const now = clock.now();
      const expiresAt = new Date(
        now.getTime() + PROJECT_HISTORY_AGENT_CONFIRMATION_TTL_MS,
      ).toISOString();
      const issuedConfirmation = await options.repository.issueConfirmation(
        Object.freeze({
          ownerUserId,
          draftId: record.draft.draftId,
          revision: record.draft.revision,
          draftFingerprint: record.draft.draftFingerprint,
          tokenDigest: digestOpaque(token),
          expiresAt,
          consumedAt: null,
          consumedShareToken: null,
        }),
      );
      const source = record.draft.source;
      const cardSnapshot = Object.freeze({
        stage: 'draft' as const,
        title: record.draft.content.name,
        summary: PROJECT_HISTORY_AGENT_DRAFT_SUMMARY,
        sourceDisclosure: Object.freeze({
          kind: source.kind,
          assurance: source.assurance,
          selection: source.selection,
          completeness: source.completeness,
          hostAttestation: source.hostAttestation,
          sourceProjectionEnforced: source.sourceProjectionEnforced,
          rawStored: source.rawStored,
          projectCount: source.projectCount,
          discoveredThreadCount: source.discoveredThreadCount,
          readThreadCount: source.readThreadCount,
          omittedThreadCount: source.omittedThreadCount,
          completedTurnCount: source.completedTurnCount,
          userVisibleMessageCount: source.userVisibleMessageCount,
          omittedItemCount: source.omittedItemCount,
          limitationReasons: source.limitationReasons,
        }),
        shareDisclosure: Object.freeze({
          access: 'public_by_link' as const,
          revocation: 'not_supported' as const,
          expiry: 'none' as const,
          marketplacePublication: false as const,
        }),
        content: record.draft.content,
      });
      const actions = Object.freeze([
        Object.freeze({
          id: 'confirm_create_agent_package_share',
          label: PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_LABEL,
          message: PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE,
          emphasis: 'primary' as const,
        }),
      ]);
      return Object.freeze({
        schemaVersion: PROJECT_HISTORY_AGENT_DRAFT_CARD_SCHEMA_VERSION,
        draft: record.draft,
        cardSnapshot,
        actions,
        confirmation: Object.freeze({
          scheme: PROJECT_HISTORY_AGENT_CONFIRMATION_SCHEME,
          confirmationToken: token,
          expiresAt: issuedConfirmation.expiresAt,
        }),
      });
    },

    async createShare(ownerUserId: string, rawInput: CreateAgentPackageShareInput) {
      const input = CreateAgentPackageShareInputSchema.parse(rawInput);
      const confirmationTokenDigest = digestOpaque(input.confirmationToken);
      const requestFingerprint = shareRequestFingerprint(input, confirmationTokenDigest);
      const existing = await options.repository.readShareByIdempotency(
        ownerUserId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new ProjectHistoryAgentServiceError('idempotency_conflict');
        }
        return shareResult(existing, false);
      }
      const now = clock.now().toISOString();
      const confirmation = await options.repository.resolveConfirmation({
        ownerUserId,
        draftId: input.draftId,
        draftFingerprint: input.draftFingerprint,
        tokenDigest: confirmationTokenDigest,
        now,
      });
      if (confirmation.kind === 'invalid') {
        throw new ProjectHistoryAgentServiceError('confirmation_invalid');
      }
      if (confirmation.kind === 'stale') throw new ProjectHistoryAgentServiceError('draft_stale');

      const build = buildCreatorAgentPackageFromProjectHistoryDraft(confirmation.draft.draft);
      const bundle = createAgentPackageBundle({
        manifest: build.manifest,
        files: build.files.map((file) => ({
          path: file.path,
          contentBase64: Buffer.from(file.text, 'utf8').toString('base64'),
        })),
      });
      const shareToken = base64url(random(32), 32);
      const shareUrl = new URL(
        `/api/v1/agent-package-shares/${shareToken}`,
        publicOrigin,
      ).toString();
      const share = createAgentPackageShareV2({
        schemaVersion: AGENT_PACKAGE_SHARE_V2_SCHEMA_VERSION,
        releaseId: `release.agent-package.${hex(random(16), 16)}`,
        sourceDraftFingerprint: input.draftFingerprint,
        packageDigest: build.packageDigest,
        package: bundle,
        starterPrompts: build.starterPrompts,
        createdAt: now,
      });
      if (
        Buffer.byteLength(serializeAgentPackageShareV2(share), 'utf8') >
        PROJECT_HISTORY_AGENT_SHARE_MAX_BYTES
      ) {
        throw new TypeError('Project-history Agent Package share exceeds the transport-safe limit');
      }
      const copyPrompt = `在 Codex 中打开 ${shareUrl}，先读取权威 Package 摘要，再选择一个起始任务。`;
      const record: StoredProjectHistoryAgentShare = Object.freeze({
        ownerUserId,
        draftId: input.draftId,
        draftFingerprint: input.draftFingerprint,
        confirmationTokenDigest,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        shareToken,
        shareUrl,
        share,
        copyPrompt,
      });
      const outcome = await options.repository.consumeConfirmationAndCreateShare({ record, now });
      if (outcome.kind === 'confirmation_invalid') {
        throw new ProjectHistoryAgentServiceError('confirmation_invalid');
      }
      if (outcome.kind === 'draft_stale') throw new ProjectHistoryAgentServiceError('draft_stale');
      if (outcome.kind === 'idempotency_conflict') {
        throw new ProjectHistoryAgentServiceError('idempotency_conflict');
      }
      return shareResult(outcome.record, outcome.kind === 'created');
    },

    async readShare(rawInput: ReadAgentPackageShareInput) {
      const record = await readShareRecord(rawInput);
      return readShareResult(record);
    },

    async prepareRun(rawInput: PrepareAgentPackageRunInput) {
      const input = PrepareAgentPackageRunInputSchema.parse(rawInput);
      const record = await readShareRecord({ shareUrl: input.shareUrl });
      if (record.share.packageDigest !== input.packageDigest) {
        throw new ProjectHistoryAgentServiceError('digest_mismatch');
      }
      const expected = record.share.starterPrompts[input.starterOrdinal - 1];
      if (expected === undefined || expected !== input.starterPrompt) {
        throw new ProjectHistoryAgentServiceError('starter_mismatch');
      }
      const runtime = createAgentPackageRuntimeProjection(record.share.package);
      const envelope = createAgentPackageRunEnvelopeV2({
        schemaVersion: AGENT_PACKAGE_RUN_V2_SCHEMA_VERSION,
        shareUrl: input.shareUrl,
        packageDigest: input.packageDigest,
        sourceDraftFingerprint: record.share.sourceDraftFingerprint,
        packageManifest: record.share.package.manifest,
        runtime,
        executionBoundary: AGENT_PACKAGE_RUN_V2_EXECUTION_BOUNDARY,
        starterOrdinal: input.starterOrdinal,
        starterPrompt: input.starterPrompt,
      });
      const launchPrompt = createAgentPackageLaunchPrompt({
        agentName: record.share.package.manifest.name,
        shareUrl: input.shareUrl,
        packageDigest: input.packageDigest,
        starterOrdinal: input.starterOrdinal,
        starterPrompt: input.starterPrompt,
      });
      return Object.freeze({
        schemaVersion: PROJECT_HISTORY_AGENT_RUN_PREPARATION_SCHEMA_VERSION,
        shareUrl: input.shareUrl,
        packageDigest: input.packageDigest,
        starterOrdinal: input.starterOrdinal,
        starterPrompt: input.starterPrompt,
        sourceDraftFingerprint: record.share.sourceDraftFingerprint,
        runtimeMaterial: runtime,
        executionBoundary: AGENT_PACKAGE_RUN_V2_EXECUTION_BOUNDARY,
        launchPrompt,
        runEnvelope: serializeAgentPackageRunEnvelopeV2(envelope),
      });
    },
  });
}

function preflightProjectHistoryAgentPackage(
  draft: CreatorAgentPackageDraftSnapshotV3,
  publicOrigin: string,
): void {
  try {
    const build = buildCreatorAgentPackageFromProjectHistoryDraft(draft);
    for (const [index, starterPrompt] of build.starterPrompts.entries()) {
      createAgentPackageLaunchPrompt({
        agentName: build.manifest.name,
        shareUrl: new URL(
          `/api/v1/agent-package-shares/${'A'.repeat(43)}`,
          publicOrigin,
        ).toString(),
        packageDigest: build.packageDigest,
        starterOrdinal: index + 1,
        starterPrompt,
      });
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof ZodError) {
      throw new ProjectHistoryAgentCandidateValidationError();
    }
    throw error;
  }
}

function shareResult(record: StoredProjectHistoryAgentShare, created: boolean) {
  return Object.freeze({
    schemaVersion: PROJECT_HISTORY_AGENT_SHARE_RESULT_SCHEMA_VERSION,
    created,
    release: Object.freeze({
      protocol: 'combo.agent-package-release/1' as const,
      releaseId: record.share.releaseId,
      packageDigest: record.share.packageDigest,
    }),
    share: record.share,
    package: record.share.package,
    packageManifest: record.share.package.manifest,
    packageDigest: record.share.packageDigest,
    shareUrl: record.shareUrl,
    copyPrompt: record.copyPrompt,
    runCompatibility: Object.freeze({
      creatorProjectRequired: false as const,
      delivery: 'server_verified_cleartext_runtime_projection' as const,
      hostInstalledEnforcement: 'not_proven' as const,
    }),
  });
}

function readShareResult(record: StoredProjectHistoryAgentShare) {
  return Object.freeze({
    schemaVersion: PROJECT_HISTORY_AGENT_SHARE_RESULT_SCHEMA_VERSION,
    release: Object.freeze({
      protocol: 'combo.agent-package-release/1' as const,
      releaseId: record.share.releaseId,
      packageDigest: record.share.packageDigest,
    }),
    share: record.share,
    package: record.share.package,
    packageManifest: record.share.package.manifest,
    packageDigest: record.share.packageDigest,
    shareUrl: record.shareUrl,
    copyPrompt: record.copyPrompt,
    runCompatibility: Object.freeze({
      creatorProjectRequired: false as const,
      delivery: 'server_verified_cleartext_runtime_projection' as const,
      hostInstalledEnforcement: 'not_proven' as const,
    }),
  });
}

function canonicalPublicOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      )) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value !== url.origin
  ) {
    throw new TypeError('Project-history Agent public origin is invalid');
  }
  return url.origin;
}

function shareTokenFromUrl(value: string, expectedOrigin: string): string {
  if (value.includes('?') || value.includes('#')) {
    throw new ProjectHistoryAgentServiceError('share_not_found');
  }
  const url = new URL(value);
  const match = /^\/api\/v1\/agent-package-shares\/([A-Za-z0-9_-]{43})$/u.exec(url.pathname);
  if (
    url.origin !== expectedOrigin ||
    !match ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.toString() !== value
  ) {
    throw new ProjectHistoryAgentServiceError('share_not_found');
  }
  return match[1]!;
}

function digestOpaque(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function shareRequestFingerprint(
  input: CreateAgentPackageShareInput,
  confirmationTokenDigest: string,
): string {
  return digestOpaque(
    JSON.stringify({
      draftId: input.draftId,
      draftFingerprint: input.draftFingerprint,
      confirmationTokenDigest,
    }),
  );
}

function hex(bytes: Uint8Array, expectedBytes: number): string {
  const value = Buffer.from(bytes);
  if (value.byteLength !== expectedBytes)
    throw new TypeError('Random source returned wrong byte count');
  return value.toString('hex');
}

function base64url(bytes: Uint8Array, expectedBytes: number): string {
  const value = Buffer.from(bytes);
  if (value.byteLength !== expectedBytes)
    throw new TypeError('Random source returned wrong byte count');
  return value.toString('base64url');
}

export class InMemoryProjectHistoryAgentRepository implements ProjectHistoryAgentRepository {
  readonly #drafts = new Map<string, StoredProjectHistoryAgentDraft>();
  readonly #draftIdempotency = new Map<string, StoredProjectHistoryAgentDraft>();
  readonly #confirmations = new Map<string, StoredProjectHistoryAgentConfirmation>();
  readonly #shares = new Map<string, StoredProjectHistoryAgentShare>();
  readonly #shareIdempotency = new Map<string, StoredProjectHistoryAgentShare>();
  readonly #shareDrafts = new Map<string, StoredProjectHistoryAgentShare>();

  async createDraft(record: StoredProjectHistoryAgentDraft): Promise<CreateDraftRepositoryResult> {
    const key = `${record.ownerUserId}:${record.idempotencyKey}`;
    const existing = this.#draftIdempotency.get(key);
    if (existing) {
      return existing.requestFingerprint === record.requestFingerprint
        ? { kind: 'existing', record: existing }
        : { kind: 'conflict' };
    }
    this.#drafts.set(`${record.ownerUserId}:${record.draft.draftId}`, record);
    this.#draftIdempotency.set(key, record);
    return { kind: 'created', record };
  }

  async readDraft(ownerUserId: string, draftId: string) {
    return this.#drafts.get(`${ownerUserId}:${draftId}`) ?? null;
  }

  async issueConfirmation(
    record: StoredProjectHistoryAgentConfirmation,
  ): Promise<StoredProjectHistoryAgentConfirmation> {
    this.#confirmations.set(record.tokenDigest, record);
    return record;
  }

  async resolveConfirmation(input: {
    ownerUserId: string;
    draftId: string;
    draftFingerprint: string;
    tokenDigest: string;
    now: string;
  }): Promise<ConfirmationResolution> {
    const confirmation = this.#confirmations.get(input.tokenDigest);
    if (
      !confirmation ||
      confirmation.ownerUserId !== input.ownerUserId ||
      confirmation.draftId !== input.draftId ||
      confirmation.consumedAt !== null ||
      confirmation.expiresAt <= input.now
    ) {
      return { kind: 'invalid' };
    }
    if (confirmation.draftFingerprint !== input.draftFingerprint) return { kind: 'stale' };
    const draft = await this.readDraft(input.ownerUserId, input.draftId);
    if (!draft || draft.draft.draftFingerprint !== input.draftFingerprint) return { kind: 'stale' };
    return { kind: 'valid', draft };
  }

  async readShareByIdempotency(ownerUserId: string, idempotencyKey: string) {
    return this.#shareIdempotency.get(`${ownerUserId}:${idempotencyKey}`) ?? null;
  }

  async consumeConfirmationAndCreateShare(input: {
    record: StoredProjectHistoryAgentShare;
    now: string;
  }): Promise<CreateShareRepositoryResult> {
    const record = input.record;
    const idempotency = `${record.ownerUserId}:${record.idempotencyKey}`;
    const existing = this.#shareIdempotency.get(idempotency);
    if (existing) {
      return existing.requestFingerprint === record.requestFingerprint
        ? { kind: 'existing', record: existing }
        : { kind: 'idempotency_conflict' };
    }
    if (this.#shareDrafts.has(`${record.ownerUserId}:${record.draftFingerprint}`)) {
      return { kind: 'idempotency_conflict' };
    }
    const confirmation = this.#confirmations.get(record.confirmationTokenDigest);
    if (
      !confirmation ||
      confirmation.ownerUserId !== record.ownerUserId ||
      confirmation.draftId !== record.draftId ||
      confirmation.draftFingerprint !== record.draftFingerprint ||
      confirmation.consumedAt !== null ||
      confirmation.expiresAt <= input.now
    ) {
      return { kind: 'confirmation_invalid' };
    }
    const draft = this.#drafts.get(`${record.ownerUserId}:${record.draftId}`);
    if (!draft || draft.draft.draftFingerprint !== record.draftFingerprint) {
      return { kind: 'draft_stale' };
    }
    this.#confirmations.set(
      record.confirmationTokenDigest,
      Object.freeze({
        ...confirmation,
        consumedAt: input.now,
        consumedShareToken: record.shareToken,
      }),
    );
    this.#shares.set(record.shareToken, record);
    this.#shareIdempotency.set(idempotency, record);
    this.#shareDrafts.set(`${record.ownerUserId}:${record.draftFingerprint}`, record);
    return { kind: 'created', record };
  }

  async readShareByToken(shareToken: string) {
    return this.#shares.get(shareToken) ?? null;
  }
}
