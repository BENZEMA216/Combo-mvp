import { useEffect, useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CapabilityView } from '@cb/shared';
import {
  createStudioSession,
  getCapability,
  publishCapability,
  trialUrl,
  unpublishCapability,
} from '../../api/index.js';
import { ErrorState, Skeleton } from '../../components/index.js';
import { CopyButton } from '../../components/CopyButton.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import {
  isPricingComplete,
  isValidReleaseHandle,
  pricingLabel,
  readReleaseDraft,
  releasePath,
  saveReleaseDraft,
  type PricingModel,
  type ReleaseDraft,
  type ReleaseStep,
} from './releaseDraft.js';
import './release.css';

const STEPS: ReadonlyArray<{ key: ReleaseStep; label: string }> = [
  { key: 'pricing', label: '定价' },
  { key: 'identity', label: '命名' },
  { key: 'review', label: '确认发布' },
  { key: 'success', label: '完成' },
];

const RESERVED_HANDLES = new Set(['api', 'www', 'admin', 'login', 'combo', 'support']);

const PRICING_OPTIONS: ReadonlyArray<{
  id: PricingModel;
  index: string;
  title: string;
  description: string;
}> = [
  {
    id: 'per-use',
    index: '01',
    title: '单次定价',
    description: '用户每完成一次任务支付一次，适合结果明确的 Agent。',
  },
  {
    id: 'cost-plus',
    index: '02',
    title: '按成本加价',
    description: '按真实推理成本与目标毛利计算，适合模型成本波动的任务。',
  },
  {
    id: 'time-pass',
    index: '03',
    title: '按时间定价',
    description: '购买一段时间的访问权，适合陪伴、课程或连续工作流。',
  },
];

function isReleaseStep(value: string | undefined): value is ReleaseStep {
  return value === 'pricing' || value === 'identity' || value === 'review' || value === 'success';
}

function studioUrl(sessionId: string, returnTo: string): string {
  return `/try/session/${encodeURIComponent(sessionId)}?mode=studio&returnTo=${encodeURIComponent(returnTo)}`;
}

function defaultNavigateToStudio(url: string): void {
  window.location.assign(url);
}

function agentMark(name: string): string {
  const cjk = [...name].filter((character) => /[\u3400-\u9fff]/.test(character));
  if (cjk.length > 0) return cjk.slice(0, 2).join('');
  const words = name
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0
    ? words
        .slice(0, 2)
        .map((word) => word[0]!.toUpperCase())
        .join('')
    : 'AG';
}

function handleFeedback(handle: string): { tone: 'neutral' | 'error' | 'ready'; text: string } {
  if (!handle) return { tone: 'neutral', text: '3–32 个小写字母、数字或中间连字符' };
  if (!isValidReleaseHandle(handle)) {
    return { tone: 'error', text: '请使用小写字母、数字和中间连字符' };
  }
  if (RESERVED_HANDLES.has(handle)) {
    return { tone: 'error', text: '这个名称是系统保留词，请换一个' };
  }
  return { tone: 'ready', text: '格式正确；正式接入时还需要检查域名占用' };
}

function ReleaseProgress({
  capabilityId,
  current,
}: {
  capabilityId: string;
  current: ReleaseStep;
}) {
  const active = STEPS.findIndex((item) => item.key === current);
  return (
    <ol className="cb-release-progress" aria-label="定价与发布进度">
      {STEPS.map((item, index) => {
        const state = index < active ? 'done' : index === active ? 'active' : 'pending';
        return (
          <li
            key={item.key}
            data-state={state}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            {index < active ? (
              <Link to={releasePath(capabilityId, item.key)} aria-label={`返回${item.label}`}>
                ✓
              </Link>
            ) : (
              <span>{index + 1}</span>
            )}
            <strong>{item.label}</strong>
          </li>
        );
      })}
    </ol>
  );
}

export interface ReleasePageProps {
  navigateToStudio?: (url: string) => void;
}

export function ReleasePage({
  navigateToStudio = defaultNavigateToStudio,
}: ReleasePageProps = {}): ReactElement {
  const { capabilityId = '', step: rawStep } = useParams();
  const step: ReleaseStep = isReleaseStep(rawStep) ? rawStep : 'pricing';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ReleaseDraft>(() => readReleaseDraft(capabilityId));
  const [storageError, setStorageError] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [releaseNotice, setReleaseNotice] = useState<string | null>(null);
  const [managedSettingsSaved, setManagedSettingsSaved] = useState(false);
  const [isConfirmingPublishedState, setIsConfirmingPublishedState] = useState(false);

  const capabilityQuery = useQuery({
    queryKey: ['capability', capabilityId],
    queryFn: () => getCapability(capabilityId),
    enabled: capabilityId.length > 0,
  });
  const capability = capabilityQuery.data;
  useDocumentTitle(capability ? `${capability.name} · 定价与发布 · Combo` : '定价与发布 · Combo');

  useEffect(() => {
    setDraft(readReleaseDraft(capabilityId));
    setAccepted(false);
    setPublishError(null);
    setReleaseNotice(null);
    setStorageError(false);
    setManagedSettingsSaved(false);
    setIsConfirmingPublishedState(false);
  }, [capabilityId]);

  useEffect(() => {
    if (
      !capability ||
      (draft.agentName === capability.name && draft.agentSummary === capability.summary)
    ) {
      return;
    }
    setDraft((current) => ({
      ...current,
      agentName: capability.name,
      agentSummary: capability.summary,
    }));
  }, [capability, draft.agentName, draft.agentSummary]);

  useEffect(() => {
    if (draft.capabilityId !== capabilityId) return;
    setStorageError(!saveReleaseDraft(draft));
  }, [capabilityId, draft]);

  const studioMutation = useMutation({
    mutationFn: () => createStudioSession(capabilityId),
    onSuccess: ({ session }) => {
      navigateToStudio(studioUrl(session.id, releasePath(capabilityId, step)));
    },
  });

  const publishMutation = useMutation({
    mutationFn: (_completed: ReleaseDraft) => publishCapability(capabilityId),
    onMutate: () => {
      setPublishError(null);
      setManagedSettingsSaved(false);
    },
    onSuccess: (result, completed) => {
      if (!result.published) {
        const resumable: ReleaseDraft = {
          ...completed,
          currentStep: 'review',
          confirmed: false,
          completedAt: undefined,
        };
        setDraft(resumable);
        setStorageError(!saveReleaseDraft(resumable));
        setPublishError('服务端还没有开放这个 Agent 的试用，请稍后重试。');
        return;
      }
      setDraft(completed);
      setStorageError(false);
      queryClient.setQueryData<CapabilityView>(['capability', capabilityId], (current) =>
        current
          ? {
              ...current,
              published: result.published,
              ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
              ...(result.shareToken ? { shareToken: result.shareToken } : {}),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      navigate(releasePath(capabilityId, 'success'));
    },
    onError: (error, completed) => {
      const resumable: ReleaseDraft = {
        ...completed,
        currentStep: 'review',
        confirmed: false,
        completedAt: undefined,
      };
      setDraft(resumable);
      setStorageError(!saveReleaseDraft(resumable));
      setPublishError(error instanceof Error ? error.message : '发布暂时没有完成，请稍后重试。');
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: () => unpublishCapability(capabilityId),
    onMutate: () => {
      setPublishError(null);
      setReleaseNotice(null);
    },
    onSuccess: (result) => {
      if (result.published) {
        setPublishError('服务端没有暂停这个 Agent 的试用，请稍后重试。');
        return;
      }
      const resumed: ReleaseDraft = {
        ...draft,
        currentStep: 'review',
        confirmed: false,
        completedAt: undefined,
      };
      setDraft(resumed);
      setStorageError(!saveReleaseDraft(resumed));
      queryClient.setQueryData<CapabilityView>(['capability', capabilityId], (current) =>
        current
          ? {
              ...current,
              published: result.published,
              publishedAt: undefined,
              shareToken: undefined,
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      setManagedSettingsSaved(false);
      setReleaseNotice('公开试用已暂停。定价和命名草稿已保留，修改后可以再次开放。');
      navigate(releasePath(capabilityId, 'review'));
    },
    onError: (error) => {
      setPublishError(error instanceof Error ? error.message : '暂停试用没有完成，请稍后重试。');
    },
  });

  const handle = draft.handle ?? '';
  const handleStatus = handleFeedback(handle);
  const handleReady = handleStatus.tone === 'ready';
  const pricingReady = isPricingComplete(draft);
  const reviewReady = pricingReady && handleReady;

  useEffect(() => {
    if (draft.capabilityId !== capabilityId) return;
    if ((step === 'identity' || step === 'review') && !pricingReady) {
      navigate(releasePath(capabilityId, 'pricing'), { replace: true });
      return;
    }
    if (step === 'review' && !handleReady) {
      navigate(releasePath(capabilityId, 'identity'), { replace: true });
    }
  }, [capabilityId, draft.capabilityId, handleReady, navigate, pricingReady, step]);

  if (capabilityQuery.isPending) return <Skeleton rows={5} label="正在加载 Agent 发布设置" />;
  if (!capability) {
    return (
      <ErrorState error={capabilityQuery.error} onRetry={() => void capabilityQuery.refetch()} />
    );
  }

  const go = (next: ReleaseStep): void => {
    const nextDraft = { ...draft, currentStep: next };
    setDraft(nextDraft);
    setStorageError(!saveReleaseDraft(nextDraft));
    setAccepted(false);
    setManagedSettingsSaved(false);
    navigate(releasePath(capabilityId, next));
  };
  const updateDraft = (next: Partial<ReleaseDraft>): void => {
    setDraft((current) => ({
      ...current,
      ...next,
      currentStep: step,
      confirmed: false,
      completedAt: undefined,
    }));
    setPublishError(null);
  };
  const trialReturnTo = releasePath(capabilityId, step);
  const actualTrialPath = trialUrl(capabilityId, trialReturnTo);
  const actualTrialUrl = `${window.location.origin}${actualTrialPath}`;

  const finishRelease = async (): Promise<void> => {
    if (!accepted) return;
    setReleaseNotice(null);
    if (!reviewReady) {
      setPublishError('请先完成定价与公开名称，再确认上架。');
      return;
    }
    const completed: ReleaseDraft = {
      ...draft,
      currentStep: 'success',
      confirmed: true,
      completedAt: new Date().toISOString(),
    };
    let serverPublished = false;
    if (capability.published) {
      setIsConfirmingPublishedState(true);
      const refreshed = await capabilityQuery.refetch();
      setIsConfirmingPublishedState(false);
      if (refreshed.isError || !refreshed.data) {
        setPublishError('暂时无法确认 Agent 的公开状态，因此没有保存或发布。请稍后重试。');
        return;
      }
      serverPublished = refreshed.data.published;
    }
    if (!saveReleaseDraft(completed)) {
      setStorageError(true);
      setPublishError('这台设备无法保存定价和域名草稿，因此没有开放试用。请检查浏览器存储权限。');
      return;
    }
    setStorageError(false);
    if (serverPublished) {
      setDraft(completed);
      setManagedSettingsSaved(true);
      navigate(releasePath(capabilityId, 'success'));
    } else {
      publishMutation.mutate(completed);
    }
  };

  return (
    <section className="cb-page cb-release" aria-labelledby="cb-release-title">
      <header className="cb-release__header">
        <div className="cb-release__identity">
          <span className="cb-release__mark" aria-hidden="true">
            {agentMark(capability.name)}
          </span>
          <div>
            <p className="cb-release__eyebrow">定价与发布</p>
            <h1 id="cb-release-title">{capability.name}</h1>
            <p>{capability.summary}</p>
          </div>
        </div>
        <div className="cb-release__header-actions">
          <button
            type="button"
            className="cb-btn"
            disabled={studioMutation.isPending}
            onClick={() => studioMutation.mutate()}
          >
            {studioMutation.isPending ? '正在打开…' : '继续调整 UI'}
          </button>
          <a className="cb-btn" href={actualTrialPath}>
            真实试用
          </a>
        </div>
      </header>

      {studioMutation.isError && (
        <p className="cb-release__error" role="alert">
          没能打开设计空间，请稍后重试。
        </p>
      )}

      <div className="cb-release-boundary" role="note">
        <span className="cb-release-boundary__badge">体验说明</span>
        <p>
          Agent、UI
          调整、试用与上架状态连接真实服务；定价和自定义域名目前只保存在这台设备，不会收费或注册域名。
        </p>
      </div>

      {releaseNotice && (
        <p className="cb-release__notice" role="status">
          {releaseNotice}
        </p>
      )}

      {step === 'success' && publishError && (
        <p className="cb-release__error" role="alert">
          {publishError}
        </p>
      )}

      <ReleaseProgress capabilityId={capabilityId} current={step} />

      {step === 'pricing' && (
        <div className="cb-release-stage" aria-labelledby="cb-pricing-title">
          <div className="cb-release-stage__intro">
            <p>01 · 商业模式</p>
            <h2 id="cb-pricing-title">这个 Agent 如何收费？</h2>
            <span>选择收费方式并完成必要设置；选择会自动保存在这台设备。</span>
          </div>
          <div className="cb-pricing-options" role="radiogroup" aria-label="收费方式">
            {PRICING_OPTIONS.map((option) => (
              <label key={option.id} data-selected={draft.pricingModel === option.id}>
                <input
                  type="radio"
                  name="pricing-model"
                  value={option.id}
                  checked={draft.pricingModel === option.id}
                  onChange={() =>
                    updateDraft({
                      pricingModel: option.id,
                      ...(option.id === 'cost-plus' && draft.marginTarget === undefined
                        ? { marginTarget: 35 }
                        : {}),
                      ...(option.id === 'time-pass' && draft.durationDays === undefined
                        ? { durationDays: 30 }
                        : {}),
                    })
                  }
                />
                <span className="cb-pricing-options__index">{option.index}</span>
                <strong>{option.title}</strong>
                <p>{option.description}</p>
                <span className="cb-pricing-options__check" aria-hidden="true">
                  ✓
                </span>
              </label>
            ))}
          </div>

          {draft.pricingModel && (
            <div className="cb-release-config">
              {draft.pricingModel === 'per-use' && (
                <label>
                  <span>每次使用价格</span>
                  <div className="cb-release-input cb-release-input--money">
                    <span>¥</span>
                    <input
                      aria-label="每次使用价格"
                      type="number"
                      min="0.01"
                      max="100000"
                      step="0.01"
                      value={draft.priceYuan ?? ''}
                      onChange={(event) => updateDraft({ priceYuan: Number(event.target.value) })}
                    />
                    <small>/ 次</small>
                  </div>
                </label>
              )}
              {draft.pricingModel === 'cost-plus' && (
                <label>
                  <span>目标毛利率</span>
                  <div className="cb-release-input cb-release-input--money">
                    <input
                      aria-label="目标毛利率"
                      type="number"
                      min="1"
                      max="95"
                      step="1"
                      value={draft.marginTarget ?? 35}
                      onChange={(event) =>
                        updateDraft({ marginTarget: Number(event.target.value) })
                      }
                    />
                    <small>%</small>
                  </div>
                  <small>真实计费服务接入后才会基于推理成本计算最终售价。</small>
                </label>
              )}
              {draft.pricingModel === 'time-pass' && (
                <>
                  <label>
                    <span>访问价格</span>
                    <div className="cb-release-input cb-release-input--money">
                      <span>¥</span>
                      <input
                        aria-label="时间套餐价格"
                        type="number"
                        min="0.01"
                        max="100000"
                        step="0.01"
                        value={draft.priceYuan ?? ''}
                        onChange={(event) => updateDraft({ priceYuan: Number(event.target.value) })}
                      />
                    </div>
                  </label>
                  <fieldset className="cb-release-duration">
                    <legend>有效期</legend>
                    {[7, 30, 365].map((days) => (
                      <label key={days}>
                        <input
                          type="radio"
                          name="duration"
                          checked={draft.durationDays === days}
                          onChange={() => updateDraft({ durationDays: days as 7 | 30 | 365 })}
                        />
                        <span>{days === 365 ? '1 年' : `${days} 天`}</span>
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
            </div>
          )}

          <footer className="cb-release-stage__footer">
            <span>{isPricingComplete(draft) ? '已保存到当前设备' : '选择方案并完成必要设置'}</span>
            <button
              type="button"
              className="cb-btn cb-btn--primary"
              disabled={!isPricingComplete(draft)}
              onClick={() => go('identity')}
            >
              下一步：命名 →
            </button>
          </footer>
        </div>
      )}

      {step === 'identity' && (
        <div className="cb-release-stage" aria-labelledby="cb-identity-title">
          <div className="cb-release-stage__intro">
            <p>02 · 公开身份</p>
            <h2 id="cb-identity-title">给 Agent 一个容易分享的名字</h2>
            <span>这里只保存预期地址；正式上线时会由域名服务再次检查可用性。</span>
          </div>
          <div className="cb-release-identity-card">
            <label htmlFor="cb-release-handle">自定义子域名</label>
            <div className="cb-release-address" data-invalid={handleStatus.tone === 'error'}>
              <span>https://</span>
              <input
                id="cb-release-handle"
                aria-label="自定义子域名"
                aria-invalid={handleStatus.tone === 'error'}
                value={handle}
                maxLength={32}
                placeholder="your-agent"
                onChange={(event) =>
                  updateDraft({
                    handle: event.target.value.toLowerCase().replace(/\s+/g, '-'),
                  })
                }
              />
              <span>.buildwithcombo.com</span>
            </div>
            <p className="cb-release-address__help" data-tone={handleStatus.tone}>
              {handleStatus.text}
            </p>
            <div className="cb-release-address__preview">
              <span>计划公开地址</span>
              <strong>{handle || 'your-agent'}.buildwithcombo.com</strong>
              <small>尚未注册 · 不会替代真实试用链接</small>
            </div>
          </div>
          <footer className="cb-release-stage__footer">
            <button type="button" className="cb-btn" onClick={() => go('pricing')}>
              ← 返回定价
            </button>
            <button
              type="button"
              className="cb-btn cb-btn--primary"
              disabled={!handleReady}
              onClick={() => go('review')}
            >
              下一步：确认发布 →
            </button>
          </footer>
        </div>
      )}

      {step === 'review' && (
        <div className="cb-release-stage" aria-labelledby="cb-review-title">
          <div className="cb-release-stage__intro">
            <p>03 · 发布确认</p>
            <h2 id="cb-review-title">
              {capability.published ? '检查并保存发布设置' : '确认后开放 Agent 试用'}
            </h2>
            <span>
              {capability.published
                ? 'Agent 已开放试用。你可以保存这台设备上的定价与域名草稿，或继续调整 UI。'
                : '仍然可以返回 UI 设计多次修改，也可以先用真实任务再试一次。'}
            </span>
          </div>
          <div className="cb-release-review">
            <article className="cb-release-review__preview">
              <div className="cb-release-review__preview-top">
                <span>AGENT PREVIEW</span>
                <span>登录用户可试用</span>
              </div>
              <span className="cb-release-review__mark" aria-hidden="true">
                {agentMark(capability.name)}
              </span>
              <p>COMBO AGENT</p>
              <h3>{capability.name}</h3>
              <p>{capability.summary}</p>
              <strong>{pricingLabel(draft)}</strong>
            </article>
            <aside className="cb-release-review__summary">
              <h3>发布清单</h3>
              <dl>
                <div>
                  <dt>Agent</dt>
                  <dd>{capability.name}</dd>
                </div>
                <div>
                  <dt>收费方式</dt>
                  <dd>{pricingLabel(draft)}</dd>
                </div>
                <div>
                  <dt>计划地址</dt>
                  <dd>{handle}.buildwithcombo.com</dd>
                </div>
                <div>
                  <dt>上架范围</dt>
                  <dd>登录用户可试用</dd>
                </div>
              </dl>
              <div className="cb-release-review__checks">
                <a className="cb-btn" href={actualTrialPath}>
                  再真实试用一次
                </a>
              </div>
              <label className="cb-release-accept">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                <span>
                  {capability.published
                    ? '我确认只保存这台设备上的定价和域名草稿；这不会开通计费或注册域名。'
                    : '我确认 Agent 已完成验收，并理解本次会开放试用；定价与域名仍只是本机草稿。'}
                </span>
              </label>
              {publishError && (
                <p className="cb-release__error" role="alert">
                  {publishError}
                </p>
              )}
              <button
                type="button"
                className="cb-btn cb-btn--primary cb-release-review__publish"
                disabled={
                  !accepted ||
                  !reviewReady ||
                  storageError ||
                  publishMutation.isPending ||
                  isConfirmingPublishedState
                }
                onClick={() => void finishRelease()}
              >
                {isConfirmingPublishedState
                  ? '正在确认公开状态…'
                  : publishMutation.isPending
                    ? '正在发布…'
                    : capability.published
                      ? '保存发布草稿 →'
                      : '开放试用并保存草稿 →'}
              </button>
              <small>
                {capability.published
                  ? 'Agent 已经开放试用；此按钮只保存本机草稿。'
                  : '此按钮会真实开放登录用户试用；计费和自定义域名不会提交到服务端。'}
              </small>
            </aside>
          </div>
          <footer className="cb-release-stage__footer">
            <button type="button" className="cb-btn" onClick={() => go('identity')}>
              ← 返回修改名称
            </button>
          </footer>
        </div>
      )}

      {step === 'success' &&
        (draft.confirmed && capability.published ? (
          <article className="cb-release-success" aria-labelledby="cb-release-success-title">
            <span className="cb-release-success__check" aria-hidden="true">
              ✓
            </span>
            <p className="cb-release__eyebrow">
              {managedSettingsSaved ? '设置已保存' : '试用已开放'}
            </p>
            <h2 id="cb-release-success-title">
              {managedSettingsSaved ? '发布设置已保存' : 'Agent 已开放试用，可以继续迭代'}
            </h2>
            <p>
              {managedSettingsSaved
                ? 'Agent 继续保持开放；本次只保存了这台设备上的定价与域名草稿，没有重新发布。'
                : 'Agent 的真实上架状态已经更新；定价与自定义域名仍是本机草稿，不代表商业发布已经完成。'}
            </p>
            <dl>
              <div>
                <dt>Agent</dt>
                <dd>{capability.name}</dd>
              </div>
              <div>
                <dt>本机定价草稿</dt>
                <dd>{pricingLabel(draft)}</dd>
              </div>
              <div>
                <dt>登录后试用入口</dt>
                <dd>{`/try/c/${capabilityId}`}</dd>
              </div>
              <div>
                <dt>计划公开地址</dt>
                <dd>{handle}.buildwithcombo.com · 尚未注册</dd>
              </div>
            </dl>
            <div className="cb-release-success__actions">
              <a
                className="cb-btn cb-btn--primary"
                href={`/a/${encodeURIComponent(handle)}?preview=${encodeURIComponent(capabilityId)}`}
              >
                预览计划公开页 →
              </a>
              <a className="cb-btn cb-btn--primary" href={actualTrialPath}>
                打开登录后试用 →
              </a>
              <CopyButton
                text={actualTrialUrl}
                label="复制登录后试用链接"
                ariaLabel={`复制「${capability.name}」登录后试用链接`}
                className="cb-btn"
              />
              <button type="button" className="cb-btn" onClick={() => go('pricing')}>
                修改发布设置
              </button>
              <button
                type="button"
                className="cb-btn"
                disabled={unpublishMutation.isPending}
                onClick={() => unpublishMutation.mutate()}
              >
                {unpublishMutation.isPending ? '正在暂停…' : '暂停公开试用'}
              </button>
              <Link className="cb-btn" to="/capabilities">
                返回我的 Agent
              </Link>
            </div>
          </article>
        ) : (
          <article className="cb-release-success cb-release-success--incomplete">
            <p className="cb-release__eyebrow">发布尚未确认</p>
            <h2>你的设置还在，不需要重新填写</h2>
            <p>回到确认页完成最后一步；系统不会把未确认的本地草稿冒充成已发布结果。</p>
            <button type="button" className="cb-btn cb-btn--primary" onClick={() => go('review')}>
              继续确认 →
            </button>
          </article>
        ))}

      {storageError && (
        <p className="cb-release__error" role="alert">
          这次设置没有保存成功。请检查浏览器存储权限后再继续。
        </p>
      )}
    </section>
  );
}
