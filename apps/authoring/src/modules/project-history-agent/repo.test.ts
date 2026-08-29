import { createHash } from 'node:crypto';

import {
  createAgentPackageBundle,
  createAgentPackageShareV2,
  serializeAgentPackageShareV2,
} from '@cb/creator-agent-protocol/agent-package-share';
import {
  commitCreatorAgentPackageProjectHistoryCandidate,
  createCreatorAgentPackageCreatorRequestV3,
  createCreatorAgentPackageDraftSnapshotV3,
  serializeCreatorAgentPackageDraftSnapshotV3,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { describe, expect, it } from 'vitest';

import type { Queryable } from '../../platform/infra/db.js';
import type { TxPool } from '../../platform/infra/db-tx.js';
import {
  cleanupRetiredProjectHistoryAgentConfirmations,
  PgProjectHistoryAgentRepository,
} from './repo.js';
import { buildCreatorAgentPackageFromProjectHistoryDraft } from './package-builder.js';

const OWNER = '00000000-0000-4000-8000-000000000001';
const NOW = '2026-08-29T00:00:00.000Z';
const IDENTITY_POOL = { connect: async () => Promise.reject(new Error('unused')) } as TxPool;

function fixtures() {
  const creatorRequest = createCreatorAgentPackageCreatorRequestV3({
    protocol: 'combo.agent-package-creator-request/3',
    intent: 'create_agent_package_from_project_task_history',
    request: '把这个 Project 里以前完成过的方法做成一个 Agent。',
  });
  const candidate = {
    name: '证据核验员',
    description: '按历史任务中形成的方法核对证据。',
    instructions: '先核对候选身份，再验证运行证据，最后给出结论。',
    starterPrompts: ['检查这次发布。'],
    outputDescription: '返回结论、证据和边界。',
  } as const;
  const sourceEvidence = {
    kind: 'host_project_scoped_reduced_history',
    selection: 'user_selected_saved_project',
    assurance: 'best_effort',
    completeness: 'not_proven',
    hostAttestation: 'not_proven',
    sourceProjectionEnforced: 'not_proven',
    rawStored: false,
    projectCount: 1,
    discoveredThreadCount: 2,
    readThreadCount: 2,
    omittedThreadCount: 1,
    completedTurnCount: 8,
    userVisibleMessageCount: 12,
    omittedItemCount: 3,
    limitationReasons: [
      'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
      'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
      'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
    ],
  } as const;
  const candidateCommitment = commitCreatorAgentPackageProjectHistoryCandidate({
    creatorRequest,
    candidate,
    sourceEvidence,
  });
  const draft = createCreatorAgentPackageDraftSnapshotV3({
    protocol: 'combo.agent-package-draft/3',
    draftId: `draft.agent-package.${'1'.repeat(32)}`,
    revision: 1,
    parentDraftFingerprint: null,
    creatorRequest,
    source: { ...sourceEvidence, candidateCommitment },
    content: candidate,
  });
  const draftRow = {
    draft_id: draft.draftId,
    revision: draft.revision,
    owner_user_id: OWNER,
    draft_fingerprint: draft.draftFingerprint,
    candidate_commitment: candidateCommitment,
    draft_json: serializeCreatorAgentPackageDraftSnapshotV3(draft),
    idempotency_key: '10000000-0000-4000-8000-000000000001',
    request_fingerprint: candidateCommitment,
    created_at: NOW,
  };
  const built = buildCreatorAgentPackageFromProjectHistoryDraft(draft);
  const bundle = createAgentPackageBundle({
    manifest: built.manifest,
    files: built.files.map((file) => ({
      path: file.path,
      contentBase64: Buffer.from(file.text, 'utf8').toString('base64'),
    })),
  });
  const share = createAgentPackageShareV2({
    schemaVersion: 'combo.agent-package-share/2',
    releaseId: `release.agent-package.${'2'.repeat(32)}`,
    sourceDraftFingerprint: draft.draftFingerprint,
    packageDigest: built.packageDigest,
    package: bundle,
    starterPrompts: candidate.starterPrompts,
    createdAt: NOW,
  });
  const shareToken = 'A'.repeat(43);
  const shareUrl = `https://combo.example/api/v1/agent-package-shares/${shareToken}`;
  const confirmationTokenDigest = 'b'.repeat(64);
  const requestFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        draftId: draft.draftId,
        draftFingerprint: draft.draftFingerprint,
        confirmationTokenDigest,
      }),
      'utf8',
    )
    .digest('hex');
  const shareRow = {
    share_token: shareToken,
    owner_user_id: OWNER,
    draft_id: draft.draftId,
    source_draft_fingerprint: draft.draftFingerprint,
    confirmation_token_sha256: confirmationTokenDigest,
    package_digest: built.packageDigest,
    idempotency_key: '20000000-0000-4000-8000-000000000001',
    request_fingerprint: requestFingerprint,
    share_url: shareUrl,
    share_json: serializeAgentPackageShareV2(share),
    share_json_sha256: createHash('sha256')
      .update(serializeAgentPackageShareV2(share), 'utf8')
      .digest('hex'),
    copy_prompt: `在 Codex 中打开 ${shareUrl}，先读取权威 Package 摘要，再选择一个起始任务。`,
  };
  return { draft, draftRow, share, shareRow };
}

function repositoryReturning(row: Record<string, unknown>) {
  const db = {
    async query() {
      return { rows: [row], rowCount: 1 };
    },
  } as Queryable;
  return new PgProjectHistoryAgentRepository(IDENTITY_POOL, db);
}

describe('PgProjectHistoryAgentRepository materialized integrity', () => {
  it('accepts exact authoritative Draft/share rows', async () => {
    const { draftRow, shareRow } = fixtures();
    await expect(
      repositoryReturning(draftRow).readDraft(OWNER, draftRow.draft_id),
    ).resolves.toMatchObject({
      draft: { draftFingerprint: draftRow.draft_fingerprint },
    });
    await expect(
      repositoryReturning(shareRow).readShareByToken(shareRow.share_token),
    ).resolves.toMatchObject({
      share: { packageDigest: shareRow.package_digest },
      shareUrl: shareRow.share_url,
    });
  });

  it('rejects drift between Draft JSON and materialized identity/commitment columns', async () => {
    const { draftRow } = fixtures();
    for (const change of [
      { draft_fingerprint: `sha256:${'0'.repeat(64)}` },
      { candidate_commitment: `sha256:${'0'.repeat(64)}` },
      { request_fingerprint: `sha256:${'0'.repeat(64)}` },
    ]) {
      await expect(
        repositoryReturning({ ...draftRow, ...change }).readDraft(OWNER, draftRow.draft_id),
      ).rejects.toThrow('Draft materialization mismatch');
    }
  });

  it('rejects drift between Share JSON, digest, URL, copy prompt and request columns', async () => {
    const { shareRow } = fixtures();
    for (const change of [
      { package_digest: `sha256:${'0'.repeat(64)}` },
      { source_draft_fingerprint: `sha256:${'0'.repeat(64)}` },
      { share_url: `https://combo.example/api/v1/agent-package-shares/${'C'.repeat(43)}` },
      { copy_prompt: 'tampered' },
      { request_fingerprint: '0'.repeat(64) },
      { share_json_sha256: '0'.repeat(64) },
    ]) {
      await expect(
        repositoryReturning({ ...shareRow, ...change }).readShareByToken(shareRow.share_token),
      ).rejects.toThrow('share materialization mismatch');
    }
  });

  it('rejects canonical Share JSON drift even when selected materialized columns still match', async () => {
    const { share, shareRow } = fixtures();
    for (const tampered of [
      { ...share, releaseId: `release.agent-package.${'3'.repeat(32)}` },
      { ...share, createdAt: '2026-08-29T00:00:01.000Z' },
    ]) {
      await expect(
        repositoryReturning({
          ...shareRow,
          share_json: serializeAgentPackageShareV2(tampered),
        }).readShareByToken(shareRow.share_token),
      ).rejects.toThrow('share materialization mismatch');
    }
  });

  it('rejects starter drift even when the Share JSON digest is synchronously recomputed', async () => {
    const { share, shareRow } = fixtures();
    const originalPrompt = share.starterPrompts[0]!;
    const tamperedPrompt = '重算 JSON 摘要后的篡改起始任务。';
    const tamperedJson = shareRow.share_json.replace(
      JSON.stringify(originalPrompt),
      JSON.stringify(tamperedPrompt),
    );
    expect(tamperedJson).not.toBe(shareRow.share_json);

    await expect(
      repositoryReturning({
        ...shareRow,
        share_json: tamperedJson,
        share_json_sha256: createHash('sha256').update(tamperedJson, 'utf8').digest('hex'),
      }).readShareByToken(shareRow.share_token),
    ).rejects.toThrow(/digest-bound Package starter/u);
  });

  it('mints confirmation expiry from the database and ignores an API-clock proposal', async () => {
    const { draft } = fixtures();
    let observedSql = '';
    let observedParams: unknown[] | undefined;
    const db = {
      async query(sql: string, params?: unknown[]) {
        observedSql = sql;
        observedParams = params;
        return {
          rows: [
            {
              confirmation_token_sha256: 'e'.repeat(64),
              created_at: '2026-08-29T00:00:00.000Z',
              expires_at: '2026-08-29T00:05:00.000Z',
            },
          ],
          rowCount: 1,
        };
      },
    } as Queryable;
    const issued = await new PgProjectHistoryAgentRepository(IDENTITY_POOL, db).issueConfirmation({
      ownerUserId: OWNER,
      draftId: draft.draftId,
      revision: draft.revision,
      draftFingerprint: draft.draftFingerprint,
      tokenDigest: 'e'.repeat(64),
      expiresAt: '2100-01-01T00:00:00.000Z',
      consumedAt: null,
      consumedShareToken: null,
    });

    expect(observedSql).toContain('issue_project_history_agent_confirmation($1, $2, $3, $4, $5)');
    expect(observedParams).toEqual([
      OWNER,
      draft.draftId,
      draft.revision,
      draft.draftFingerprint,
      'e'.repeat(64),
    ]);
    expect(issued.expiresAt).toBe('2026-08-29T00:05:00.000Z');
  });

  it('uses the bounded SECURITY DEFINER retention entry without table DELETE', async () => {
    let observedSql = '';
    let observedParams: unknown[] | undefined;
    const db = {
      async query(sql: string, params?: unknown[]) {
        observedSql = sql;
        observedParams = params;
        return { rows: [{ confirmations_deleted: 7 }], rowCount: 1 };
      },
    } as Queryable;
    await expect(cleanupRetiredProjectHistoryAgentConfirmations(db, 10_000)).resolves.toBe(7);
    expect(observedSql).toContain('cleanup_retired_project_history_confirmations($1)');
    expect(observedSql).not.toContain('DELETE FROM project_history_agent_confirmations');
    expect(observedParams).toEqual([100]);
  });
});
