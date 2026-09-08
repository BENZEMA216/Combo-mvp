import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { compileCreatorAgentPackageDraftV2 } from '@cb/creator-worker/agent-package-compiler';
import {
  CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
  parseCreatorAgentPackageDraftSnapshotV2,
  reviseCreatorAgentPackageDraftV2,
  serializeCreatorAgentPackageDraftSnapshotV2,
} from '@cb/creator-agent-protocol/agent-package-draft';
import {
  parseCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
} from '@cb/creator-agent-protocol/agent-package';
import { withTransaction, type TxPool, type QueryableDb } from '../../platform/infra/db-tx.js';
import type { ImmutableObjectStore } from '../../platform/infra/object-store.js';

export const MAX_SNAPSHOT_BYTES = 524_288;
export const DraftId = z.string().regex(/^draft\.agent-package\.[0-9a-f]{32}$/u);
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Candidate = z
  .object({
    manifestText: z.string().min(1).max(65_536),
    packageDigest: Digest,
    compilationReceiptText: z.string().min(1).max(65_536),
    files: z
      .array(
        z
          .object({ path: z.string().min(1).max(240), text: z.string().min(1).max(131_072) })
          .strict(),
      )
      .min(1)
      .max(31),
  })
  .strict();
const Upload = z
  .object({
    protocol: z.literal('combo.agent-draft-upload/1'),
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    draftText: z.string().min(1).max(65_536),
    candidate: Candidate,
  })
  .strict();
const Snapshot = z
  .object({
    protocol: z.literal('combo.private-agent-revision/1'),
    draftText: z.string().min(1).max(65_536),
    candidate: Candidate,
  })
  .strict();
type Snapshot = z.infer<typeof Snapshot>;

export class AgentDraftFailure extends Error {
  constructor(
    readonly kind: 'validation' | 'revision_conflict' | 'idempotency_conflict' | 'unavailable',
  ) {
    super(`Agent Draft ${kind}`);
    this.name = 'AgentDraftFailure';
  }
}
export interface DraftRow {
  owner_user_id: string;
  draft_id: string;
  revision: number;
  draft_fingerprint: string;
  parent_fingerprint: string | null;
  package_digest: string;
  snapshot_digest: string;
  snapshot_bytes: number;
  request_id: string;
  view_id: string;
  created_at: string | Date;
}
type NewRevision = Omit<DraftRow, 'view_id' | 'created_at'>;
export interface DraftRepository {
  save(
    input: NewRevision,
    commit: (previous: DraftRow | null) => Promise<void>,
  ): Promise<{ row: DraftRow; created: boolean }>;
  read(owner: string, draftId: string, revision: number): Promise<DraftRow | null>;
}

/** One append-only revision table; the blob is private and no Release is created here. */
export class PgDraftRepository implements DraftRepository {
  constructor(
    private pool: TxPool,
    private db: QueryableDb,
  ) {}
  async save(input: NewRevision, commit: (previous: DraftRow | null) => Promise<void>) {
    return withTransaction(this.pool, async (tx) => {
      // Fixed lock order also serializes the same request reused across different Drafts.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `agent-draft-request:${input.owner_user_id}:${input.request_id}`,
      ]);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `agent-draft:${input.owner_user_id}:${input.draft_id}`,
      ]);
      const existing = (
        await tx.query<DraftRow>(
          'SELECT * FROM agent_draft_revisions WHERE owner_user_id = $1::uuid AND request_id = $2::uuid',
          [input.owner_user_id, input.request_id],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.snapshot_digest !== input.snapshot_digest ||
          existing.draft_id !== input.draft_id ||
          Number(existing.revision) !== input.revision
        )
          throw new AgentDraftFailure('idempotency_conflict');
        return { row: existing, created: false };
      }
      const latest = (
        await tx.query<DraftRow>(
          'SELECT * FROM agent_draft_revisions WHERE owner_user_id = $1::uuid AND draft_id = $2 ORDER BY revision DESC LIMIT 1',
          [input.owner_user_id, input.draft_id],
        )
      ).rows[0];
      if (
        input.revision !== (latest ? Number(latest.revision) + 1 : 1) ||
        input.parent_fingerprint !== (latest?.draft_fingerprint ?? null)
      )
        throw new AgentDraftFailure('revision_conflict');
      await commit(latest ?? null);
      const result = await tx.query<DraftRow>(
        `INSERT INTO agent_draft_revisions
         (owner_user_id, draft_id, revision, draft_fingerprint, parent_fingerprint, package_digest,
          snapshot_digest, snapshot_bytes, request_id, view_id)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10::uuid) RETURNING *`,
        [
          input.owner_user_id,
          input.draft_id,
          input.revision,
          input.draft_fingerprint,
          input.parent_fingerprint,
          input.package_digest,
          input.snapshot_digest,
          input.snapshot_bytes,
          input.request_id,
          latest?.view_id ?? randomUUID(),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new AgentDraftFailure('unavailable');
      return { row, created: true };
    });
  }
  async read(owner: string, draftId: string, revision: number) {
    return (
      (
        await this.db.query<DraftRow>(
          'SELECT * FROM agent_draft_revisions WHERE owner_user_id = $1::uuid AND draft_id = $2 AND revision = $3',
          [owner, draftId, revision],
        )
      ).rows[0] ?? null
    );
  }
}

const sha = (value: Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function objectInput(row: NewRevision) {
  return {
    bucket: 'combo-artifacts' as const,
    key: `private-agent-drafts/${row.owner_user_id}/${row.draft_id}/${row.snapshot_digest.slice(7)}.json`,
    maxBytes: row.snapshot_bytes,
  };
}
function prepare(owner: string, body: unknown) {
  try {
    const ownerUserId = z.string().uuid().parse(owner).toLowerCase();
    const upload = Upload.parse(body);
    const compiled = compileCreatorAgentPackageDraftV2(upload.draftText);
    const draft = parseCreatorAgentPackageDraftSnapshotV2(upload.draftText);
    const candidate = upload.candidate;
    if (
      candidate.packageDigest !== compiled.packageDigest ||
      candidate.manifestText !== compiled.manifestText ||
      candidate.compilationReceiptText !== compiled.compilationReceiptText ||
      candidate.files.length !== compiled.files.length ||
      new Set(candidate.files.map((file) => file.path)).size !== candidate.files.length ||
      compiled.files.some(
        (file) => candidate.files.find((other) => other.path === file.path)?.text !== file.text,
      )
    )
      throw new Error('candidate mismatch');
    // This is a storage envelope, not another Agent definition. Preserve all reviewed file bytes.
    const snapshot: Snapshot = {
      protocol: 'combo.private-agent-revision/1',
      draftText: upload.draftText,
      candidate: {
        ...candidate,
        files: [...candidate.files].sort((a, b) => (a.path < b.path ? -1 : 1)),
      },
    };
    const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8');
    if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('too large');
    const row: NewRevision = {
      owner_user_id: ownerUserId,
      draft_id: draft.draftId,
      revision: draft.revision,
      draft_fingerprint: draft.draftFingerprint,
      parent_fingerprint: draft.parentDraftFingerprint,
      package_digest: candidate.packageDigest,
      snapshot_digest: sha(bytes),
      snapshot_bytes: bytes.length,
      request_id: upload.requestId,
    };
    return { row, bytes, draft };
  } catch {
    throw new AgentDraftFailure('validation');
  }
}

/** Stored source claims remain unverified; compiling is not Desktop source attestation. */
function projectRecord(row: DraftRow, snapshot: Snapshot) {
  const draft = parseCreatorAgentPackageDraftSnapshotV2(snapshot.draftText);
  const manifest = parseCreatorAgentPackageManifest(snapshot.candidate.manifestText);
  if (
    draft.draftId !== row.draft_id ||
    draft.revision !== Number(row.revision) ||
    draft.draftFingerprint !== row.draft_fingerprint ||
    digestCreatorAgentPackage(manifest) !== row.package_digest ||
    snapshot.candidate.packageDigest !== row.package_digest
  )
    throw new AgentDraftFailure('unavailable');
  const files = snapshot.candidate.files;
  if (
    manifest.files.length !== files.length ||
    manifest.files.some((entry) => {
      const file = files.find((candidate) => candidate.path === entry.path);
      return (
        !file ||
        Buffer.byteLength(file.text, 'utf8') !== entry.byteLength ||
        digestCreatorAgentPackageFile(Buffer.from(file.text, 'utf8')) !== entry.digest
      );
    })
  )
    throw new AgentDraftFailure('unavailable');
  return {
    protocol: 'combo.agent-draft-record/1' as const,
    visibility: 'private' as const,
    sourceVerification: 'not_verified' as const,
    draft: {
      draftId: draft.draftId,
      revision: draft.revision,
      fingerprint: draft.draftFingerprint,
      text: snapshot.draftText,
    },
    candidate: snapshot.candidate,
    savedAt: new Date(row.created_at).toISOString(),
    card: {
      protocol: 'combo.agent-card-view/1',
      viewId: row.view_id,
      sequence: draft.revision,
      dataMode: 'real',
      audience: 'creator',
      status: 'ready',
      agent: {
        name: manifest.name,
        description: manifest.description,
        included: `工作约定与 ${manifest.skills.length} 项 Skill。`,
        excluded: '此卡片仅展示已保存的 Package 文件，不附带制作对话。',
        sourceSummary: '私有保存已完成；Desktop 来源尚未核验，暂不能发布或试用。',
        requirements: [],
        starters: [...draft.content.starterPrompts],
        sections: [
          {
            kind: 'instructions',
            title: '方法与工作约定',
            summary: 'Agent · AGENT.md',
            paths: ['AGENT.md'],
          },
          ...(manifest.skills.length
            ? [
                {
                  kind: 'skill',
                  title: 'Skills',
                  summary: `${manifest.skills.length} 项方法`,
                  paths: [...manifest.skills],
                },
              ]
            : []),
        ],
        compiled: {
          packageDigest: row.package_digest,
          files: [{ path: 'agent.json', text: snapshot.candidate.manifestText }, ...files],
        },
      },
      actions: {
        share: false,
        queryShare: false,
        trial: false,
        modify: false,
        stop: false,
        install: false,
      },
    },
  };
}
export class AgentDraftService {
  constructor(
    private repository: DraftRepository,
    private objects: ImmutableObjectStore,
  ) {}
  async save(owner: string, body: unknown) {
    const { row, bytes, draft } = prepare(owner, body);
    try {
      const result = await this.repository.save(row, async (previous) => {
        if (previous) {
          // Keep the original source and creator request fixed, under the same Draft lock.
          const stored = await this.readRow(previous);
          try {
            const expected = reviseCreatorAgentPackageDraftV2(
              parseCreatorAgentPackageDraftSnapshotV2(stored.draft.text),
              {
                protocol: CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
                draftId: draft.draftId,
                baseRevision: Number(previous.revision),
                baseDraftFingerprint: previous.draft_fingerprint,
                changes: draft.content,
              },
            );
            if (
              serializeCreatorAgentPackageDraftSnapshotV2(expected) !==
              serializeCreatorAgentPackageDraftSnapshotV2(draft)
            )
              throw new Error('revision mismatch');
          } catch {
            throw new AgentDraftFailure('revision_conflict');
          }
        }
        const input = objectInput(row);
        await this.objects.commit({ ...input, bytes, contentType: 'application/json' });
        const readback = await this.objects.read(input);
        if (!Buffer.from(readback).equals(bytes)) throw new AgentDraftFailure('unavailable');
      });
      // Always reread the committed object, including a retry after a lost HTTP response.
      return { record: await this.readRow(result.row), created: result.created };
    } catch (error) {
      if (error instanceof AgentDraftFailure) throw error;
      throw new AgentDraftFailure('unavailable');
    }
  }
  async read(owner: string, draftId: string, revision: number) {
    if (
      !z.string().uuid().safeParse(owner).success ||
      !DraftId.safeParse(draftId).success ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      throw new AgentDraftFailure('validation');
    try {
      const row = await this.repository.read(owner, draftId, revision);
      if (!row) return null;
      return await this.readRow(row);
    } catch (error) {
      if (error instanceof AgentDraftFailure) throw error;
      throw new AgentDraftFailure('unavailable');
    }
  }
  private async readRow(row: DraftRow) {
    if (
      !Number.isSafeInteger(row.snapshot_bytes) ||
      row.snapshot_bytes < 1 ||
      row.snapshot_bytes > MAX_SNAPSHOT_BYTES
    )
      throw new AgentDraftFailure('unavailable');
    const bytes = await this.objects.read(objectInput(row));
    if (bytes.length !== row.snapshot_bytes || sha(bytes) !== row.snapshot_digest)
      throw new AgentDraftFailure('unavailable');
    const snapshot = Snapshot.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    return projectRecord(row, snapshot);
  }
}
