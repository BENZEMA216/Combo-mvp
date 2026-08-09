import { createHash, randomBytes } from 'node:crypto';
import {
  PROJECT_AGENT_SHARE_SCHEMA_VERSION,
  ProjectAgentRequirementsSchema,
  ProjectAgentShareTokenSchema,
  canonicalJson,
  type CreateProjectAgentShareBody,
  type ProjectAgentShareManifest,
  type ProjectAgentShareResult,
} from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import {
  insertProjectAgentShare,
  readProjectAgentShareByToken,
  type CreateProjectAgentShareOutcome,
  type ProjectAgentShareRecord,
} from './repo.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePublicOrigin(publicOrigin: string): string {
  const url = new URL(publicOrigin);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('project agent public origin is invalid');
  }
  return url.origin;
}

export function projectAgentShareUrl(publicOrigin: string, shareToken: string): string {
  const token = ProjectAgentShareTokenSchema.parse(shareToken);
  return new URL(`/project-agent/${token}`, normalizePublicOrigin(publicOrigin)).toString();
}

export function projectAgentShareTokenFromUrl(
  publicOrigin: string,
  shareUrl: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(shareUrl);
  } catch {
    return null;
  }
  if (
    parsed.origin !== normalizePublicOrigin(publicOrigin) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  const match = parsed.pathname.match(/^\/project-agent\/([A-Za-z0-9_-]{43})$/u);
  if (!match || !match[1] || projectAgentShareUrl(publicOrigin, match[1]) !== parsed.toString()) {
    return null;
  }
  return match[1];
}

/**
 * Frozen by combo.project-agent-share/1. Never edit this renderer in place: add a schema v2
 * renderer and dispatch by manifest.schemaVersion so idempotent replay stays byte-identical
 * across rolling deployments.
 */
function renderProjectAgentCopyPromptV1(shareUrl: string): string {
  const installGuideUrl = new URL('/codex-plugin', new URL(shareUrl).origin).toString();
  return `请使用 Combo 的 read_project_agent_share 读取并审查这个 Project Agent 分享：
${shareUrl}

如果当前任务没有 read_project_agent_share，先读取同环境安装页 ${installGuideUrl}，只用 Codex Desktop 内置 CLI 安装或升级；首次安装，或可调用工具明确返回 authorization 错误时，再完成 OAuth。然后在新的顶层任务继续处理同一分享请求；无需默认重启，只有新任务工具清单仍未更新时才按安装页兜底。

先展示仓库、sourceRef、commit/tree SHA、依赖声明和安全边界，不要立即执行分享者的启动任务。我明确确认后，再恢复该 commit 中的 Git tracked files，核对 commit 与 tree SHA，并使用真实 Codex Harness 开始新任务。不要上传或恢复 Cookie、令牌、环境变量值、Codex 会话、ignored 或 untracked files。这个公开链接不会过期且 V0 不能撤销，manifest 中不得包含秘密；Combo 只保存 manifest，不托管 Git 对象。`;
}

export function renderProjectAgentCopyPrompt(
  schemaVersion: ProjectAgentShareManifest['schemaVersion'],
  shareUrl: string,
): string {
  if (schemaVersion === PROJECT_AGENT_SHARE_SCHEMA_VERSION) {
    return renderProjectAgentCopyPromptV1(shareUrl);
  }
  throw new Error('unsupported Project Agent share schema version');
}

function toResult(publicOrigin: string, record: ProjectAgentShareRecord): ProjectAgentShareResult {
  const shareUrl = projectAgentShareUrl(publicOrigin, record.shareToken);
  return {
    manifest: record.manifest,
    shareUrl,
    copyPrompt: renderProjectAgentCopyPrompt(record.manifest.schemaVersion, shareUrl),
  };
}

export type CreateProjectAgentShareServiceOutcome =
  | { kind: 'created' | 'replayed'; result: ProjectAgentShareResult }
  | Extract<CreateProjectAgentShareOutcome, { kind: 'idempotency_conflict' }>;

export type ReadProjectAgentShareServiceOutcome =
  | { kind: 'found'; result: ProjectAgentShareResult }
  | { kind: 'not_found' }
  | { kind: 'invalid_url' };

export async function createProjectAgentShare(
  db: Queryable,
  input: {
    ownerUserId: string;
    body: CreateProjectAgentShareBody;
    publicOrigin: string;
    now?: () => Date;
    randomToken?: () => string;
  },
): Promise<CreateProjectAgentShareServiceOutcome> {
  const requirements = ProjectAgentRequirementsSchema.parse(input.body.requirements ?? {});
  const source = {
    repositoryUrl: input.body.repositoryUrl,
    sourceRef: input.body.sourceRef,
    commitSha: input.body.commitSha,
    treeSha: input.body.treeSha,
  };
  const idempotencySha256 = sha256(
    canonicalJson({
      name: input.body.name,
      description: input.body.description,
      source,
      startPrompt: input.body.startPrompt,
      requirements,
    }),
  );
  const manifest: ProjectAgentShareManifest = {
    schemaVersion: PROJECT_AGENT_SHARE_SCHEMA_VERSION,
    name: input.body.name,
    description: input.body.description,
    source,
    startPrompt: input.body.startPrompt,
    requirements,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  const shareToken = ProjectAgentShareTokenSchema.parse(
    (input.randomToken ?? (() => randomBytes(32).toString('base64url')))(),
  );
  const outcome = await insertProjectAgentShare(db, {
    ownerUserId: input.ownerUserId,
    shareToken,
    manifest,
    manifestSha256: sha256(canonicalJson(manifest)),
    idempotencyKey: input.body.idempotencyKey,
    idempotencySha256,
  });
  if (outcome.kind === 'idempotency_conflict') return outcome;
  return { kind: outcome.kind, result: toResult(input.publicOrigin, outcome.record) };
}

export async function readProjectAgentShare(
  db: Queryable,
  input: { publicOrigin: string; shareUrl: string },
): Promise<ReadProjectAgentShareServiceOutcome> {
  const shareToken = projectAgentShareTokenFromUrl(input.publicOrigin, input.shareUrl);
  if (!shareToken) return { kind: 'invalid_url' };
  return readProjectAgentShareWithToken(db, {
    publicOrigin: input.publicOrigin,
    shareToken,
  });
}

export async function readProjectAgentShareWithToken(
  db: Queryable,
  input: { publicOrigin: string; shareToken: string },
): Promise<ReadProjectAgentShareServiceOutcome> {
  const parsed = ProjectAgentShareTokenSchema.safeParse(input.shareToken);
  if (!parsed.success) return { kind: 'invalid_url' };
  const record = await readProjectAgentShareByToken(db, parsed.data);
  if (!record) return { kind: 'not_found' };
  return { kind: 'found', result: toResult(input.publicOrigin, record) };
}
