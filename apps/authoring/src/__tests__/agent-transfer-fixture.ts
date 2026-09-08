import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createCreatorAgentPackageRelease } from '@cb/creator-agent-protocol/agent-package-release';
import { inspectAgentContextUpload } from '../modules/agent-draft/service.js';
import {
  transferReceipt,
  transferSecretHash,
  type TransferRow,
} from '../modules/agent-package-release/transfer-contract.js';
import { verifyPublicPackage } from '../modules/agent-package-release/publication-objects.js';
import { contextUploadFixture } from './agent-draft-fixture.js';

export function transferFixture(upload = contextUploadFixture()) {
  const exact = inspectAgentContextUpload(upload);
  const secret = `combo_transfer_${randomBytes(32).toString('base64url')}`;
  const request = {
    protocol: 'combo.agent-transfer-request/1' as const,
    ...exact,
    secretSha256: transferSecretHash(secret),
  };
  const row: TransferRow = {
    transfer_id: exact.requestId,
    name: exact.name,
    draft_fingerprint: exact.draftFingerprint,
    package_digest: exact.packageDigest,
    secret_sha256: request.secretSha256,
    verification_code: 'ABCDEF12',
    phase: 'pending_approval',
    owner_user_id: null,
    draft_id: null,
    draft_revision: null,
    release_id: null,
    expires_at: new Date(Date.now() + 600_000),
  };
  const receipt = transferReceipt(row, 'http://localhost');
  return {
    upload,
    secret,
    request,
    row,
    receipt,
    approval: {
      decision: 'approve' as const,
      verificationCode: receipt.verificationCode,
      draftFingerprint: exact.draftFingerprint,
      packageDigest: exact.packageDigest,
    },
  };
}
export function publicationFixture() {
  const { upload } = transferFixture();
  const manifest = verifyPublicPackage(upload.candidate);
  const release = createCreatorAgentPackageRelease({
    protocol: 'combo.agent-package-release/1',
    releaseId: `release.agent-package.${randomBytes(16).toString('hex')}`,
    packageDigest: upload.candidate.packageDigest,
  });
  return {
    protocol: 'combo.agent-publication/1' as const,
    release,
    publishedAt: new Date().toISOString(),
    name: manifest.name,
    description: manifest.description,
    publisher: { account: 'creator-test' },
    sourceVerification: 'not_verified' as const,
    package: upload.candidate,
    shareUrl: `http://localhost/agents/${release.releaseId}`,
    acquirePrompt: '核对摘要后使用，不代表已安装。',
  };
}

/** The transfer suite mutates only synthetic rows, but must still prove its temporary instance. */
export function transferPgTarget(raw: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  if (!raw)
    throw new Error('Agent transfer tests require a verified disposable PostgreSQL instance');
  const url = new URL(raw);
  const keys = [...url.searchParams.keys()];
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hash ||
    keys.some((key) => !['host', 'port'].includes(key)) ||
    new Set(keys).size !== keys.length
  )
    throw new Error('Unsafe PostgreSQL target');
  const ci =
    env.GITHUB_ACTIONS === 'true' &&
    env.CI === 'true' &&
    env.GITHUB_REPOSITORY === 'dangdang-tech/Combo' &&
    ['integration', 'billing-pg'].includes(env.GITHUB_JOB ?? '') &&
    url.hostname === 'localhost' &&
    url.port === '5432' &&
    url.username === 'agora' &&
    url.pathname === '/agora' &&
    url.search === '';
  if (ci) return { connectionString: raw, dataDirectory: '/var/lib/postgresql/data', ci: true };
  const socket = url.searchParams.get('host');
  const directory = env.COMBO_PUBLICATION_PG_DATA_DIR;
  if (
    url.hostname !== 'localhost' ||
    url.pathname !== '/combo_publication_test' ||
    !socket ||
    !/^\/tmp\/combo-publication-pg\.[A-Za-z0-9]+$/u.test(socket) ||
    directory !== `${socket}/data`
  )
    throw new Error('Unsafe PostgreSQL target');
  return { connectionString: raw, dataDirectory: directory, ci: false };
}
export async function assertTransferPgInstance(
  db: { query(sql: string): Promise<{ rows: Record<string, unknown>[] }> },
  target: ReturnType<typeof transferPgTarget>,
  resolve: (path: string) => string = realpathSync,
) {
  const row = (
    await db.query(
      "SELECT current_setting('data_directory') AS directory,current_setting('server_version') AS version",
    )
  ).rows[0];
  if (
    typeof row?.version !== 'string' ||
    !/^16\./u.test(row.version) ||
    typeof row.directory !== 'string'
  )
    throw new Error('Unexpected PostgreSQL instance');
  if (target.ci) {
    if (row.directory !== target.dataDirectory)
      throw new Error('Unexpected CI PostgreSQL instance');
    return;
  }
  const alias = target.dataDirectory.replace(/^\/tmp\//u, '/private/tmp/');
  if (
    ![target.dataDirectory, alias].includes(row.directory) ||
    ![target.dataDirectory, alias].includes(resolve(target.dataDirectory)) ||
    resolve(row.directory) !== resolve(target.dataDirectory)
  )
    throw new Error('Unexpected local PostgreSQL instance');
}
