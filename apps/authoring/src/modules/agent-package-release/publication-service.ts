import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CREATOR_AGENT_PACKAGE_PROTOCOL } from '@cb/creator-agent-protocol/agent-package';
import {
  CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL,
  createCreatorAgentPackageRelease,
} from '@cb/creator-agent-protocol/agent-package-release';
import { type QueryableDb, type TxPool } from '../../platform/infra/db-tx.js';
import type { ImmutableObjectStore } from '../../platform/infra/object-store.js';
import {
  TransferFailure,
  TransferPublication,
  assertTransferBinding,
  transferReceipt,
  type TransferRow,
} from './transfer-contract.js';
import {
  assertTransferOwner,
  readTransfer,
  readTransferPackage,
  withTransferTransaction,
} from './transfer-service.js';
import {
  commitPublicPackage,
  readPublicPackage,
  verifyPublicPackage,
} from './publication-objects.js';

type ReleaseRow = {
  release_id: string;
  package_digest: string;
  protocol: string;
  release_scope: string;
  request_sha256: string;
  created_at: string | Date;
  account: string;
};
function publicationFingerprint(owner: string, row: TransferRow, requestId: string) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'combo.agent-publication-request/1',
        owner,
        row.transfer_id,
        requestId,
        row.draft_id,
        Number(row.draft_revision),
        row.draft_fingerprint,
        row.package_digest,
      ]),
    )
    .digest('hex');
}

export class AgentPublicationService {
  constructor(
    private pool: TxPool,
    private db: QueryableDb,
    private objects: ImmutableObjectStore,
    private origin: string,
  ) {}
  async publish(id: string, owner: string, body: unknown) {
    const parsed = TransferPublication.safeParse(body);
    if (!parsed.success) throw new TransferFailure('validation');
    const input = parsed.data;
    try {
      return await withTransferTransaction(this.pool, async (tx) => {
        const row = await readTransfer(tx, id, true);
        assertTransferOwner(row, owner);
        assertTransferBinding(row, input);
        if (!['uploaded', 'published'].includes(row.phase)) throw new TransferFailure('conflict');
        // Match the existing controlled publisher lock, so a cross-protocol key cannot race.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${owner}/${input.requestId}`,
        ]);
        const fingerprint = publicationFingerprint(owner, row, input.requestId);
        const previous = (
          await tx.query<ReleaseRow>(
            'SELECT * FROM agent_package_releases WHERE owner_user_id=$1::uuid AND idempotency_key=$2::uuid',
            [owner, input.requestId],
          )
        ).rows[0];
        if (previous) {
          if (
            previous.release_scope !== 'public_link' ||
            previous.request_sha256 !== fingerprint ||
            previous.package_digest !== row.package_digest ||
            row.phase !== 'published' ||
            row.release_id !== previous.release_id
          )
            throw new TransferFailure('conflict');
          // A retry confirms the same immutable package; it never creates or reactivates a release.
          await readTransferPackage(tx, this.objects, row);
          await readPublicPackage(this.objects, row.package_digest);
          return transferReceipt(row, this.origin);
        }
        if (row.phase === 'published') throw new TransferFailure('conflict');
        const candidate = await readTransferPackage(tx, this.objects, row);
        await commitPublicPackage(this.objects, candidate);
        await tx.query(
          `INSERT INTO agent_packages(package_digest,protocol,owner_user_id)
          VALUES($1,$2,$3::uuid) ON CONFLICT(package_digest) DO NOTHING`,
          [row.package_digest, CREATOR_AGENT_PACKAGE_PROTOCOL, owner],
        );
        const marker = (
          await tx.query<{ protocol: string }>(
            'SELECT protocol FROM agent_packages WHERE package_digest=$1',
            [row.package_digest],
          )
        ).rows[0];
        if (marker?.protocol !== CREATOR_AGENT_PACKAGE_PROTOCOL)
          throw new TransferFailure('unavailable');
        await tx.query(
          `INSERT INTO agent_package_publisher_claims
          (claim_id,owner_user_id,package_digest,draft_id,draft_revision,draft_fingerprint)
          VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)
          ON CONFLICT(owner_user_id,draft_id,draft_revision,draft_fingerprint,package_digest) DO NOTHING`,
          [
            randomUUID(),
            owner,
            row.package_digest,
            row.draft_id,
            Number(row.draft_revision),
            row.draft_fingerprint,
          ],
        );
        const claim = (
          await tx.query<{ claim_id: string }>(
            `SELECT claim_id FROM agent_package_publisher_claims
          WHERE owner_user_id=$1::uuid AND package_digest=$2 AND draft_id=$3 AND draft_revision=$4 AND draft_fingerprint=$5`,
            [
              owner,
              row.package_digest,
              row.draft_id,
              Number(row.draft_revision),
              row.draft_fingerprint,
            ],
          )
        ).rows[0];
        if (!claim) throw new TransferFailure('unavailable');
        const releaseId = `release.agent-package.${randomBytes(16).toString('hex')}`;
        await tx.query(
          `INSERT INTO agent_package_releases
          (release_id,package_digest,owner_user_id,protocol,release_scope,idempotency_key,request_sha256,publisher_claim_id)
          VALUES($1,$2,$3::uuid,$4,'public_link',$5::uuid,$6,$7::uuid)`,
          [
            releaseId,
            row.package_digest,
            owner,
            CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL,
            input.requestId,
            fingerprint,
            claim.claim_id,
          ],
        );
        const updated = (
          await tx.query<TransferRow>(
            `UPDATE agent_package_transfers
          SET phase='published',release_id=$2 WHERE transfer_id=$1::uuid RETURNING *`,
            [id, releaseId],
          )
        ).rows[0];
        if (!updated) throw new TransferFailure('unavailable');
        return transferReceipt(updated, this.origin);
      });
    } catch (error) {
      throw error instanceof TransferFailure ? error : new TransferFailure('unavailable');
    }
  }
  async read(releaseId: string) {
    try {
      const row = (
        await this.db.query<ReleaseRow>(
          `SELECT r.release_id,r.package_digest,r.protocol,r.release_scope,
        r.created_at,u.account FROM agent_package_releases r JOIN users u ON u.id=r.owner_user_id
        WHERE r.release_id=$1 AND r.release_scope='public_link'
          AND NOT EXISTS(SELECT 1 FROM agent_package_release_revocations v WHERE v.release_id=r.release_id)`,
          [releaseId],
        )
      ).rows[0];
      if (!row) throw new TransferFailure('not_found');
      const release = createCreatorAgentPackageRelease({
        protocol: row.protocol,
        releaseId: row.release_id,
        packageDigest: row.package_digest,
      });
      const candidate = await readPublicPackage(this.objects, release.packageDigest);
      const manifest = verifyPublicPackage(candidate);
      // Recheck revocation after object I/O before returning any public bytes.
      const stillPublic = (
        await this.db.query<{ release_id: string }>(
          `SELECT release_id FROM agent_package_releases
        WHERE release_id=$1 AND release_scope='public_link'
          AND NOT EXISTS(SELECT 1 FROM agent_package_release_revocations WHERE release_id=$1)`,
          [releaseId],
        )
      ).rows[0];
      if (!stillPublic) throw new TransferFailure('not_found');
      const shareUrl = `${this.origin}/agents/${release.releaseId}`;
      return {
        protocol: 'combo.agent-publication/1' as const,
        release,
        publishedAt: new Date(row.created_at).toISOString(),
        name: manifest.name,
        description: manifest.description,
        publisher: { account: row.account },
        sourceVerification: 'not_verified' as const,
        package: candidate,
        shareUrl,
        acquirePrompt: `请从 ${shareUrl} 获取这个 Agent，核对 Package digest ${release.packageDigest} 后，在当前任务中使用它。不要把浏览分享页当作已安装或已运行。`,
      };
    } catch (error) {
      throw error instanceof TransferFailure ? error : new TransferFailure('unavailable');
    }
  }
}
