// Agent Package 专用边界：公开读取不携带会话；私有确认沿用 Cookie 登录。
import { redirectAfterUnauthorized } from './client.js';

export const TRANSFER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const RELEASE_ID_PATTERN = /^release\.agent-package\.[0-9a-f]{32}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export type TransferPhase = 'pending_approval' | 'approved' | 'uploaded' | 'published' | 'rejected';
export interface AgentPackageReview {
  manifestText: string;
  packageDigest: string;
  files: { path: string; text: string }[];
}
export interface AgentTransferReceipt {
  protocol: 'combo.agent-transfer/1';
  transferId: string;
  phase: TransferPhase;
  approvalUrl: string;
  verificationCode: string;
  expiresAt: string;
  saved?: { draftId: string; revision: 1; draftFingerprint: string; packageDigest: string };
  release?: { releaseId: string; packageDigest: string; shareUrl: string; acquirePrompt: string };
}
export interface AgentTransferView {
  transfer: AgentTransferReceipt;
  name: string;
  draftFingerprint: string;
  packageDigest: string;
  review?: AgentPackageReview;
}
export interface AgentPublicationView {
  protocol: 'combo.agent-publication/1';
  release: { protocol: 'combo.agent-package-release/1'; releaseId: string; packageDigest: string };
  publishedAt: string;
  name: string;
  description: string;
  publisher: { account: string };
  sourceVerification: 'not_verified';
  package: AgentPackageReview;
  shareUrl: string;
  acquirePrompt: string;
}

export class AgentPackageRequestError extends Error {
  constructor(
    readonly userMessage: string,
    readonly outcomeUncertain = false,
  ) {
    super(userMessage);
    this.name = 'AgentPackageRequestError';
  }
}

function invalid(): never {
  throw new AgentPackageRequestError('服务返回的信息不完整，暂时不能继续。请刷新状态后重试。');
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.length || value.length > max) return invalid();
  return value;
}
function matching(value: unknown, pattern: RegExp): string {
  const result = string(value);
  if (!pattern.test(result)) return invalid();
  return result;
}
function date(value: unknown): string {
  const result = string(value, 40);
  if (!Number.isFinite(Date.parse(result))) return invalid();
  return result;
}
function localUrl(value: unknown, path: string): string {
  const result = string(value, 2048);
  if (result !== new URL(path, window.location.origin).href) return invalid();
  return result;
}
function review(value: unknown, digest: string): AgentPackageReview {
  const raw = object(value);
  if (raw.packageDigest !== digest || !Array.isArray(raw.files) || raw.files.length > 64)
    return invalid();
  const manifestText = string(raw.manifestText, 512 * 1024);
  // 展示边界仅校验结构与摘要绑定；规范内容/哈希的权威校验由 API 完成。
  const manifest = object(JSON.parse(manifestText) as unknown);
  if (manifest.protocol !== 'combo.agent-package/1') return invalid();
  const seen = new Set<string>();
  const files = raw.files.map((file: unknown) => {
    const entry = object(file);
    const path = string(entry.path, 512);
    if (
      seen.has(path) ||
      path === 'agent.json' ||
      !/^(?:AGENT\.md|skills\/[A-Za-z0-9._/-]+)$/u.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      return invalid();
    seen.add(path);
    return { path, text: string(entry.text, 512 * 1024) };
  });
  if (!seen.has('AGENT.md') || !files.some((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file.path)))
    return invalid();
  return { manifestText, packageDigest: digest, files };
}
function receipt(value: unknown, expectedId: string): AgentTransferReceipt {
  const raw = object(value);
  if (raw.protocol !== 'combo.agent-transfer/1' || raw.transferId !== expectedId) return invalid();
  const phase = string(raw.phase) as TransferPhase;
  if (!['pending_approval', 'approved', 'uploaded', 'published', 'rejected'].includes(phase))
    return invalid();
  const result: AgentTransferReceipt = {
    protocol: 'combo.agent-transfer/1',
    transferId: expectedId,
    phase,
    approvalUrl: localUrl(raw.approvalUrl, `/agent-transfers/${expectedId}`),
    verificationCode: matching(raw.verificationCode, /^[A-Z0-9]{8}$/u),
    expiresAt: date(raw.expiresAt),
  };
  if (phase === 'uploaded' || phase === 'published') {
    const saved = object(raw.saved);
    if (saved.revision !== 1) return invalid();
    result.saved = {
      draftId: string(saved.draftId, 128),
      revision: 1,
      draftFingerprint: matching(saved.draftFingerprint, DIGEST_PATTERN),
      packageDigest: matching(saved.packageDigest, DIGEST_PATTERN),
    };
  } else if (raw.saved !== undefined) return invalid();
  if (phase === 'published') {
    const released = object(raw.release);
    const releaseId = matching(released.releaseId, RELEASE_ID_PATTERN);
    const packageDigest = matching(released.packageDigest, DIGEST_PATTERN);
    if (packageDigest !== result.saved?.packageDigest) return invalid();
    result.release = {
      releaseId,
      packageDigest,
      shareUrl: localUrl(released.shareUrl, `/agents/${releaseId}`),
      acquirePrompt: string(released.acquirePrompt, 4096),
    };
  } else if (raw.release !== undefined) return invalid();
  return result;
}
function transferView(value: unknown, id: string): AgentTransferView {
  const raw = object(value);
  const transfer = receipt(raw.transfer, id);
  const draftFingerprint = matching(raw.draftFingerprint, DIGEST_PATTERN);
  const packageDigest = matching(raw.packageDigest, DIGEST_PATTERN);
  if (
    transfer.saved &&
    (transfer.saved.draftFingerprint !== draftFingerprint ||
      transfer.saved.packageDigest !== packageDigest)
  )
    return invalid();
  const result: AgentTransferView = {
    transfer,
    name: string(raw.name, 100),
    draftFingerprint,
    packageDigest,
  };
  if (transfer.phase === 'uploaded' || transfer.phase === 'published')
    result.review = review(raw.review, packageDigest);
  else if (raw.review !== undefined) return invalid();
  return result;
}
function publication(value: unknown, id: string): AgentPublicationView {
  const raw = object(value);
  const released = object(raw.release);
  if (
    raw.protocol !== 'combo.agent-publication/1' ||
    raw.sourceVerification !== 'not_verified' ||
    released.protocol !== 'combo.agent-package-release/1' ||
    released.releaseId !== id
  )
    return invalid();
  const packageDigest = matching(released.packageDigest, DIGEST_PATTERN);
  return {
    protocol: 'combo.agent-publication/1',
    sourceVerification: 'not_verified',
    release: { protocol: 'combo.agent-package-release/1', releaseId: id, packageDigest },
    publishedAt: date(raw.publishedAt),
    name: string(raw.name, 100),
    description: string(raw.description, 4000),
    publisher: { account: matching(object(raw.publisher).account, /^creator-[a-z2-7]{8}$/u) },
    package: review(raw.package, packageDigest),
    shareUrl: localUrl(raw.shareUrl, `/agents/${id}`),
    acquirePrompt: string(raw.acquirePrompt, 4096),
  };
}

async function request<T>(
  path: string,
  privateRequest: boolean,
  parse: (value: unknown, content: string) => T,
  signal?: AbortSignal,
  body?: unknown,
  bare = false,
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 30_000);
  try {
    const response = await fetch(`/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: privateRequest ? 'include' : 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (privateRequest && response.status === 401) redirectAfterUnauthorized();
      const message =
        response.status === 404
          ? '这个链接不存在、已撤销，或不属于当前账号。'
          : response.status === 410
            ? '配对已过期，请回到 Codex 创建新的上传请求。'
            : response.status === 409
              ? '状态或内容已发生变化，请先刷新状态。'
              : response.status === 400
                ? '确认信息不匹配，请核对 Codex 配对码和当前内容。'
                : response.status === 401
                  ? '请先登录，再继续确认。'
                  : '服务暂时不可用，请稍后刷新状态。';
      throw new AgentPackageRequestError(message, body !== undefined && response.status >= 500);
    }
    const content = await response.text();
    if (new TextEncoder().encode(content).byteLength > MAX_RESPONSE_BYTES) return invalid();
    const parsed = object(JSON.parse(content) as unknown);
    return parse(bare ? parsed : parsed.data, content);
  } catch (error) {
    if (error instanceof AgentPackageRequestError) {
      if (body !== undefined && error.message.includes('服务返回的信息'))
        throw new AgentPackageRequestError(error.userMessage, true);
      throw error;
    }
    if (signal?.aborted) throw error;
    throw new AgentPackageRequestError(
      body === undefined
        ? '暂时无法读取，请检查网络后重试。'
        : '尚未确认操作结果。请先刷新状态；如需重试，会沿用同一请求。',
      body !== undefined,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function getAgentTransfer(id: string, signal?: AbortSignal): Promise<AgentTransferView> {
  matching(id, TRANSFER_ID_PATTERN);
  return request(
    `/agent-package-transfers/${id}`,
    true,
    (value) => transferView(value, id),
    signal,
  );
}
export function approveAgentTransfer(
  id: string,
  input: {
    decision: 'approve' | 'reject';
    verificationCode: string;
    draftFingerprint: string;
    packageDigest: string;
  },
): Promise<AgentTransferReceipt> {
  matching(id, TRANSFER_ID_PATTERN);
  return request(
    `/agent-package-transfers/${id}/approval`,
    true,
    (value) => {
      const result = receipt(value, id);
      if (result.phase !== (input.decision === 'approve' ? 'approved' : 'rejected'))
        return invalid();
      return result;
    },
    undefined,
    input,
  );
}
export function publishAgentTransfer(
  id: string,
  input: {
    requestId: string;
    draftFingerprint: string;
    packageDigest: string;
    confirmPublic: true;
  },
): Promise<AgentTransferReceipt> {
  matching(id, TRANSFER_ID_PATTERN);
  return request(
    `/agent-package-transfers/${id}/publication`,
    true,
    (value) => {
      const result = receipt(value, id);
      if (
        result.phase !== 'published' ||
        result.saved?.draftFingerprint !== input.draftFingerprint ||
        result.saved.packageDigest !== input.packageDigest ||
        result.release?.packageDigest !== input.packageDigest
      )
        return invalid();
      return result;
    },
    undefined,
    input,
  );
}
export function getAgentPublication(
  id: string,
  signal?: AbortSignal,
): Promise<AgentPublicationView> {
  matching(id, RELEASE_ID_PATTERN);
  return request(
    `/agent-package-publications/${id}`,
    false,
    (value) => publication(value, id),
    signal,
  );
}
export function agentPackageDownloadUrl(id: string): string {
  matching(id, RELEASE_ID_PATTERN);
  return `/api/v1/agent-package-publications/${id}/package`;
}
export function getAgentPackageDownload(id: string, digest: string): Promise<Blob> {
  matching(id, RELEASE_ID_PATTERN);
  matching(digest, DIGEST_PATTERN);
  return request(
    `/agent-package-publications/${id}/package`,
    false,
    (value, content) => {
      review(value, digest);
      return new Blob([content], { type: 'application/json;charset=utf-8' });
    },
    undefined,
    undefined,
    true,
  );
}

/** 只存不透明请求 ID 和内容摘要，不存包内容、配对码、会话或上传 secret。失败时禁止发送。 */
export function publicationRequestId(
  id: string,
  draftFingerprint: string,
  packageDigest: string,
): string {
  matching(id, TRANSFER_ID_PATTERN);
  matching(draftFingerprint, DIGEST_PATTERN);
  matching(packageDigest, DIGEST_PATTERN);
  const key = `combo.agent-publication-request/1:${id}`;
  try {
    const stored = sessionStorage.getItem(key);
    if (stored !== null) {
      const parsed = object(JSON.parse(stored) as unknown);
      if (parsed.draftFingerprint !== draftFingerprint || parsed.packageDigest !== packageDigest)
        return invalid();
      return matching(parsed.requestId, TRANSFER_ID_PATTERN);
    }
    const requestId = matching(crypto.randomUUID(), TRANSFER_ID_PATTERN);
    const value = JSON.stringify({ requestId, draftFingerprint, packageDigest });
    sessionStorage.setItem(key, value);
    if (sessionStorage.getItem(key) !== value) return invalid();
    return requestId;
  } catch {
    throw new AgentPackageRequestError(
      '无法安全保存发布请求编号，因此尚未发送。请允许本站使用会话存储后重试。',
    );
  }
}
