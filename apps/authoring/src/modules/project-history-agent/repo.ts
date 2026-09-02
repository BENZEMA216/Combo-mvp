import { createHash } from 'node:crypto';

import {
  parseAgentPackageShareV2,
  serializeAgentPackageShareV2,
} from '@cb/creator-agent-protocol/agent-package-share';
import {
  parseCreatorAgentPackageDraftSnapshotV3,
  serializeCreatorAgentPackageDraftSnapshotV3,
} from '@cb/creator-agent-protocol/agent-package-draft';

import { toIso, type Queryable } from '../../platform/infra/db.js';
import { withTransaction, type QueryableDb, type TxPool } from '../../platform/infra/db-tx.js';
import type {
  ProjectHistoryAgentRepository,
  StoredProjectHistoryAgentConfirmation,
  StoredProjectHistoryAgentDraft,
  StoredProjectHistoryAgentShare,
} from './service.js';
import { PROJECT_HISTORY_AGENT_CONFIRMATION_TTL_MS } from './contracts.js';

interface DraftRow {
  draft_id: string;
  revision: string | number;
  owner_user_id: string;
  draft_fingerprint: string;
  candidate_commitment: string;
  draft_json: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: string | Date;
}

interface ConfirmationRow extends DraftRow {
  confirmation_token_sha256: string;
  expires_at: string | Date;
  consumed_at: string | Date | null;
  consumed_share_token: string | null;
  checked_at: string | Date;
}

interface LockedConfirmationRow {
  owner_user_id: string;
  draft_id: string;
  revision: string | number;
  draft_fingerprint: string;
  expires_at: string | Date;
  consumed_at: string | Date | null;
  checked_at: string | Date;
}

class ConfirmationExpiredDuringConsumptionError extends Error {}

interface ShareRow {
  share_token: string;
  owner_user_id: string;
  draft_id: string;
  source_draft_fingerprint: string;
  confirmation_token_sha256: string;
  package_digest: string;
  idempotency_key: string;
  request_fingerprint: string;
  share_url: string;
  share_json: string;
  share_json_sha256: string;
  copy_prompt: string;
}

const DRAFT_COLUMNS = `draft_id, revision, owner_user_id, draft_fingerprint,
  candidate_commitment, draft_json, idempotency_key, request_fingerprint, created_at`;
const SHARE_COLUMNS = `share_token, owner_user_id, draft_id, source_draft_fingerprint,
  confirmation_token_sha256, package_digest, idempotency_key, request_fingerprint,
  share_url, share_json, share_json_sha256, copy_prompt`;

function toDraft(row: DraftRow): StoredProjectHistoryAgentDraft {
  const draft = parseCreatorAgentPackageDraftSnapshotV3(row.draft_json);
  if (
    draft.draftId !== row.draft_id ||
    draft.revision !== Number(row.revision) ||
    draft.draftFingerprint !== row.draft_fingerprint ||
    draft.source.candidateCommitment !== row.candidate_commitment ||
    row.request_fingerprint !== row.candidate_commitment
  ) {
    throw new Error('persisted Project-history Draft materialization mismatch');
  }
  return Object.freeze({
    ownerUserId: row.owner_user_id,
    draft,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdAt: toIso(row.created_at),
  });
}

function toShare(row: ShareRow): StoredProjectHistoryAgentShare {
  if (sha256Text(row.share_json) !== row.share_json_sha256) {
    throw new Error('persisted Project-history share materialization mismatch');
  }
  const share = parseAgentPackageShareV2(row.share_json);
  let shareUrl: URL;
  if (row.share_url.includes('?') || row.share_url.includes('#')) {
    throw new TypeError('Stored Project-history Agent share URL is invalid');
  }
  try {
    shareUrl = new URL(row.share_url);
  } catch {
    throw new Error('persisted Project-history share materialization mismatch');
  }
  const expectedCopyPrompt = `在 Codex 中打开 ${row.share_url}，先读取权威 Package 摘要，再选择一个起始任务。`;
  const expectedRequestFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        draftId: row.draft_id,
        draftFingerprint: row.source_draft_fingerprint,
        confirmationTokenDigest: row.confirmation_token_sha256,
      }),
      'utf8',
    )
    .digest('hex');
  if (
    share.sourceDraftFingerprint !== row.source_draft_fingerprint ||
    share.packageDigest !== row.package_digest ||
    shareUrl.pathname !== `/api/v1/agent-package-shares/${row.share_token}` ||
    shareUrl.search !== '' ||
    shareUrl.hash !== '' ||
    shareUrl.username !== '' ||
    shareUrl.password !== '' ||
    shareUrl.toString() !== row.share_url ||
    row.copy_prompt !== expectedCopyPrompt ||
    row.request_fingerprint !== expectedRequestFingerprint
  ) {
    throw new Error('persisted Project-history share materialization mismatch');
  }
  return Object.freeze({
    ownerUserId: row.owner_user_id,
    draftId: row.draft_id,
    draftFingerprint: row.source_draft_fingerprint,
    confirmationTokenDigest: row.confirmation_token_sha256,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    shareToken: row.share_token,
    shareUrl: row.share_url,
    share,
    copyPrompt: row.copy_prompt,
  });
}

async function readShareByIdempotencyFrom(
  db: QueryableDb,
  ownerUserId: string,
  idempotencyKey: string,
): Promise<StoredProjectHistoryAgentShare | null> {
  const result = await db.query<ShareRow>(
    `SELECT ${SHARE_COLUMNS}
      FROM project_history_agent_shares
      WHERE owner_user_id = $1 AND idempotency_key = $2`,
    [ownerUserId, idempotencyKey],
  );
  return result.rows[0] ? toShare(result.rows[0]) : null;
}

export class PgProjectHistoryAgentRepository implements ProjectHistoryAgentRepository {
  constructor(
    private readonly pool: TxPool,
    private readonly db: Queryable,
  ) {}

  async createDraft(record: StoredProjectHistoryAgentDraft) {
    const inserted = await this.db.query<DraftRow>(
      `INSERT INTO project_history_agent_drafts (
         draft_id, revision, owner_user_id, draft_fingerprint, candidate_commitment,
         draft_json, idempotency_key, request_fingerprint, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING
       RETURNING ${DRAFT_COLUMNS}`,
      [
        record.draft.draftId,
        record.draft.revision,
        record.ownerUserId,
        record.draft.draftFingerprint,
        record.draft.source.candidateCommitment,
        serializeCreatorAgentPackageDraftSnapshotV3(record.draft),
        record.idempotencyKey,
        record.requestFingerprint,
        record.createdAt,
      ],
    );
    if (inserted.rows[0]) return { kind: 'created' as const, record: toDraft(inserted.rows[0]) };
    const existing = await this.db.query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS}
         FROM project_history_agent_drafts
        WHERE owner_user_id = $1 AND idempotency_key = $2`,
      [record.ownerUserId, record.idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('Project-history Draft insert conflicted without idempotency row');
    const value = toDraft(row);
    return value.requestFingerprint === record.requestFingerprint
      ? { kind: 'existing' as const, record: value }
      : { kind: 'conflict' as const };
  }

  async readDraft(ownerUserId: string, draftId: string) {
    const result = await this.db.query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS}
         FROM project_history_agent_drafts
        WHERE owner_user_id = $1 AND draft_id = $2`,
      [ownerUserId, draftId],
    );
    return result.rows[0] ? toDraft(result.rows[0]) : null;
  }

  async issueConfirmation(
    record: StoredProjectHistoryAgentConfirmation,
  ): Promise<StoredProjectHistoryAgentConfirmation> {
    const result = await this.db.query<{
      confirmation_token_sha256: string;
      created_at: string | Date;
      expires_at: string | Date;
    }>(
      `SELECT confirmation_token_sha256, created_at, expires_at
         FROM issue_project_history_agent_confirmation($1, $2, $3, $4, $5)`,
      [
        record.ownerUserId,
        record.draftId,
        record.revision,
        record.draftFingerprint,
        record.tokenDigest,
      ],
    );
    const issued = result.rows[0];
    if (!issued) throw new Error('Project-history confirmation mint returned no result');
    const createdAt = toIso(issued.created_at);
    const expiresAt = toIso(issued.expires_at);
    if (
      issued.confirmation_token_sha256 !== record.tokenDigest ||
      Date.parse(expiresAt) - Date.parse(createdAt) !== PROJECT_HISTORY_AGENT_CONFIRMATION_TTL_MS
    ) {
      throw new Error('persisted Project-history confirmation materialization mismatch');
    }
    return Object.freeze({ ...record, expiresAt });
  }

  async resolveConfirmation(input: {
    ownerUserId: string;
    draftId: string;
    draftFingerprint: string;
    tokenDigest: string;
    now: string;
  }) {
    const result = await this.db.query<ConfirmationRow>(
      `SELECT d.draft_id, d.revision, d.owner_user_id, d.draft_fingerprint,
              d.candidate_commitment, d.draft_json, d.idempotency_key,
              d.request_fingerprint, d.created_at,
              c.confirmation_token_sha256, c.expires_at, c.consumed_at,
              c.consumed_share_token, clock_timestamp() AS checked_at
         FROM project_history_agent_confirmations c
         JOIN project_history_agent_drafts d
           ON d.owner_user_id = c.owner_user_id
          AND d.draft_id = c.draft_id
          AND d.revision = c.revision
          AND d.draft_fingerprint = c.draft_fingerprint
        WHERE c.confirmation_token_sha256 = $1
          AND c.owner_user_id = $2
          AND c.draft_id = $3`,
      [input.tokenDigest, input.ownerUserId, input.draftId],
    );
    const row = result.rows[0];
    if (!row || row.consumed_at !== null || toIso(row.expires_at) <= toIso(row.checked_at)) {
      return { kind: 'invalid' as const };
    }
    const draft = toDraft(row);
    if (draft.draft.draftFingerprint !== input.draftFingerprint) {
      return { kind: 'stale' as const };
    }
    return { kind: 'valid' as const, draft };
  }

  readShareByIdempotency(ownerUserId: string, idempotencyKey: string) {
    return readShareByIdempotencyFrom(this.db, ownerUserId, idempotencyKey);
  }

  async consumeConfirmationAndCreateShare(input: {
    record: StoredProjectHistoryAgentShare;
    now: string;
  }) {
    const record = input.record;
    try {
      return await withTransaction(this.pool, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `project-history-agent-share-idempotency:${record.ownerUserId}:${record.idempotencyKey}`,
        ]);
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `project-history-agent-share-draft:${record.ownerUserId}:${record.draftFingerprint}`,
        ]);
        const existing = await readShareByIdempotencyFrom(
          tx,
          record.ownerUserId,
          record.idempotencyKey,
        );
        if (existing) {
          return existing.requestFingerprint === record.requestFingerprint
            ? { kind: 'existing' as const, record: existing }
            : { kind: 'idempotency_conflict' as const };
        }
        const confirmationResult = await tx.query<LockedConfirmationRow>(
          `SELECT owner_user_id, draft_id, revision, draft_fingerprint, expires_at, consumed_at,
                clock_timestamp() AS checked_at
           FROM project_history_agent_confirmations
          WHERE confirmation_token_sha256 = $1
          FOR UPDATE`,
          [record.confirmationTokenDigest],
        );
        const confirmation = confirmationResult.rows[0];
        const racedExisting = await readShareByIdempotencyFrom(
          tx,
          record.ownerUserId,
          record.idempotencyKey,
        );
        if (racedExisting) {
          return racedExisting.requestFingerprint === record.requestFingerprint
            ? { kind: 'existing' as const, record: racedExisting }
            : { kind: 'idempotency_conflict' as const };
        }
        if (
          !confirmation ||
          confirmation.owner_user_id !== record.ownerUserId ||
          confirmation.draft_id !== record.draftId ||
          confirmation.draft_fingerprint !== record.draftFingerprint ||
          confirmation.consumed_at !== null ||
          toIso(confirmation.expires_at) <= toIso(confirmation.checked_at)
        ) {
          return { kind: 'confirmation_invalid' as const };
        }
        const draft = await tx.query<{ draft_fingerprint: string }>(
          `SELECT draft_fingerprint
           FROM project_history_agent_drafts
          WHERE owner_user_id = $1 AND draft_id = $2 AND revision = $3`,
          [record.ownerUserId, record.draftId, Number(confirmation.revision)],
        );
        if (draft.rows[0]?.draft_fingerprint !== record.draftFingerprint) {
          return { kind: 'draft_stale' as const };
        }
        const duplicateDraft = await tx.query<{ share_token: string }>(
          `SELECT share_token
           FROM project_history_agent_shares
          WHERE owner_user_id = $1 AND source_draft_fingerprint = $2`,
          [record.ownerUserId, record.draftFingerprint],
        );
        if (duplicateDraft.rows[0]) return { kind: 'idempotency_conflict' as const };

        const shareJson = serializeAgentPackageShareV2(record.share);
        const inserted = await tx.query<ShareRow>(
          `INSERT INTO project_history_agent_shares (
           share_token, owner_user_id, draft_id, draft_revision, source_draft_fingerprint,
           confirmation_token_sha256, package_digest, share_url, share_json, share_json_sha256,
           copy_prompt, idempotency_key, request_fingerprint
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING ${SHARE_COLUMNS}`,
          [
            record.shareToken,
            record.ownerUserId,
            record.draftId,
            Number(confirmation.revision),
            record.draftFingerprint,
            record.confirmationTokenDigest,
            record.share.packageDigest,
            record.shareUrl,
            shareJson,
            sha256Text(shareJson),
            record.copyPrompt,
            record.idempotencyKey,
            record.requestFingerprint,
          ],
        );
        const consumed = await tx.query<{ confirmation_token_sha256: string }>(
          `WITH database_clock AS (SELECT clock_timestamp() AS consumed_at)
         UPDATE project_history_agent_confirmations AS confirmation
            SET consumed_at = database_clock.consumed_at, consumed_share_token = $2
           FROM database_clock
          WHERE confirmation.confirmation_token_sha256 = $1
            AND confirmation.consumed_at IS NULL
            AND confirmation.expires_at > database_clock.consumed_at
          RETURNING confirmation_token_sha256`,
          [record.confirmationTokenDigest, record.shareToken],
        );
        if (
          consumed.rows.length !== 1 ||
          consumed.rows[0]?.confirmation_token_sha256 !== record.confirmationTokenDigest
        ) {
          throw new ConfirmationExpiredDuringConsumptionError();
        }
        return { kind: 'created' as const, record: toShare(inserted.rows[0]!) };
      });
    } catch (error) {
      if (error instanceof ConfirmationExpiredDuringConsumptionError) {
        return { kind: 'confirmation_invalid' as const };
      }
      throw error;
    }
  }

  async readShareByToken(shareToken: string) {
    const result = await this.db.query<ShareRow>(
      `SELECT ${SHARE_COLUMNS}
         FROM project_history_agent_shares
        WHERE share_token = $1`,
      [shareToken],
    );
    return result.rows[0] ? toShare(result.rows[0]) : null;
  }
}

/**
 * Bounded maintenance entry. The API role has no table DELETE; the SECURITY DEFINER function can
 * delete only already-consumed or expired confirmations and is safe under concurrent schedulers.
 */
export async function cleanupRetiredProjectHistoryAgentConfirmations(
  db: Queryable,
  batchSize: number,
): Promise<number> {
  const boundedBatchSize = Math.max(1, Math.min(Math.trunc(batchSize), 100));
  const result = await db.query<{ confirmations_deleted: number | string }>(
    `SELECT confirmations_deleted
       FROM cleanup_retired_project_history_confirmations($1)`,
    [boundedBatchSize],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Project-history confirmation cleanup returned no result');
  return Number(row.confirmations_deleted);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
