import {
  CODEX_AGENT_SHARE_SCHEMA_VERSION,
  CodexAgentShareManifestSchema,
  canonicalJson,
  type CodexAgentShareManifest,
} from '@cb/shared';
import { createHash } from 'node:crypto';
import { toIso, type Queryable } from '../../platform/infra/db.js';

interface CodexAgentShareRow {
  id: string;
  owner_user_id: string;
  share_token: string;
  manifest: unknown;
  manifest_sha256: string;
  idempotency_key: string;
  idempotency_sha256: string;
  created_at: string | Date;
}

export interface CodexAgentShareRecord {
  shareToken: string;
  manifest: CodexAgentShareManifest;
  manifestSha256: string;
  idempotencySha256: string;
}

const SHARE_COLUMNS = `id, owner_user_id, share_token, manifest, manifest_sha256,
  idempotency_key, idempotency_sha256, created_at`;

function isCodexAgentManifest(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === CODEX_AGENT_SHARE_SCHEMA_VERSION
  );
}

function toRecord(row: CodexAgentShareRow): CodexAgentShareRecord {
  const manifest = CodexAgentShareManifestSchema.parse(row.manifest);
  if (manifest.createdAt !== toIso(row.created_at)) {
    throw new Error('codex agent share createdAt integrity mismatch');
  }
  const actualManifestSha256 = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  if (actualManifestSha256 !== row.manifest_sha256) {
    throw new Error('codex agent share manifest digest mismatch');
  }
  return {
    shareToken: row.share_token,
    manifest,
    manifestSha256: row.manifest_sha256,
    idempotencySha256: row.idempotency_sha256,
  };
}

export type CreateCodexAgentShareOutcome =
  | { kind: 'created' | 'replayed'; record: CodexAgentShareRecord }
  | { kind: 'idempotency_conflict' };

export async function insertCodexAgentShare(
  db: Queryable,
  input: {
    ownerUserId: string;
    shareToken: string;
    manifest: CodexAgentShareManifest;
    manifestSha256: string;
    idempotencyKey: string;
    idempotencySha256: string;
  },
): Promise<CreateCodexAgentShareOutcome> {
  const inserted = await db.query<CodexAgentShareRow>(
    `INSERT INTO project_agent_shares
       (owner_user_id, share_token, manifest, manifest_sha256,
        idempotency_key, idempotency_sha256, created_at)
     VALUES ($1, $2, $3::jsonb, $4, $5::uuid, $6, $7::timestamptz)
     ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING
     RETURNING ${SHARE_COLUMNS}`,
    [
      input.ownerUserId,
      input.shareToken,
      JSON.stringify(input.manifest),
      input.manifestSha256,
      input.idempotencyKey,
      input.idempotencySha256,
      input.manifest.createdAt,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { kind: 'created', record: toRecord(created) };

  const existing = await db.query<CodexAgentShareRow>(
    `SELECT ${SHARE_COLUMNS}
       FROM project_agent_shares
      WHERE owner_user_id = $1 AND idempotency_key = $2::uuid
      LIMIT 1`,
    [input.ownerUserId, input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.idempotency_sha256 !== input.idempotencySha256 ||
    !isCodexAgentManifest(row.manifest)
  ) {
    return { kind: 'idempotency_conflict' };
  }
  return { kind: 'replayed', record: toRecord(row) };
}

/** Public Codex Agent share read: intentionally has no owner predicate. */
export async function readCodexAgentShareByToken(
  db: Queryable,
  shareToken: string,
): Promise<CodexAgentShareRecord | null> {
  const result = await db.query<CodexAgentShareRow>(
    `SELECT ${SHARE_COLUMNS}
       FROM project_agent_shares
      WHERE share_token = $1
      LIMIT 1`,
    [shareToken],
  );
  const row = result.rows[0];
  if (!row || !isCodexAgentManifest(row.manifest)) return null;
  return toRecord(row);
}
