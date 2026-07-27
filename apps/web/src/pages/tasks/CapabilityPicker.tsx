// 能力挑选-发布区（任务详情页提取成果的主体）：统计工具条 + 勾选行卡列表 + 底部一键发布。
// 发布走既有单项接口（POST /capabilities/:id/publish）在前端顺序循环，逐项状态互不连坐，
// 失败项可单独重试；已发布项显示分享令牌。下架不在本页（去「我的能力」页管理）。
import { useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CapabilityView, PublishResult, TaskView } from '@cb/shared';
import { publishCapability, trialUrl, type Page } from '../../api/index.js';
import { CopyButton } from '../../components/CopyButton.js';

/** 单项发布态：不在 map 里 = 还没动过（发布与否看 cap.published）。 */
type ItemPublishState = { state: 'publishing' } | { state: 'failed'; message: string };

/** 一轮「一键发布」的汇总（进行中实时更新，结束后定格成汇总句）。 */
interface RunSummary {
  total: number;
  processed: number;
  published: number;
  failed: number;
  running: boolean;
}

function publishFailureMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'userMessage' in error) {
    const msg = (error as { userMessage: unknown }).userMessage;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  return '这一项没发布成功，可以单独重试。';
}

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
  const qc = useQueryClient();
  // 默认全选：记「被取消勾选的」而不是「被勾选的」，提取中新浮现的项自动入选。
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [itemStates, setItemStates] = useState<Map<string, ItemPublishState>>(new Map());
  const [run, setRun] = useState<RunSummary | null>(null);

  const unpublished = items.filter((c) => !c.published);
  const selected = unpublished.filter((c) => !deselected.has(c.id));
  const allSelected = unpublished.length > 0 && selected.length === unpublished.length;
  const publishing = run?.running ?? false;

  const toggle = (id: string): void => {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (): void => {
    setDeselected(allSelected ? new Set(unpublished.map((c) => c.id)) : new Set());
  };

  const setItemState = (id: string, state: ItemPublishState | null): void => {
    setItemStates((prev) => {
      const next = new Map(prev);
      if (state) next.set(id, state);
      else next.delete(id);
      return next;
    });
  };

  /** 发布成功后就地合并进本任务的能力列表缓存（页面刷新以库为真源）。 */
  const applyPublishResult = (result: PublishResult): void => {
    qc.setQueryData<Page<CapabilityView>>(['task-capabilities', taskId], (data) =>
      data
        ? {
            ...data,
            items: data.items.map((item) =>
              item.id === result.id
                ? {
                    ...item,
                    published: result.published,
                    ...(result.publishedAt !== undefined
                      ? { publishedAt: result.publishedAt }
                      : {}),
                    ...(result.shareToken !== undefined ? { shareToken: result.shareToken } : {}),
                  }
                : item,
            ),
          }
        : data,
    );
  };

  /** 顺序逐项发布：每项独立成败，失败不打断后续。 */
  const publishBatch = (targets: CapabilityView[]): void => {
    if (publishing || targets.length === 0) return;
    setRun({ total: targets.length, processed: 0, published: 0, failed: 0, running: true });
    void (async () => {
      for (const cap of targets) {
        setItemState(cap.id, { state: 'publishing' });
        try {
          const result = await publishCapability(cap.id);
          applyPublishResult(result);
          setItemState(cap.id, null);
          setRun((r) => (r ? { ...r, processed: r.processed + 1, published: r.published + 1 } : r));
        } catch (error) {
          setItemState(cap.id, { state: 'failed', message: publishFailureMessage(error) });
          setRun((r) => (r ? { ...r, processed: r.processed + 1, failed: r.failed + 1 } : r));
        }
      }
      setRun((r) => (r ? { ...r, running: false } : r));
      // 「我的能力」页的列表缓存直接失效重拉（键结构不同，不做跨页就地合并）。
      void qc.invalidateQueries({ queryKey: ['capabilities'] });
    })();
  };

  /** 失败项单独重试（也走同一条逐项路径）。 */
  const retryOne = (cap: CapabilityView): void => publishBatch([cap]);

  return (
    <>
      <div className="cb-capabilities__toolbar">
        <span className="cb-capabilities__selected">
          已选 <strong>{selected.length}</strong> / {unpublished.length} 项
          <span className="cb-capabilities__analyzed">
            {' '}
            · 上传 {task.upload.partsLanded} 个分片 · 识别出 {items.length} 项
          </span>
          {extracting && <span className="cb-capabilities__analyzed"> · 还在提取中…</span>}
        </span>
        {unpublished.length > 0 && (
          <button type="button" className="cb-link cb-capabilities__select-all" onClick={toggleAll}>
            {allSelected ? '取消全选' : '全选'}
          </button>
        )}
      </div>

      <ul className="cb-capabilities__list" aria-label="能力卡列表">
        {items.map((cap) => (
          <CapabilityPickRow
            key={cap.id}
            cap={cap}
            checked={!cap.published && !deselected.has(cap.id)}
            itemState={itemStates.get(cap.id)}
            disabled={publishing}
            returnTo={`/tasks/${encodeURIComponent(taskId)}`}
            onToggle={() => toggle(cap.id)}
            onRetry={() => retryOne(cap)}
          />
        ))}
      </ul>

      <footer className="cb-capabilities__foot">
        {run ? (
          <p className="cb-capabilities__progress" role="status" aria-live="polite">
            {run.running
              ? `正在逐个发布：已处理 ${run.processed} / ${run.total}（成功 ${run.published} · 失败 ${run.failed}）`
              : `已发布 ${run.published} / ${run.total} 个能力${
                  run.failed > 0 ? `（失败 ${run.failed}，可在卡片上单独重试）` : ''
                }。复制卡片上的分享链接发给别人即可试用（对方需登录）。`}
          </p>
        ) : null}
        {(!run || (!run.running && selected.length > 0)) && (
          <button
            type="button"
            className="cb-primary-btn cb-capabilities__publish"
            onClick={() => publishBatch(selected)}
            disabled={selected.length === 0 || publishing}
          >
            {`一键发布到市集 · ${selected.length} 项`}
          </button>
        )}
      </footer>
    </>
  );
}

/** 单张能力行卡：左勾选 / 中名称+类型+一句话+归属 / 右「试用 →」+ 发布状态槽。 */
function CapabilityPickRow({
  cap,
  checked,
  itemState,
  disabled,
  returnTo,
  onToggle,
  onRetry,
}: {
  cap: CapabilityView;
  checked: boolean;
  itemState: ItemPublishState | undefined;
  disabled: boolean;
  returnTo: string;
  onToggle: () => void;
  onRetry: () => void;
}): ReactElement {
  return (
    <li
      className="cb-cap-card"
      data-status={itemState?.state ?? (cap.published ? 'published' : 'ready')}
      data-selected={checked ? 'true' : 'false'}
    >
      <div className="cb-cap-card__select">
        {cap.published ? (
          <span className="cb-cap-card__published-mark" aria-hidden="true">
            ✓
          </span>
        ) : (
          <input
            type="checkbox"
            className="cb-cap-card__checkbox"
            checked={checked}
            onChange={onToggle}
            disabled={disabled}
            aria-label={`选择能力「${cap.name}」`}
          />
        )}
      </div>

      <div className="cb-cap-card__body">
        <div className="cb-cap-card__head">
          <span className="cb-cap-card__name">{cap.name}</span>
          <span className="cb-cap-card__type">{cap.kind}</span>
        </div>
        <p className="cb-cap-card__intent">{cap.summary}</p>
      </div>

      <div className="cb-cap-card__actions">
        <a className="cb-cap-card__trial" href={trialUrl(cap.id, returnTo)}>
          试用 →
        </a>
        {itemState?.state === 'publishing' && (
          <div className="cb-cap-card__status" data-state="publishing">
            <span className="cb-cap-card__status-label">发布中…</span>
          </div>
        )}
        {itemState?.state === 'failed' && (
          <div className="cb-cap-card__status" data-state="failed">
            <span className="cb-cap-card__status-label">失败</span>
            <span className="cb-cap-card__status-msg">{itemState.message}</span>
            <button type="button" className="cb-cap-card__retry" onClick={onRetry}>
              重试
            </button>
          </div>
        )}
        {!itemState && cap.published && (
          <div className="cb-cap-card__status" data-state="published">
            <span className="cb-cap-card__status-label">已发布</span>
            <span className="cb-cap-card__status-msg">
              {/* 裸 shareToken 无路由可消费；复制真正可用的完整试用链接。 */}
              <code className="cb-caps__token">{`${window.location.origin}${trialUrl(cap.id)}`}</code>
              <CopyButton text={`${window.location.origin}${trialUrl(cap.id)}`} />
            </span>
          </div>
        )}
      </div>
    </li>
  );
}
