// 提取结果：按优先级给每个 Agent 一条明确路径——真实试用，或继续 UI / 定价 / 发布。
// 这里不再绕过产品链路直接批量 publish；发布只在 Agent release 中完成最终确认。
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import type { CapabilityView, TaskView } from '@cb/shared';
import { createStudioSession, trialUrl } from '../../api/index.js';
import { CopyButton } from '../../components/CopyButton.js';
import { releasePath } from '../release/releaseDraft.js';

export interface CapabilityPickerProps {
  taskId: string;
  task: TaskView;
  items: CapabilityView[];
  extracting: boolean;
  /** 测试注入点；生产使用整页导航进入 runtime-web Studio。 */
  navigateToStudio?: (url: string) => void;
}

function defaultNavigateToStudio(url: string): void {
  window.location.assign(url);
}

function studioUrl(sessionId: string, capabilityId: string): string {
  return `/try/session/${encodeURIComponent(sessionId)}?mode=studio&returnTo=${encodeURIComponent(releasePath(capabilityId, 'pricing'))}`;
}

export function CapabilityPicker({
  taskId,
  task,
  items,
  extracting,
  navigateToStudio = defaultNavigateToStudio,
}: CapabilityPickerProps): ReactElement {
  const taskReturnTo = `/tasks/${encodeURIComponent(taskId)}`;
  const [studioError, setStudioError] = useState<{
    capabilityId: string;
    message: string;
  } | null>(null);
  const studioMutation = useMutation({
    mutationFn: (capabilityId: string) => createStudioSession(capabilityId),
    onMutate: () => setStudioError(null),
    onSuccess: ({ session }, capabilityId) => {
      navigateToStudio(studioUrl(session.id, capabilityId));
    },
    onError: (error, capabilityId) => {
      setStudioError({
        capabilityId,
        message: error instanceof Error ? error.message : '暂时没能打开设计空间，请稍后重试。',
      });
    },
  });

  return (
    <>
      <div className="cb-capabilities__toolbar">
        <span className="cb-capabilities__selected">
          已识别 <strong>{items.length}</strong> 个 Agent
          <span className="cb-capabilities__analyzed">
            {' '}
            · 上传 {task.upload.partsLanded} 个分片
          </span>
          {extracting && <span className="cb-capabilities__analyzed"> · 仍在继续提取…</span>}
        </span>
        <span className="cb-capabilities__analyzed">已按复用价值排序</span>
      </div>

      <ol
        className="cb-capabilities__list cb-capabilities__list--ranked"
        aria-label="Agent 提取结果"
      >
        {items.map((capability, index) => (
          <li
            key={capability.id}
            className="cb-cap-card"
            data-status={capability.published ? 'published' : 'ready'}
          >
            <div className="cb-cap-card__rank" aria-label={`优先级 ${index + 1}`}>
              {String(index + 1).padStart(2, '0')}
            </div>
            <div className="cb-cap-card__body">
              <div className="cb-cap-card__head">
                <span className="cb-cap-card__name">{capability.name}</span>
                <span className="cb-cap-card__type">{capability.kind}</span>
                {capability.published && (
                  <span className="cb-status-badge is-published">已发布</span>
                )}
              </div>
              <p className="cb-cap-card__intent">{capability.summary}</p>
            </div>
            <div className="cb-cap-card__actions cb-cap-card__actions--journey">
              <a className="cb-cap-card__trial" href={trialUrl(capability.id, taskReturnTo)}>
                先试用
              </a>
              <button
                type="button"
                className="cb-cap-card__studio"
                onClick={() => studioMutation.mutate(capability.id)}
                disabled={studioMutation.isPending}
                aria-label={`调整「${capability.name}」UI`}
              >
                {studioMutation.isPending && studioMutation.variables === capability.id
                  ? '正在打开…'
                  : '调整 UI'}
              </button>
              <Link className="cb-cap-card__release" to={releasePath(capability.id, 'pricing')}>
                {capability.published ? '管理发布' : '直接定价与发布'} →
              </Link>
              {capability.published && (
                <CopyButton
                  text={`${window.location.origin}${trialUrl(capability.id)}`}
                  label="复制试用链接"
                  ariaLabel={`复制「${capability.name}」试用链接`}
                  className="cb-cap-card__copy"
                />
              )}
              {studioError?.capabilityId === capability.id && (
                <span className="cb-cap-card__error" role="alert">
                  调整 UI 未打开：{studioError.message}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>

      <footer className="cb-capabilities__foot cb-capabilities__foot--journey">
        <p>不需要一次发布全部结果。先选最值得验证的 Agent 试用和调整；满意后再进入定价发布。</p>
        <Link className="cb-btn" to="/capabilities">
          查看全部 Agent
        </Link>
      </footer>
    </>
  );
}
