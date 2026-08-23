import type {
  CreatorAgentDraftSnapshotV1,
  CreatorAgentVersionV1,
} from '@cb/creator-agent-protocol/agent';

export type CreatorAgentCatalogErrorCode =
  | 'CATALOG_PATH_INVALID'
  | 'CATALOG_FILE_UNSAFE'
  | 'CATALOG_EXISTS'
  | 'CATALOG_MISSING'
  | 'CATALOG_BUSY'
  | 'CATALOG_IO'
  | 'CATALOG_SCHEMA_MISMATCH'
  | 'CATALOG_CORRUPT'
  | 'CATALOG_CLOSED'
  | 'CATALOG_HANDOFF_INVALID'
  | 'CATALOG_DRAFT_CONFLICT'
  | 'CATALOG_DRAFT_NOT_CURRENT'
  | 'CATALOG_CONFIRMATION_MISMATCH'
  | 'CATALOG_NOT_FOUND';

export class CreatorAgentCatalogError extends Error {
  public constructor(
    public readonly code: CreatorAgentCatalogErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CreatorAgentCatalogError';
  }
}

export type CreatorAgentCatalogOptions = Readonly<{
  filename: string;
  catalogIdentity: string;
  busyTimeoutMs?: number;
}>;

export type CreatorAgentDraftRef = Readonly<{
  agentId: string;
  draftId: string;
  draftRevision: number;
}>;

export type CreatorAgentVersionRef = Readonly<{
  agentId: string;
  versionId: string;
}>;

export type CreatorAgentCatalogAgent = Readonly<{
  agentId: string;
  draftId: string;
  latestDraftRevision: number;
  latestVersionNumber: number;
  createdAtMs: number;
}>;

export type CreatorAgentDraftImportResult = Readonly<{
  disposition: 'IMPORTED' | 'EXACT_REPLAY';
  draft: CreatorAgentDraftSnapshotV1;
}>;

export type CreatorAgentFreezeReview = Readonly<{
  draft: CreatorAgentDraftSnapshotV1;
  confirmationText: string;
}>;

export type CreatorAgentFreezeResult = Readonly<{
  disposition: 'CREATED' | 'EXACT_REPLAY';
  version: CreatorAgentVersionV1;
}>;

export interface CreatorAgentCatalog {
  importDraftHandoff(text: string): CreatorAgentDraftImportResult;
  listAgents(): readonly CreatorAgentCatalogAgent[];
  listDrafts(agentId: string): readonly CreatorAgentDraftSnapshotV1[];
  readDraft(ref: CreatorAgentDraftRef): CreatorAgentDraftSnapshotV1;
  createFreezeReview(ref: CreatorAgentDraftRef): CreatorAgentFreezeReview;
  freezeDraft(
    input: Readonly<{
      ref: CreatorAgentDraftRef;
      confirmationText: string;
    }>,
  ): CreatorAgentFreezeResult;
  listVersions(agentId: string): readonly CreatorAgentVersionV1[];
  readVersion(ref: CreatorAgentVersionRef): CreatorAgentVersionV1;
  close(): void;
}
