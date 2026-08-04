// Agent 项目行：稳定身份标识 + 真实状态 + 真实创建时间 + 试用 / UI Studio 入口。
import type { ReactElement } from 'react';
import type { CapabilityView } from '@cb/shared';
import { trialUrl } from '../../api/index.js';
import { CopyButton } from '../../components/CopyButton.js';
import { readReleaseDraft, releasePath } from '../release/releaseDraft.js';

function shareUrl(capabilityId: string): string {
  return `${window.location.origin}${trialUrl(capabilityId)}`;
}

function agentMark(name: string): string {
  const cjk = [...name].filter((char) => /[\u3400-\u9fff]/.test(char));
  if (cjk.length > 0) return cjk.slice(0, 2).join('');
  const words = name
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'AG';
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');
}

function identityVariant(capabilityId: string): number {
  let hash = 0;
  for (const char of capabilityId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % 8) + 1;
}

function createdLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : '—';
}

export function CapabilityRow({
  cap,
  editing,
  actionsBusy,
  editError,
  unpublishing,
  unpublishError,
  onEdit,
  onUnpublish,
}: {
  cap: CapabilityView;
  editing: boolean;
  actionsBusy: boolean;
  editError?: string | null;
  unpublishing: boolean;
  unpublishError?: string | null;
  onEdit: (capabilityId: string) => void;
  onUnpublish: (capabilityId: string) => void;
}): ReactElement {
  const releaseDraft = readReleaseDraft(cap.id, cap.name);
  const releaseComplete = releaseDraft.currentStep === 'success' && cap.published;
  const hasReleaseProgress = Boolean(
    !cap.published &&
    (releaseDraft.currentStep || releaseDraft.pricingModel || releaseDraft.handle?.trim()),
  );
  const releaseStep = releaseComplete
    ? 'success'
    : (releaseDraft.currentStep ??
      (releaseDraft.handle?.trim()
        ? 'review'
        : releaseDraft.pricingModel
          ? 'identity'
          : 'pricing'));
  const releaseActionLabel = releaseComplete
    ? '查看发布结果'
    : cap.published
      ? '发布设置'
      : hasReleaseProgress
        ? '继续发布'
        : '定价与发布';

  return (
    <tr className="cb-cap-row" data-capability={cap.id}>
      <td className="cb-cap-row__name">
        <div className="cb-agent-identity">
          <span className="cb-agent-mark" data-variant={identityVariant(cap.id)} aria-hidden="true">
            {agentMark(cap.name)}
          </span>
          <span className="cb-agent-identity__copy">
            <span className="cb-cap-row__title">{cap.name}</span>
            <span className="cb-cap-row__tagline">{cap.summary}</span>
          </span>
        </div>
      </td>
      <td className="cb-cap-row__status">
        <span className={`cb-status-badge is-${cap.published ? 'published' : 'unpublished'}`}>
          {cap.published ? '已上架' : '草稿'}
        </span>
      </td>
      <td className="cb-cap-row__updated">
        <time dateTime={cap.createdAt}>{createdLabel(cap.createdAt)}</time>
      </td>
      <td className="cb-cap-row__actions" aria-busy={editing || undefined}>
        <span className="cb-cap-row__action-list">
          <a
            className="cb-cap-action cb-cap-action--trial"
            href={trialUrl(cap.id)}
            aria-label={`试用「${cap.name}」`}
          >
            试用
          </a>
          <button
            type="button"
            className="cb-cap-action cb-cap-action--design"
            onClick={() => onEdit(cap.id)}
            disabled={actionsBusy}
            aria-label={`编辑「${cap.name}」UI`}
            aria-busy={editing || undefined}
          >
            {editing ? '正在打开…' : '编辑 UI'}
          </button>
          <a
            className="cb-cap-action cb-cap-action--release"
            href={releasePath(cap.id, releaseStep)}
            aria-label={
              releaseComplete
                ? `查看「${cap.name}」发布结果`
                : cap.published
                  ? `管理「${cap.name}」发布设置`
                  : hasReleaseProgress
                    ? `继续「${cap.name}」发布设置`
                    : `设置「${cap.name}」定价与发布`
            }
          >
            {releaseActionLabel}
          </a>
          {cap.published && (
            <CopyButton
              text={shareUrl(cap.id)}
              label="复制"
              ariaLabel={`复制「${cap.name}」试用链接`}
              className="cb-cap-action cb-cap-action--copy"
            />
          )}
          {cap.published && (
            <button
              type="button"
              className="cb-cap-action cb-cap-action--toggle"
              data-published="true"
              onClick={() => {
                if (
                  window.confirm(
                    `停止「${cap.name}」的公开试用？定价和页面设置会保留，之后可以再次开放。`,
                  )
                ) {
                  onUnpublish(cap.id);
                }
              }}
              disabled={unpublishing}
              aria-label={`停止「${cap.name}」公开试用`}
              aria-busy={unpublishing || undefined}
            >
              {unpublishing ? '正在停止…' : '停止公开试用'}
            </button>
          )}
        </span>
        {editError && (
          <span className="cb-cap-row__action-error" role="alert">
            编辑 UI 未打开：{editError}
          </span>
        )}
        {unpublishError && (
          <span className="cb-cap-row__action-error" role="alert">
            停止公开试用未完成：{unpublishError}
          </span>
        )}
      </td>
    </tr>
  );
}
