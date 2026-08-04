// 提取结果：按优先级给每个 Agent 一条明确路径——真实试用，或继续 UI / 定价 / 发布。
// 这里不再绕过产品链路直接批量 publish；发布只在 Agent release 中完成最终确认。
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { CapabilityView, TaskView } from '@cb/shared';
import { trialUrl } from '../../api/index.js';
import { CopyButton } from '../../components/CopyButton.js';
import { releasePath } from '../release/releaseDraft.js';

export function CapabilityPicker({
  taskId,
  task,
  items,
  extracting,
}: {
  taskId: string;
  task: TaskView;
  items: CapabilityView[];
  extracting: boolean;
}): ReactElement {
  const taskReturnTo = `/tasks/${encodeURIComponent(taskId)}`;
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
              <Link className="cb-cap-card__continue" to={releasePath(capability.id, 'pricing')}>
                {capability.published ? '管理发布' : '继续完善'} →
              </Link>
              {capability.published && (
                <CopyButton
                  text={`${window.location.origin}${trialUrl(capability.id)}`}
                  label="复制试用链接"
                  ariaLabel={`复制「${capability.name}」试用链接`}
                  className="cb-cap-card__copy"
                />
              )}
            </div>
          </li>
        ))}
      </ol>

      <footer className="cb-capabilities__foot cb-capabilities__foot--journey">
        <p>
          不需要一次发布全部结果。先选最值得验证的 Agent，反复调整 UI 和效果，满意后再定价发布。
        </p>
        <Link className="cb-btn" to="/capabilities">
          查看全部 Agent
        </Link>
      </footer>
    </>
  );
}
