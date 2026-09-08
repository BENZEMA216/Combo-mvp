import { createHash, timingSafeEqual } from 'node:crypto';
import { agentReceiverPrompt } from './receiver-handoff.js';
import { z } from 'zod';
import { CreatorAgentPackageReleaseIdSchema } from '@cb/creator-agent-protocol/agent-package-release';

export const TransferId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
export const TransferDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const TransferRequest = z
  .object({
    protocol: z.literal('combo.agent-transfer-request/1'),
    requestId: TransferId,
    name: z
      .string()
      .min(1)
      .max(100)
      .refine(
        (value) => value.trim() === value && !/[\p{Cc}\u2028-\u202e\u2066-\u2069]/u.test(value),
      ),
    draftFingerprint: TransferDigest,
    packageDigest: TransferDigest,
    secretSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export type TransferRequest = z.infer<typeof TransferRequest>;
export const TransferApproval = z
  .object({
    decision: z.enum(['approve', 'reject']),
    verificationCode: z.string().regex(/^[A-Z0-9]{8}$/u),
    draftFingerprint: TransferDigest,
    packageDigest: TransferDigest,
  })
  .strict();
export const TransferPublication = z
  .object({
    requestId: TransferId,
    draftFingerprint: TransferDigest,
    packageDigest: TransferDigest,
    confirmPublic: z.literal(true),
  })
  .strict();
export const EmptyTransferBody = z.object({}).strict();
export type TransferPhase = 'pending_approval' | 'approved' | 'uploaded' | 'published' | 'rejected';
export type TransferFailureKind =
  | 'validation'
  | 'not_found'
  | 'expired'
  | 'conflict'
  | 'unavailable';
export class TransferFailure extends Error {
  constructor(readonly kind: TransferFailureKind) {
    super(`Agent transfer ${kind}`);
    this.name = 'TransferFailure';
  }
}

export interface TransferRow {
  transfer_id: string;
  name: string;
  draft_fingerprint: string;
  package_digest: string;
  secret_sha256: string;
  verification_code: string;
  phase: TransferPhase;
  owner_user_id: string | null;
  draft_id: string | null;
  draft_revision: string | number | null;
  release_id: string | null;
  expires_at: string | Date;
}

export function transferSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
export function isTransferSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && /^combo_transfer_[A-Za-z0-9_-]{43}$/u.test(secret);
}
export function authenticateTransfer(row: TransferRow, secret: string) {
  if (
    !isTransferSecret(secret) ||
    !/^[0-9a-f]{64}$/u.test(row.secret_sha256) ||
    !timingSafeEqual(
      Buffer.from(transferSecretHash(secret), 'hex'),
      Buffer.from(row.secret_sha256, 'hex'),
    )
  ) {
    throw new TransferFailure('not_found');
  }
}
export function assertTransferBinding(
  row: TransferRow,
  input: { draftFingerprint: string; packageDigest: string },
) {
  if (
    row.draft_fingerprint !== input.draftFingerprint ||
    row.package_digest !== input.packageDigest
  ) {
    throw new TransferFailure('conflict');
  }
}

/** URLs are configuration-derived, never taken from headers or caller payloads. */
export function transferReceipt(row: TransferRow, origin: string) {
  const transferId = TransferId.parse(row.transfer_id);
  const packageDigest = TransferDigest.parse(row.package_digest);
  const draftFingerprint = TransferDigest.parse(row.draft_fingerprint);
  const shareUrl = row.release_id
    ? `${origin}/agents/${CreatorAgentPackageReleaseIdSchema.parse(row.release_id)}`
    : null;
  if ((row.phase === 'published') !== (shareUrl !== null)) throw new TransferFailure('unavailable');
  const saved = row.draft_id !== null && Number(row.draft_revision) === 1;
  if ((row.phase === 'uploaded' || row.phase === 'published') !== saved)
    throw new TransferFailure('unavailable');
  return {
    protocol: 'combo.agent-transfer/1' as const,
    transferId,
    phase: row.phase,
    approvalUrl: `${origin}/agent-transfers/${transferId}`,
    verificationCode: row.verification_code,
    expiresAt: new Date(row.expires_at).toISOString(),
    ...(saved
      ? {
          saved: { draftId: row.draft_id!, revision: 1 as const, draftFingerprint, packageDigest },
        }
      : {}),
    ...(shareUrl && row.release_id
      ? {
          release: {
            releaseId: row.release_id,
            packageDigest,
            shareUrl,
            acquirePrompt: agentReceiverPrompt(origin, row.release_id, packageDigest),
          },
        }
      : {}),
  };
}

export function transferError(error: unknown): TransferFailure {
  return error instanceof TransferFailure ? error : new TransferFailure('unavailable');
}
