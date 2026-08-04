import { useState, type KeyboardEvent, type ReactElement } from 'react';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import {
  clearLandingDraft,
  normalizePublicProfileUrl,
  readLandingDraft,
  saveLandingDraft,
  type LandingDraft,
} from './landingDraft.js';
import './landing.css';

export const CODING_AGENT_CREATION_TASK = `请帮我用 Combo 创建一个 KOL Agent。

- 开始前，先列出你计划读取的本地 Codex / Claude 会话目录和数据范围，等我确认。
- 不删除或改写任何本地文件。
- 打开 Combo 的「上传任务」页，按页面生成的一次性连接指令完成上传。
- 上传结束后停止，并提醒我回到 Combo，在同一个项目里查看、试用和验收 Agent。

如果还没有一次性连接指令，请先停下并提醒我在 Combo 中打开连接页。`;

type CreationMethod = 'coding-agent' | 'combo';
type DemoAgentId = 'style' | 'content' | 'reflection';
type DemoAnswerMode = 'generic' | 'agent';
type ValidationField = 'profileUrl' | 'consent' | 'sample' | 'storage';

interface DemoAgent {
  id: DemoAgentId;
  tabLabel: string;
  category: string;
  name: string;
  description: string;
  input: string;
  outputTitle: string;
  outputBody: string;
  outputPoints: readonly string[];
  genericAnswer: string;
  artifactLabel: string;
}

interface ValidationState {
  field: ValidationField;
  message: string;
}

const DEMO_AGENTS: readonly DemoAgent[] = [
  {
    id: 'style',
    tabLabel: '穿搭',
    category: '生活方式',
    name: '场合穿搭顾问',
    description: '根据场景、天气与个人偏好，给出能直接执行的搭配建议。',
    input: '周六晚上上海约会，18℃。我想穿得松弛一点，但不要太随意。',
    outputTitle: '奶油色针织衫 + 深灰直筒裤',
    outputBody: '颜色柔和但轮廓清楚，适合室内外温差，也不会显得为了约会过度用力。',
    outputPoints: ['外搭选择短款深色夹克', '鞋子用低饱和德训鞋', '下雨时替换为防水乐福鞋'],
    genericAnswer: '可以选择舒适、简约的约会穿搭，并根据天气搭配一件合适的外套。',
    artifactLabel: '搭配方案',
  },
  {
    id: 'content',
    tabLabel: '内容',
    category: '内容创作',
    name: '选题拆解助手',
    description: '从一段公开内容中识别受众、冲突和可以复用的表达结构。',
    input: '帮我把“低预算也能建立个人风格”拆成一条适合短视频的内容。',
    outputTitle: '从“买得少”切入，而不是“买得便宜”',
    outputBody: '先反转用户对低预算的理解，再用三件高频单品建立具体方法，结尾给出自检问题。',
    outputPoints: [
      '开头：预算不是风格的敌人',
      '中段：三件单品重复搭配',
      '结尾：你的衣柜是否有主线',
    ],
    genericAnswer: '可以从省钱技巧、平价单品推荐和搭配方法几个角度展开这条内容。',
    artifactLabel: '内容结构',
  },
  {
    id: 'reflection',
    tabLabel: '复盘',
    category: '个人成长',
    name: '人生选择复盘',
    description: '把一段经历整理成事件脉络、关键选择和下一步可以回答的问题。',
    input: '我想换工作，但分不清自己是在逃避现在，还是确实需要新的成长空间。',
    outputTitle: '先区分“消耗来源”和“成长缺口”',
    outputBody: '过去三个月的疲惫并不完全来自工作量，更像是自主权下降和反馈周期变长的叠加。',
    outputPoints: [
      '哪些消耗换公司后仍会存在',
      '你真正想增加的决策权是什么',
      '先做一个两周的低成本验证',
    ],
    genericAnswer: '建议综合考虑薪资、发展空间、团队氛围和个人感受，再权衡是否换工作。',
    artifactLabel: '选择复盘',
  },
];
const DEFAULT_DEMO_AGENT = DEMO_AGENTS[0]!;

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.appendChild(fallback);
  fallback.select();
  const copied = document.execCommand('copy');
  fallback.remove();
  if (!copied) throw new Error('clipboard unavailable');
}

function PreparedSource({
  draft,
  onEdit,
}: {
  draft: LandingDraft;
  onEdit: () => void;
}): ReactElement {
  return (
    <div className="cb-landing-prepared" role="status" aria-live="polite">
      <div className="cb-landing-prepared__mark" aria-hidden="true">
        ✓
      </div>
      <div className="cb-landing-prepared__copy">
        <strong>资料已准备好</strong>
        <p>尚未提交或上传。托管创建正在内测，资料只保存在当前浏览器会话中。</p>
        <span title={draft.profileUrl}>{draft.profileUrl}</span>
      </div>
      <div className="cb-landing-prepared__actions">
        <button
          type="button"
          className="cb-landing-action cb-landing-action--primary"
          disabled
          title="托管创建服务开放后才可提交"
        >
          托管创建即将开放
        </button>
        <button
          type="button"
          className="cb-landing-action cb-landing-action--quiet"
          onClick={onEdit}
        >
          修改资料
        </button>
      </div>
    </div>
  );
}

function AgentPreview({
  activeDemoId,
  onDemoChange,
}: {
  activeDemoId: DemoAgentId;
  onDemoChange: (id: DemoAgentId) => void;
}): ReactElement {
  const activeDemo = DEMO_AGENTS.find((demo) => demo.id === activeDemoId) ?? DEFAULT_DEMO_AGENT;
  const [answerMode, setAnswerMode] = useState<DemoAnswerMode>('agent');

  const selectDemo = (id: DemoAgentId): void => {
    onDemoChange(id);
    setAnswerMode('agent');
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % DEMO_AGENTS.length;
    else if (event.key === 'ArrowLeft')
      nextIndex = (index - 1 + DEMO_AGENTS.length) % DEMO_AGENTS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = DEMO_AGENTS.length - 1;
    else return;

    event.preventDefault();
    const nextDemo = DEMO_AGENTS[nextIndex] ?? DEFAULT_DEMO_AGENT;
    selectDemo(nextDemo.id);
    requestAnimationFrame(() => document.getElementById(`cb-demo-tab-${nextDemo.id}`)?.focus());
  };

  return (
    <section className="cb-landing-preview" aria-labelledby="cb-landing-preview-title">
      <header className="cb-landing-preview__bar">
        <div>
          <span className="cb-landing-preview__live" aria-hidden="true" />
          <strong id="cb-landing-preview-title">Agent 示例预览</strong>
        </div>
        <span>交互示意 · 示例数据</span>
      </header>

      <div className="cb-landing-preview__switcher" role="tablist" aria-label="切换 Agent 示例">
        {DEMO_AGENTS.map((demo, index) => (
          <button
            key={demo.id}
            id={`cb-demo-tab-${demo.id}`}
            type="button"
            role="tab"
            aria-selected={activeDemo.id === demo.id}
            aria-controls="cb-landing-demo-panel"
            tabIndex={activeDemo.id === demo.id ? 0 : -1}
            className="cb-landing-preview__tab"
            onClick={() => selectDemo(demo.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {demo.tabLabel}
          </button>
        ))}
      </div>

      <div
        id="cb-landing-demo-panel"
        className="cb-landing-preview__canvas"
        data-demo={activeDemo.id}
        role="tabpanel"
        aria-labelledby={`cb-demo-tab-${activeDemo.id}`}
      >
        <div className="cb-landing-preview__identity">
          <span className="cb-landing-preview__avatar" aria-hidden="true">
            {activeDemo.name.slice(0, 1)}
          </span>
          <div>
            <span>{activeDemo.category}</span>
            <strong>{activeDemo.name}</strong>
          </div>
          <span className="cb-landing-preview__badge">示例 Agent</span>
        </div>

        <div className="cb-landing-preview__intro">
          <h2>{activeDemo.name}</h2>
          <p>{activeDemo.description}</p>
        </div>

        <div className="cb-landing-preview__conversation">
          <article className="cb-landing-preview__prompt">
            <span>一个真实问题</span>
            <p>{activeDemo.input}</p>
          </article>

          <div className="cb-landing-preview__compare" aria-label="比较回答方式">
            <span>比较回答</span>
            <div>
              <button
                type="button"
                aria-pressed={answerMode === 'generic'}
                onClick={() => setAnswerMode('generic')}
              >
                普通回答
              </button>
              <button
                type="button"
                aria-pressed={answerMode === 'agent'}
                onClick={() => setAnswerMode('agent')}
              >
                这个 Agent
              </button>
            </div>
          </div>

          {answerMode === 'generic' ? (
            <article className="cb-landing-preview__generic">
              <span>常见的通用回答</span>
              <p>{activeDemo.genericAnswer}</p>
              <small>信息正确，但没有保留创作者独有的判断方式。</small>
            </article>
          ) : (
            <article className="cb-landing-preview__answer">
              <span>{activeDemo.artifactLabel}</span>
              <h3>{activeDemo.outputTitle}</h3>
              <p>{activeDemo.outputBody}</p>
              <ol>
                {activeDemo.outputPoints.map((point, index) => (
                  <li key={point}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    {point}
                  </li>
                ))}
              </ol>
            </article>
          )}
        </div>
      </div>

      <p className="cb-landing-preview__note">
        这里展示的是交互与结果形态，不会发起真实推理，也不代表任何真实账号数据。
      </p>
    </section>
  );
}

export function LandingPage(): ReactElement {
  useDocumentTitle('把内容变成可工作的 Agent · Combo');
  const [prepared, setPrepared] = useState<LandingDraft | null>(() => readLandingDraft());
  const [profileUrl, setProfileUrl] = useState(() => prepared?.profileUrl ?? '');
  const [sampleText, setSampleText] = useState(() => prepared?.sampleText ?? '');
  const [consent, setConsent] = useState(() => prepared?.consent ?? false);
  const [validation, setValidation] = useState<ValidationState | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [activeMethod, setActiveMethod] = useState<CreationMethod | null>(() =>
    prepared ? 'combo' : null,
  );
  const [activeDemoId, setActiveDemoId] = useState<DemoAgentId>('style');

  const copyTask = async (): Promise<void> => {
    try {
      await writeClipboard(CODING_AGENT_CREATION_TASK);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const prepareManagedSource = (): void => {
    const normalized = normalizePublicProfileUrl(profileUrl);
    if (!normalized) {
      setValidation({
        field: 'profileUrl',
        message: '请粘贴一个公开的 http(s) 主页链接。',
      });
      return;
    }
    if (!consent) {
      setValidation({ field: 'consent', message: '请先确认你有权使用这份公开内容。' });
      return;
    }
    const sample = sampleText.trim();
    if (sample && sample.length < 20) {
      setValidation({ field: 'sample', message: '代表内容至少写 20 个字，或者先留空。' });
      return;
    }

    const result = saveLandingDraft({
      profileUrl: normalized,
      consent: true,
      ...(sample ? { sampleText: sample } : {}),
    });
    if (!result.ok) {
      setValidation({
        field: 'storage',
        message:
          result.reason === 'unavailable'
            ? '浏览器没能暂存这份资料，请检查隐私设置后重试。'
            : '这份资料还不能保存，请检查后重试。',
      });
      return;
    }

    setProfileUrl(result.value.profileUrl);
    setPrepared(result.value);
    setValidation(null);
  };

  const editManagedSource = (): void => {
    clearLandingDraft();
    setPrepared(null);
    setValidation(null);
  };

  return (
    <article className="cb-landing">
      <section className="cb-landing-workbench" aria-labelledby="cb-landing-title">
        <div className="cb-landing-workbench__bar" aria-hidden="true">
          <span className="cb-landing-workbench__lights">
            <i />
            <i />
            <i />
          </span>
          <span>NEW AGENT</span>
          <span>CONTEXT → AGENT</span>
        </div>

        <div className="cb-landing-workbench__grid">
          <div className="cb-landing-builder">
            <header className="cb-landing-builder__intro">
              <p className="cb-landing-eyebrow">COMBO · CREATE</p>
              <h1 id="cb-landing-title">把你的内容，变成一个可以工作的 Agent。</h1>
              <p>
                现在可以交给你的 Coding Agent
                完成创建，也可以先准备公开主页资料。先看懂结果形态，再进入工作区承接生成。
              </p>
              <div className="cb-landing-builder__promise" aria-label="创建承诺">
                <span>浏览无需登录</span>
                <span>登录前不会上传</span>
                <span>生成后可反复修改</span>
              </div>
            </header>

            <div className="cb-landing-methods">
              <p className="cb-landing-methods__label">选择准备 Context 的方式</p>
              <div className="cb-landing-method-tabs" aria-label="创建 Agent 的方式">
                <button
                  id="cb-landing-agent-trigger"
                  type="button"
                  aria-expanded={activeMethod === 'coding-agent'}
                  aria-controls="cb-landing-agent-panel"
                  className="cb-landing-method-tab"
                  onClick={() => setActiveMethod('coding-agent')}
                >
                  <span>01</span>
                  <strong>使用 Coding Agent</strong>
                  <small>Codex · WorkBuddy</small>
                </button>
                <button
                  id="cb-landing-combo-trigger"
                  type="button"
                  aria-expanded={activeMethod === 'combo'}
                  aria-controls="cb-landing-combo-panel"
                  className="cb-landing-method-tab"
                  onClick={() => setActiveMethod('combo')}
                >
                  <span>02</span>
                  <strong>粘贴公开主页</strong>
                  <small>Combo 托管创建</small>
                </button>
              </div>

              {activeMethod === null && (
                <div className="cb-landing-method-empty">
                  <span aria-hidden="true">↳</span>
                  <p>
                    <strong>选择一种方式开始</strong>
                    Coding Agent 创建现在可用；公开主页托管创建正在内测。
                  </p>
                </div>
              )}

              {activeMethod === 'coding-agent' && (
                <section
                  className="cb-landing-method-panel"
                  id="cb-landing-agent-panel"
                  role="region"
                  aria-labelledby="cb-landing-agent-trigger"
                >
                  <div className="cb-landing-method-panel__head">
                    <div>
                      <h2>把创建任务交给你的 Coding Agent</h2>
                      <p>它会先列出读取范围，得到你确认后再连接 Combo。</p>
                    </div>
                    <span>本地执行</span>
                  </div>

                  <ol className="cb-landing-method-panel__steps">
                    <li>复制任务</li>
                    <li>确认读取范围</li>
                    <li>回到 Combo 验收</li>
                  </ol>

                  <details className="cb-landing-task">
                    <summary>查看将复制的完整任务</summary>
                    <pre>{CODING_AGENT_CREATION_TASK}</pre>
                  </details>

                  <div className="cb-landing-method-panel__footer">
                    <button
                      type="button"
                      className="cb-landing-action cb-landing-action--primary"
                      onClick={() => void copyTask()}
                    >
                      {copyState === 'copied' ? '重新复制任务' : '复制创建任务'}
                    </button>
                    <p
                      className="cb-landing-status"
                      data-tone={copyState}
                      role={
                        copyState === 'failed'
                          ? 'alert'
                          : copyState === 'copied'
                            ? 'status'
                            : undefined
                      }
                      aria-live={copyState === 'idle' ? undefined : 'polite'}
                    >
                      {copyState === 'copied'
                        ? '任务已复制。把它发给你的 Coding Agent 即可。'
                        : copyState === 'failed'
                          ? '没有成功写入剪贴板，请展开任务并手动复制。'
                          : '只写入剪贴板，不会读取或上传本机文件。'}
                    </p>
                  </div>
                </section>
              )}

              {activeMethod === 'combo' && (
                <section
                  className="cb-landing-method-panel"
                  id="cb-landing-combo-panel"
                  role="region"
                  aria-labelledby="cb-landing-combo-trigger"
                >
                  <div className="cb-landing-method-panel__head">
                    <div>
                      <h2>粘贴你的公开主页</h2>
                      <p>先在浏览器中准备资料，不会提交或上传；托管创建开放后再由你确认。</p>
                    </div>
                    <span>内测准备</span>
                  </div>

                  {prepared ? (
                    <PreparedSource draft={prepared} onEdit={editManagedSource} />
                  ) : (
                    <form
                      className="cb-landing-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        prepareManagedSource();
                      }}
                    >
                      <label className="cb-landing-field" htmlFor="landing-profile-url">
                        <span>公开主页 URL</span>
                        <input
                          id="landing-profile-url"
                          aria-label="公开主页 URL"
                          type="url"
                          inputMode="url"
                          autoComplete="url"
                          maxLength={2_048}
                          aria-invalid={validation?.field === 'profileUrl'}
                          aria-describedby={
                            validation?.field === 'profileUrl'
                              ? 'cb-landing-form-error'
                              : 'cb-landing-profile-help'
                          }
                          placeholder="https://www.xiaohongshu.com/user/profile/..."
                          value={profileUrl}
                          onChange={(event) => {
                            setProfileUrl(event.target.value);
                            if (validation?.field === 'profileUrl') setValidation(null);
                          }}
                        />
                        <small id="cb-landing-profile-help">
                          支持公开访问的个人主页；现在填写不会立即上传。
                        </small>
                      </label>

                      <label
                        className="cb-landing-consent"
                        htmlFor="landing-profile-consent"
                        data-invalid={validation?.field === 'consent'}
                      >
                        <input
                          id="landing-profile-consent"
                          type="checkbox"
                          checked={consent}
                          aria-invalid={validation?.field === 'consent'}
                          aria-describedby={
                            validation?.field === 'consent' ? 'cb-landing-form-error' : undefined
                          }
                          onChange={(event) => {
                            setConsent(event.target.checked);
                            if (validation?.field === 'consent') setValidation(null);
                          }}
                        />
                        <span>我是账号本人或已获授权，同意登录后分析本次公开内容。</span>
                      </label>

                      <details className="cb-landing-sample">
                        <summary>可选：补充一段代表内容</summary>
                        <label className="cb-landing-field">
                          <span>代表内容</span>
                          <textarea
                            rows={5}
                            maxLength={20_000}
                            aria-invalid={validation?.field === 'sample'}
                            aria-describedby={
                              validation?.field === 'sample' ? 'cb-landing-form-error' : undefined
                            }
                            placeholder="一段口播、帖子、课程节选，或你最满意的真实案例…"
                            value={sampleText}
                            onChange={(event) => {
                              setSampleText(event.target.value);
                              if (validation?.field === 'sample') setValidation(null);
                            }}
                          />
                          <small>{sampleText.length.toLocaleString('zh-CN')} / 20,000 字</small>
                        </label>
                      </details>

                      {validation && (
                        <p
                          id="cb-landing-form-error"
                          className="cb-landing-form__error"
                          role="alert"
                        >
                          {validation.message}
                        </p>
                      )}

                      <div className="cb-landing-method-panel__footer">
                        <button
                          type="submit"
                          className="cb-landing-action cb-landing-action--primary"
                        >
                          准备这份资料
                        </button>
                        <p className="cb-landing-status">
                          只暂存在当前标签页会话中，不会请求 Combo 服务。
                        </p>
                      </div>
                    </form>
                  )}
                </section>
              )}
            </div>
          </div>

          <AgentPreview activeDemoId={activeDemoId} onDemoChange={setActiveDemoId} />
        </div>
      </section>

      <section className="cb-landing-journey" aria-labelledby="cb-landing-journey-title">
        <header>
          <p className="cb-landing-eyebrow">CREATE → REFINE → PUBLISH</p>
          <h2 id="cb-landing-journey-title">第一次创作，只需要把 Context 交进来。</h2>
          <p>生成后再进入 Studio 调试内容、效果与 UI；满意之后，才需要决定是否发布。</p>
        </header>
        <ol>
          <li>
            <span>01</span>
            <div>
              <strong>创建 Agent</strong>
              <p>真实工作历史现在可进入 Agent 项目；公开主页托管链路开放后也会汇入这里。</p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>调试并发布</strong>
              <p>反复修改内容和页面，通过真实任务验证后再发布。</p>
            </div>
          </li>
        </ol>
      </section>
    </article>
  );
}
