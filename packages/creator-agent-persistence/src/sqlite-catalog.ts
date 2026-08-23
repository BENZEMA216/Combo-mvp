import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isProxy } from 'node:util/types';

import {
  freezeCreatorAgentVersion,
  parseCreatorAgentDraftHandoff,
  parseCreatorAgentVersion,
  serializeCreatorAgentDraftSnapshot,
  serializeCreatorAgentDraftHandoff,
  serializeCreatorAgentVersion,
  type CreatorAgentDraftSnapshotV1,
  type CreatorAgentVersionV1,
} from '@cb/creator-agent-protocol/agent';

import {
  CreatorAgentCatalogError,
  type CreatorAgentCatalog,
  type CreatorAgentCatalogAgent,
  type CreatorAgentCatalogOptions,
  type CreatorAgentDraftImportResult,
  type CreatorAgentDraftRef,
  type CreatorAgentFreezeResult,
  type CreatorAgentFreezeReview,
  type CreatorAgentVersionRef,
} from './catalog-types.js';
import { normalizeCatalogError, openCreatorAgentCatalogDatabase } from './sqlite-platform.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export function createFreshCreatorAgentCatalog(
  options: CreatorAgentCatalogOptions,
): CreatorAgentCatalog {
  return createCatalog(options, 'CREATE_FRESH');
}

export function openExistingCreatorAgentCatalog(
  options: CreatorAgentCatalogOptions,
): CreatorAgentCatalog {
  return createCatalog(options, 'OPEN_EXISTING');
}

function createCatalog(
  options: CreatorAgentCatalogOptions,
  mode: 'CREATE_FRESH' | 'OPEN_EXISTING',
): CreatorAgentCatalog {
  const opened = openCreatorAgentCatalogDatabase(options, mode);
  try {
    const catalog = new SqliteCreatorAgentCatalog(opened.database);
    catalog.validateAllRows();
    return catalog;
  } catch (error) {
    try {
      opened.database.close();
    } catch {
      // The validation failure remains authoritative.
    }
    throw normalizeCatalogError(error);
  }
}

class SqliteCreatorAgentCatalog implements CreatorAgentCatalog {
  #closed = false;

  public constructor(private readonly database: DatabaseSync) {}

  public importDraftHandoff(text: string): CreatorAgentDraftImportResult {
    this.#assertOpen();
    let handoff;
    try {
      handoff = parseCreatorAgentDraftHandoff(text);
    } catch (error) {
      throw catalogError(
        'CATALOG_HANDOFF_INVALID',
        'Creator Agent Draft handoff is invalid.',
        error,
      );
    }
    const { draft } = handoff;
    const draftJson = serializeCreatorAgentDraftSnapshot(draft);
    const now = Date.now();
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const existing = this.#draftRow(draft);
      if (existing !== undefined) {
        const exact = rowString(existing, 'handoff_json') === text;
        this.database.exec('COMMIT');
        if (!exact) {
          throw catalogError(
            'CATALOG_DRAFT_CONFLICT',
            'Draft identity already exists with different content.',
          );
        }
        return frozen({ disposition: 'EXACT_REPLAY', draft: this.#parseDraftRow(existing) });
      }
      const draftOwner = this.database
        .prepare('SELECT agent_id FROM agent_catalog_agents WHERE draft_id = ?')
        .get(draft.draftId) as Record<string, unknown> | undefined;
      if (draftOwner !== undefined && rowString(draftOwner, 'agent_id') !== draft.agentId) {
        throw catalogError(
          'CATALOG_DRAFT_CONFLICT',
          'Draft identity already belongs to another Agent.',
        );
      }
      const agent = this.database
        .prepare('SELECT * FROM agent_catalog_agents WHERE agent_id = ?')
        .get(draft.agentId) as Record<string, unknown> | undefined;
      if (agent === undefined) {
        if (draft.draftRevision !== 1 || draft.baseVersionId !== null) {
          throw catalogError(
            'CATALOG_DRAFT_CONFLICT',
            'A new Agent must begin at Draft revision 1 without a base Version.',
          );
        }
        this.database
          .prepare(
            `INSERT INTO agent_catalog_agents
               (agent_id, draft_id, latest_draft_revision, latest_version_number,
                latest_version_id, created_at_ms)
             VALUES (?, ?, 1, 0, NULL, ?)`,
          )
          .run(draft.agentId, draft.draftId, now);
      } else {
        const latestRevision = rowInteger(agent, 'latest_draft_revision');
        const latestVersionId = rowNullableString(agent, 'latest_version_id');
        if (
          rowString(agent, 'draft_id') !== draft.draftId ||
          draft.draftRevision !== latestRevision + 1 ||
          draft.baseVersionId !== latestVersionId
        ) {
          throw catalogError(
            'CATALOG_DRAFT_CONFLICT',
            'Draft revision or base Version does not extend the current Agent.',
          );
        }
        this.database
          .prepare(
            `UPDATE agent_catalog_agents
                SET latest_draft_revision = ?
              WHERE agent_id = ? AND latest_draft_revision = ?`,
          )
          .run(draft.draftRevision, draft.agentId, latestRevision);
      }
      this.database
        .prepare(
          `INSERT INTO agent_catalog_drafts
             (agent_id, draft_id, draft_revision, base_version_id, definition_fingerprint,
              draft_fingerprint, handoff_json, draft_json, imported_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          draft.agentId,
          draft.draftId,
          draft.draftRevision,
          draft.baseVersionId,
          draft.definitionFingerprint,
          draft.draftFingerprint,
          text,
          draftJson,
          now,
        );
      this.database.exec('COMMIT');
      return frozen({ disposition: 'IMPORTED', draft });
    } catch (error) {
      this.#rollback();
      throw normalizeCatalogError(error);
    }
  }

  public listAgents(): readonly CreatorAgentCatalogAgent[] {
    this.#assertOpen();
    try {
      return Object.freeze(
        this.database
          .prepare('SELECT * FROM agent_catalog_agents ORDER BY created_at_ms, agent_id')
          .all()
          .map((value) => this.#parseAgentRow(requiredRow(value))),
      );
    } catch (error) {
      throw normalizeCatalogError(error);
    }
  }

  public listDrafts(agentId: string): readonly CreatorAgentDraftSnapshotV1[] {
    this.#assertOpen();
    assertIdentifier(agentId, 'agentId');
    try {
      const rows = this.database
        .prepare(
          `SELECT * FROM agent_catalog_drafts
            WHERE agent_id = ?
            ORDER BY draft_revision`,
        )
        .all(agentId) as Array<Record<string, unknown>>;
      return Object.freeze(rows.map((row) => this.#parseDraftRow(row)));
    } catch (error) {
      throw normalizeCatalogError(error);
    }
  }

  public readDraft(input: CreatorAgentDraftRef): CreatorAgentDraftSnapshotV1 {
    this.#assertOpen();
    const ref = snapshotDraftRef(input);
    const row = this.#draftRow(ref);
    if (row === undefined) throw catalogError('CATALOG_NOT_FOUND', 'Agent Draft was not found.');
    return this.#parseDraftRow(row);
  }

  public createFreezeReview(input: CreatorAgentDraftRef): CreatorAgentFreezeReview {
    const draft = this.readDraft(input);
    this.#assertCurrentDraft(draft);
    return frozen({ draft, confirmationText: confirmationText(draft) });
  }

  public freezeDraft(
    input: Readonly<{
      ref: CreatorAgentDraftRef;
      confirmationText: string;
    }>,
  ): CreatorAgentFreezeResult {
    this.#assertOpen();
    const { ref, confirmationText: suppliedConfirmation } = snapshotFreezeRequest(input);
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const row = this.#draftRow(ref);
      if (row === undefined) throw catalogError('CATALOG_NOT_FOUND', 'Agent Draft was not found.');
      const draft = this.#parseDraftRow(row);
      if (suppliedConfirmation !== confirmationText(draft)) {
        throw catalogError(
          'CATALOG_CONFIRMATION_MISMATCH',
          'Freeze confirmation does not bind the current Draft.',
        );
      }
      const existing = this.database
        .prepare(
          `SELECT * FROM agent_catalog_versions
            WHERE agent_id = ? AND source_draft_id = ? AND source_draft_revision = ?`,
        )
        .get(draft.agentId, draft.draftId, draft.draftRevision) as
        | Record<string, unknown>
        | undefined;
      if (existing !== undefined) {
        const version = this.#parseVersionRow(existing);
        this.database.exec('COMMIT');
        return frozen({ disposition: 'EXACT_REPLAY', version });
      }
      this.#assertCurrentDraft(draft);
      const agent = requiredRow(
        this.database
          .prepare('SELECT * FROM agent_catalog_agents WHERE agent_id = ?')
          .get(draft.agentId),
      );
      const versionNumber = rowInteger(agent, 'latest_version_number') + 1;
      const version = freezeCreatorAgentVersion({
        versionId: `version.local.${randomUUID()}`,
        versionNumber,
        createdAtMs: Date.now(),
        draft,
      });
      this.database
        .prepare(
          `INSERT INTO agent_catalog_versions
             (agent_id, version_id, version_number, source_draft_id, source_draft_revision,
              source_draft_fingerprint, definition_fingerprint, version_fingerprint,
              version_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version.agentId,
          version.versionId,
          version.versionNumber,
          version.sourceDraft.draftId,
          version.sourceDraft.draftRevision,
          version.sourceDraft.draftFingerprint,
          version.definitionFingerprint,
          version.versionFingerprint,
          serializeCreatorAgentVersion(version),
          version.createdAtMs,
        );
      this.database
        .prepare(
          `UPDATE agent_catalog_agents
              SET latest_version_number = ?, latest_version_id = ?
            WHERE agent_id = ? AND latest_version_number = ?`,
        )
        .run(version.versionNumber, version.versionId, version.agentId, versionNumber - 1);
      this.database.exec('COMMIT');
      return frozen({ disposition: 'CREATED', version });
    } catch (error) {
      this.#rollback();
      throw normalizeCatalogError(error);
    }
  }

  public listVersions(agentId: string): readonly CreatorAgentVersionV1[] {
    this.#assertOpen();
    assertIdentifier(agentId, 'agentId');
    try {
      const rows = this.database
        .prepare(
          `SELECT * FROM agent_catalog_versions
            WHERE agent_id = ?
            ORDER BY version_number`,
        )
        .all(agentId) as Array<Record<string, unknown>>;
      return Object.freeze(rows.map((row) => this.#parseVersionRow(row)));
    } catch (error) {
      throw normalizeCatalogError(error);
    }
  }

  public readVersion(input: CreatorAgentVersionRef): CreatorAgentVersionV1 {
    this.#assertOpen();
    const ref = snapshotVersionRef(input);
    try {
      const row = this.database
        .prepare(
          `SELECT * FROM agent_catalog_versions
            WHERE agent_id = ? AND version_id = ?`,
        )
        .get(ref.agentId, ref.versionId) as Record<string, unknown> | undefined;
      if (row === undefined)
        throw catalogError('CATALOG_NOT_FOUND', 'Agent Version was not found.');
      return this.#parseVersionRow(row);
    } catch (error) {
      throw normalizeCatalogError(error);
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.database.close();
    } catch (error) {
      throw normalizeCatalogError(error);
    }
  }

  public validateAllRows(): void {
    const agents = this.listAgents();
    for (const agent of agents) {
      const drafts = this.listDrafts(agent.agentId);
      const versions = this.listVersions(agent.agentId);
      if (
        drafts.length !== agent.latestDraftRevision ||
        versions.length !== agent.latestVersionNumber ||
        drafts.some(
          (draft, index) =>
            draft.agentId !== agent.agentId ||
            draft.draftId !== agent.draftId ||
            draft.draftRevision !== index + 1,
        ) ||
        versions.some(
          (version, index) =>
            version.agentId !== agent.agentId || version.versionNumber !== index + 1,
        ) ||
        (versions.at(-1)?.versionId ?? null) !==
          (agent.latestVersionNumber === 0 ? null : rowAgentLatestVersionId(this.database, agent))
      ) {
        throw catalogError('CATALOG_CORRUPT', 'Agent catalog lineage is inconsistent.');
      }
      for (const draft of drafts) {
        const expectedBase = versions
          .filter((version) => version.sourceDraft.draftRevision < draft.draftRevision)
          .at(-1)?.versionId;
        if (draft.baseVersionId !== (expectedBase ?? null)) {
          throw catalogError('CATALOG_CORRUPT', 'Draft base Version lineage is inconsistent.');
        }
      }
      for (const [index, version] of versions.entries()) {
        const source = drafts[version.sourceDraft.draftRevision - 1];
        const previousVersion = versions[index - 1];
        if (
          source === undefined ||
          source.draftId !== version.sourceDraft.draftId ||
          source.draftFingerprint !== version.sourceDraft.draftFingerprint ||
          source.definitionFingerprint !== version.definitionFingerprint ||
          source.baseVersionId !== (previousVersion?.versionId ?? null) ||
          (previousVersion !== undefined &&
            version.sourceDraft.draftRevision <= previousVersion.sourceDraft.draftRevision)
        ) {
          throw catalogError('CATALOG_CORRUPT', 'Version source Draft is inconsistent.');
        }
      }
    }
  }

  #draftRow(
    ref: CreatorAgentDraftRef | CreatorAgentDraftSnapshotV1,
  ): Record<string, unknown> | undefined {
    return this.database
      .prepare(
        `SELECT * FROM agent_catalog_drafts
          WHERE agent_id = ? AND draft_id = ? AND draft_revision = ?`,
      )
      .get(ref.agentId, ref.draftId, ref.draftRevision) as Record<string, unknown> | undefined;
  }

  #parseAgentRow(row: Record<string, unknown>): CreatorAgentCatalogAgent {
    return frozen({
      agentId: storedIdentifier(rowString(row, 'agent_id'), 'agentId'),
      draftId: storedIdentifier(rowString(row, 'draft_id'), 'draftId'),
      latestDraftRevision: positiveInteger(rowInteger(row, 'latest_draft_revision')),
      latestVersionNumber: nonnegativeInteger(rowInteger(row, 'latest_version_number')),
      createdAtMs: nonnegativeInteger(rowInteger(row, 'created_at_ms')),
    });
  }

  #parseDraftRow(row: Record<string, unknown>): CreatorAgentDraftSnapshotV1 {
    let handoff;
    try {
      handoff = parseCreatorAgentDraftHandoff(rowString(row, 'handoff_json'));
    } catch (error) {
      throw catalogError('CATALOG_CORRUPT', 'Stored Agent Draft handoff is invalid.', error);
    }
    const { draft } = handoff;
    nonnegativeInteger(rowInteger(row, 'imported_at_ms'));
    if (
      serializeCreatorAgentDraftSnapshot(draft) !== rowString(row, 'draft_json') ||
      draft.agentId !== rowString(row, 'agent_id') ||
      draft.draftId !== rowString(row, 'draft_id') ||
      draft.draftRevision !== rowInteger(row, 'draft_revision') ||
      draft.baseVersionId !== rowNullableString(row, 'base_version_id') ||
      draft.definitionFingerprint !== rowString(row, 'definition_fingerprint') ||
      draft.draftFingerprint !== rowString(row, 'draft_fingerprint') ||
      serializeCreatorAgentDraftHandoff(handoff) !== rowString(row, 'handoff_json')
    ) {
      throw catalogError('CATALOG_CORRUPT', 'Stored Agent Draft columns do not match.');
    }
    return draft;
  }

  #parseVersionRow(row: Record<string, unknown>): CreatorAgentVersionV1 {
    let version;
    try {
      version = parseCreatorAgentVersion(rowString(row, 'version_json'));
    } catch (error) {
      throw catalogError('CATALOG_CORRUPT', 'Stored Agent Version is invalid.', error);
    }
    if (
      version.agentId !== rowString(row, 'agent_id') ||
      version.versionId !== rowString(row, 'version_id') ||
      version.versionNumber !== rowInteger(row, 'version_number') ||
      version.sourceDraft.draftId !== rowString(row, 'source_draft_id') ||
      version.sourceDraft.draftRevision !== rowInteger(row, 'source_draft_revision') ||
      version.sourceDraft.draftFingerprint !== rowString(row, 'source_draft_fingerprint') ||
      version.definitionFingerprint !== rowString(row, 'definition_fingerprint') ||
      version.versionFingerprint !== rowString(row, 'version_fingerprint') ||
      version.createdAtMs !== rowInteger(row, 'created_at_ms') ||
      serializeCreatorAgentVersion(version) !== rowString(row, 'version_json')
    ) {
      throw catalogError('CATALOG_CORRUPT', 'Stored Agent Version columns do not match.');
    }
    return version;
  }

  #assertCurrentDraft(draft: CreatorAgentDraftSnapshotV1): void {
    const agent = this.database
      .prepare(
        'SELECT latest_draft_revision, draft_id FROM agent_catalog_agents WHERE agent_id = ?',
      )
      .get(draft.agentId) as Record<string, unknown> | undefined;
    if (
      agent === undefined ||
      rowString(agent, 'draft_id') !== draft.draftId ||
      rowInteger(agent, 'latest_draft_revision') !== draft.draftRevision
    ) {
      throw catalogError('CATALOG_DRAFT_NOT_CURRENT', 'Only the current Draft may be frozen.');
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw catalogError('CATALOG_CLOSED', 'Creator Agent catalog is closed.');
  }

  #rollback(): void {
    try {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
    } catch {
      // The caller receives the original failure; reopen validation remains fail-closed.
    }
  }
}

function confirmationText(draft: CreatorAgentDraftSnapshotV1): string {
  return `我已逐字检查这个 Creator Agent Draft，并授权冻结 agentId=${draft.agentId}、draftId=${draft.draftId}、draftRevision=${draft.draftRevision}、draftFingerprint=${draft.draftFingerprint}；若任一值变化，停止。`;
}

function snapshotDraftRef(input: CreatorAgentDraftRef): CreatorAgentDraftRef {
  const invalid = () => catalogError('CATALOG_NOT_FOUND', 'Agent Draft reference is invalid.');
  const values = snapshotDataRecord(input, ['agentId', 'draftId', 'draftRevision'], invalid);
  const agentId = checkedIdentifier(values.get('agentId'), 'agentId');
  const draftId = checkedIdentifier(values.get('draftId'), 'draftId');
  const draftRevision = checkedPositiveInteger(values.get('draftRevision'));
  return frozen({ agentId, draftId, draftRevision });
}

function snapshotVersionRef(input: CreatorAgentVersionRef): CreatorAgentVersionRef {
  const invalid = () => catalogError('CATALOG_NOT_FOUND', 'Agent Version reference is invalid.');
  const values = snapshotDataRecord(input, ['agentId', 'versionId'], invalid);
  return frozen({
    agentId: checkedIdentifier(values.get('agentId'), 'agentId'),
    versionId: checkedIdentifier(values.get('versionId'), 'versionId'),
  });
}

function snapshotFreezeRequest(input: unknown): Readonly<{
  ref: CreatorAgentDraftRef;
  confirmationText: string;
}> {
  const invalid = () => catalogError('CATALOG_CONFIRMATION_MISMATCH', 'Freeze request is invalid.');
  const values = snapshotDataRecord(input, ['ref', 'confirmationText'], invalid);
  const confirmation = values.get('confirmationText');
  if (typeof confirmation !== 'string') throw invalid();
  return frozen({
    ref: snapshotDraftRef(values.get('ref') as CreatorAgentDraftRef),
    confirmationText: confirmation,
  });
}

function snapshotDataRecord(
  input: unknown,
  expectedKeys: readonly string[],
  invalid: () => CreatorAgentCatalogError,
): ReadonlyMap<string, unknown> {
  if (typeof input !== 'object' || input === null || isProxy(input) || Array.isArray(input)) {
    throw invalid();
  }
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key)) ||
      expectedKeys.some((key) => !keys.includes(key))
    ) {
      throw invalid();
    }
    const values = new Map<string, unknown>();
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw invalid();
      }
      values.set(key, descriptor.value);
    }
    return values;
  } catch (error) {
    if (error instanceof CreatorAgentCatalogError) throw error;
    throw invalid();
  }
}

function rowAgentLatestVersionId(
  database: DatabaseSync,
  agent: CreatorAgentCatalogAgent,
): string | null {
  const row = requiredRow(
    database
      .prepare('SELECT latest_version_id FROM agent_catalog_agents WHERE agent_id = ?')
      .get(agent.agentId),
  );
  return rowNullableString(row, 'latest_version_id');
}

function requiredRow(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw catalogError('CATALOG_CORRUPT', 'Creator Agent catalog row is missing.');
  }
  return input as Record<string, unknown>;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw catalogError('CATALOG_CORRUPT', `Catalog column ${key} is not text.`);
  }
  return value;
}

function rowNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw catalogError('CATALOG_CORRUPT', `Catalog column ${key} is not nullable text.`);
  }
  return value;
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw catalogError('CATALOG_CORRUPT', `Catalog column ${key} is not an integer.`);
  }
  return value;
}

function assertIdentifier(value: string, label: string): void {
  checkedIdentifier(value, label);
}

function checkedIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw catalogError('CATALOG_NOT_FOUND', `${label} is invalid.`);
  }
  return value;
}

function storedIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw catalogError('CATALOG_CORRUPT', `Stored ${label} is invalid.`);
  }
  return value;
}

function checkedPositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw catalogError('CATALOG_NOT_FOUND', 'Draft revision is invalid.');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw catalogError('CATALOG_CORRUPT', 'Catalog positive integer is invalid.');
  }
  return value;
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw catalogError('CATALOG_CORRUPT', 'Catalog nonnegative integer is invalid.');
  }
  return value;
}

function frozen<Value extends object>(value: Value): Readonly<Value> {
  return Object.freeze(value);
}

function catalogError(
  code: CreatorAgentCatalogError['code'],
  message: string,
  cause?: unknown,
): CreatorAgentCatalogError {
  return new CreatorAgentCatalogError(
    code,
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}
