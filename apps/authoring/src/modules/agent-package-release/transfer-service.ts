import { randomBytes } from 'node:crypto';
import {
  AgentDraftFailure,
  AgentDraftService,
  PgDraftRepository,
  inspectAgentContextUpload,
} from '../agent-draft/index.js';
import { withTransaction, type QueryableDb, type TxPool } from '../../platform/infra/db-tx.js';
import type { ImmutableObjectStore } from '../../platform/infra/object-store.js';
import {
  TransferRequest,
  TransferApproval,
  TransferFailure,
  authenticateTransfer,
  assertTransferBinding,
  transferReceipt,
  type TransferRow,
} from './transfer-contract.js';

export function withTransferTransaction<T>(
  pool: TxPool,
  operation: (tx: QueryableDb) => Promise<T>,
) {
  return withTransaction(pool, async (tx) => {
    await tx.query("SET LOCAL statement_timeout='15s'");
    await tx.query("SET LOCAL lock_timeout='5s'");
    return operation(tx);
  });
}
export async function readTransfer(db: QueryableDb, id: string, locked = false) {
  const row = (
    await db.query<TransferRow>(
      `SELECT * FROM agent_package_transfers WHERE transfer_id=$1::uuid${locked ? ' FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
  if (!row) throw new TransferFailure('not_found');
  return row;
}
/** Read the database clock after acquiring any row lock, never before a lock wait. */
export async function assertTransferUnexpired(db: QueryableDb, row: TransferRow) {
  const result = await db.query<{ expired: boolean }>(
    'SELECT $1::timestamptz <= clock_timestamp() AS expired',
    [row.expires_at],
  );
  if (result.rows[0]?.expired !== false) throw new TransferFailure('expired');
}
export function assertTransferOwner(row: TransferRow, owner: string) {
  if (row.owner_user_id !== owner) throw new TransferFailure('not_found');
}
export async function readTransferPackage(
  db: QueryableDb,
  objects: ImmutableObjectStore,
  row: TransferRow,
) {
  if (!row.owner_user_id || !row.draft_id || Number(row.draft_revision) !== 1)
    throw new TransferFailure('unavailable');
  const record = await new AgentDraftService(PgDraftRepository.inTransaction(db), objects).read(
    row.owner_user_id,
    row.draft_id,
    1,
  );
  if (
    !record ||
    record.protocol !== 'combo.agent-context-record/1' ||
    record.draft.fingerprint !== row.draft_fingerprint ||
    record.candidate.packageDigest !== row.package_digest ||
    record.storage.draftId !== row.draft_id ||
    record.storage.revision !== 1
  )
    throw new TransferFailure('unavailable');
  return record.candidate;
}
function safe(error: unknown): TransferFailure {
  if (error instanceof TransferFailure) return error;
  if (error instanceof AgentDraftFailure) {
    return new TransferFailure(
      error.kind === 'validation'
        ? 'validation'
        : error.kind === 'unavailable'
          ? 'unavailable'
          : 'conflict',
    );
  }
  return new TransferFailure('unavailable');
}

/** A browser account authorizes an exact private upload; the Desktop secret never publishes. */
export class AgentTransferService {
  constructor(
    private pool: TxPool,
    private db: QueryableDb,
    private objects: ImmutableObjectStore,
    private origin: string,
  ) {}
  async create(body: unknown) {
    const parsed = TransferRequest.safeParse(body);
    if (!parsed.success) throw new TransferFailure('validation');
    const input = parsed.data;
    try {
      return await withTransferTransaction(this.pool, async (tx) => {
        await tx.query(
          `INSERT INTO agent_package_transfers
          (transfer_id,name,draft_fingerprint,package_digest,secret_sha256,verification_code,expires_at)
          VALUES($1::uuid,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes')
          ON CONFLICT(transfer_id) DO NOTHING`,
          [
            input.requestId,
            input.name,
            input.draftFingerprint,
            input.packageDigest,
            input.secretSha256,
            randomBytes(4).toString('hex').toUpperCase(),
          ],
        );
        const row = await readTransfer(tx, input.requestId, true);
        if (row.name !== input.name || row.secret_sha256 !== input.secretSha256)
          throw new TransferFailure('conflict');
        assertTransferBinding(row, input);
        await assertTransferUnexpired(tx, row);
        return transferReceipt(row, this.origin);
      });
    } catch (error) {
      throw safe(error);
    }
  }
  async status(id: string, secret: string) {
    try {
      const row = await readTransfer(this.db, id);
      authenticateTransfer(row, secret);
      await assertTransferUnexpired(this.db, row);
      return transferReceipt(row, this.origin);
    } catch (error) {
      throw safe(error);
    }
  }
  async review(id: string, owner: string) {
    try {
      const row = await readTransfer(this.db, id);
      if (row.owner_user_id !== null) assertTransferOwner(row, owner);
      const review =
        row.phase === 'uploaded' || row.phase === 'published'
          ? await readTransferPackage(this.db, this.objects, row)
          : undefined;
      return {
        transfer: transferReceipt(row, this.origin),
        name: row.name,
        draftFingerprint: row.draft_fingerprint,
        packageDigest: row.package_digest,
        ...(review ? { review } : {}),
      };
    } catch (error) {
      throw safe(error);
    }
  }
  async approve(id: string, owner: string, body: unknown) {
    const parsed = TransferApproval.safeParse(body);
    if (!parsed.success) throw new TransferFailure('validation');
    const input = parsed.data;
    try {
      return await withTransferTransaction(this.pool, async (tx) => {
        const row = await readTransfer(tx, id, true);
        if (row.owner_user_id !== null) assertTransferOwner(row, owner);
        if (row.verification_code !== input.verificationCode) throw new TransferFailure('conflict');
        assertTransferBinding(row, input);
        await assertTransferUnexpired(tx, row);
        if (
          input.decision === 'approve' &&
          ['approved', 'uploaded', 'published'].includes(row.phase)
        ) {
          return transferReceipt(row, this.origin);
        }
        if (input.decision === 'reject' && row.phase === 'rejected')
          return transferReceipt(row, this.origin);
        if (
          row.phase !== 'pending_approval' &&
          !(row.phase === 'approved' && input.decision === 'reject')
        ) {
          throw new TransferFailure('conflict');
        }
        const updated = (
          await tx.query<TransferRow>(
            'UPDATE agent_package_transfers SET phase=$2,owner_user_id=$3::uuid WHERE transfer_id=$1::uuid RETURNING *',
            [id, input.decision === 'approve' ? 'approved' : 'rejected', owner],
          )
        ).rows[0];
        if (!updated) throw new TransferFailure('unavailable');
        return transferReceipt(updated, this.origin);
      });
    } catch (error) {
      throw safe(error);
    }
  }
  async upload(id: string, secret: string, body: unknown) {
    try {
      return await withTransferTransaction(this.pool, async (tx) => {
        const row = await readTransfer(tx, id, true);
        authenticateTransfer(row, secret);
        await assertTransferUnexpired(tx, row);
        if (!row.owner_user_id || !['approved', 'uploaded', 'published'].includes(row.phase))
          throw new TransferFailure('conflict');
        const exact = inspectAgentContextUpload(body);
        if (exact.requestId !== id || exact.name !== row.name)
          throw new TransferFailure('conflict');
        assertTransferBinding(row, exact);
        const saved = await new AgentDraftService(
          PgDraftRepository.inTransaction(tx),
          this.objects,
        ).saveContext(row.owner_user_id, body);
        if (row.phase !== 'approved') {
          if (row.draft_id !== saved.record.storage.draftId || Number(row.draft_revision) !== 1)
            throw new TransferFailure('conflict');
          return transferReceipt(row, this.origin);
        }
        const updated = (
          await tx.query<TransferRow>(
            `UPDATE agent_package_transfers SET phase='uploaded',draft_id=$2,draft_revision=1
           WHERE transfer_id=$1::uuid RETURNING *`,
            [id, saved.record.storage.draftId],
          )
        ).rows[0];
        if (!updated) throw new TransferFailure('unavailable');
        return transferReceipt(updated, this.origin);
      });
    } catch (error) {
      throw safe(error);
    }
  }
}
