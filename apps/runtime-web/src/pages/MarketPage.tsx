// 入口页（能力市集）：能力卡网格（我的 + 已发布）+ 历史会话续聊 chips。
// 每张卡按「是否已有会话」给动作：没有 → 开始会话；已有 → 继续最近会话 + 另开新会话。
// 空市集给双模式引导面板（发布三步 / 示例能力卡），示例是静态文案、不可运行。
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { SessionView } from '@cb/shared';
import { ApiError } from '../api/client.js';
import {
  useCapabilities,
  useCreateSession,
  useSessions,
  type TrialCapability,
} from '../api/runtime.js';
import { QueryErrorNotice } from '../components/QueryErrorNotice.js';
import { useRuntimeMe } from '../shell/AuthGate.js';
import { useDocumentTitle } from '../shell/useDocumentTitle.js';

const KIND_LABEL: Record<string, string> = {
  html: '网页',
  markdown: '文档',
  code: '代码',
  structured: '结构化',
};

type EmptyMarketMode = 'guide' | 'examples';

interface ExampleCapability {
  name: string;
  typeLabel: string;
  audience: string;
  outcome: string;
  context: string;
}

/** 空市集的示例卡（纯展示，不可运行）。 */
const exampleCapabilities: ExampleCapability[] = [
  {
    name: '真实长会话能力提取评审',
    typeLabel: '产品 / 流程',
    audience: '正在把私有经验产品化的创作者',
    outcome: '判断候选能力是否独特、利他、可运行',
    context: '来自创作者对真实 session 聚类质量、泛任务过滤和发布边界的连续讨论',
  },
  {
    name: 'Figma 到前端的品牌刷新',
    typeLabel: '设计 / 前端',
    audience: '需要把新品牌落进已有产品界面的团队',
    outcome: '输出页面结构、状态、组件和实现要点',
    context: '来自 Combo 品牌、侧边栏、加载态和上传流程设计调整记录',
  },
  {
    name: '本地真实配置测试闭环',
    typeLabel: '工程 / QA',
    audience: '需要验证登录、上传、发布和 runtime 的开发者',
    outcome: '给出可复跑的测试证据、阻塞项和修复建议',
    context: '来自真实运行时元数据、上传内容和 Task 进度的连续验收任务',
  },
];

/** 每个能力下最近更新的一条会话（卡片「继续会话」入口）。 */
function latestSessionByCapability(items: SessionView[]): Map<string, SessionView> {
  const latest = new Map<string, SessionView>();
  for (const item of items) {
    const seen = latest.get(item.capabilityId);
    if (!seen || new Date(item.updatedAt) > new Date(seen.updatedAt)) {
      latest.set(item.capabilityId, item);
    }
  }
  return latest;
}

export function MarketPage() {
  useDocumentTitle('能力市集 · Combo');
  const navigate = useNavigate();
  const caps = useCapabilities();
  const sessions = useSessions();
  const createSession = useCreateSession();
  const [emptyMode, setEmptyMode] = useState<EmptyMarketMode>('guide');
  const [errorById, setErrorById] = useState<{ id: string; message: string } | null>(null);
  const sessionByCapability = useMemo(
    () => latestSessionByCapability(sessions.data ?? []),
    [sessions.data],
  );

  const startNew = (capability: TrialCapability) => {
    if (createSession.isPending) return;
    setErrorById(null);
    createSession.mutate(capability.id, {
      onSuccess: (session) => navigate(`/session/${session.id}`),
      onError: (err) =>
        setErrorById({
          id: capability.id,
          message: err instanceof ApiError ? err.userMessage : '无法开始会话，请稍后重试。',
        }),
    });
  };

  const mine = caps.data?.filter((c) => c.owned) ?? [];
  const published = caps.data?.filter((c) => !c.owned) ?? [];

  return (
    <div className="rt-market">
      <section className="rt-market__hero">
        <h1 className="rt-market__title">挑一个能力，直接开聊</h1>
        <p className="rt-market__lede">
          每个能力都从一次真实会话里长出来。选一个，像和它对话一样把活干完——产物会实时生成在右侧。
        </p>
      </section>

      {sessions.data && sessions.data.length > 0 && (
        <section className="rt-market__section">
          <h2 className="rt-market__section-title">继续之前的会话</h2>
          <div className="rt-session-chips">
            {sessions.data.slice(0, 8).map((s) => (
              <Link key={s.id} to={`/session/${s.id}`} className="rt-session-chip">
                <span className="rt-session-chip__title">{s.title ?? '未命名会话'}</span>
                <span className="rt-session-chip__cap">
                  {new Date(s.updatedAt).toLocaleString('zh-CN')}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {caps.isPending && <div className="rt-empty">加载中…</div>}
      {caps.isError && <QueryErrorNotice error={caps.error} onRetry={() => void caps.refetch()} />}
      {caps.data && caps.data.length === 0 && (
        <EmptyMarket mode={emptyMode} onModeChange={setEmptyMode} />
      )}

      {mine.length > 0 && (
        <CapabilitySection
          title="我的能力"
          items={mine}
          pending={createSession.isPending}
          errorById={errorById}
          sessionByCapability={sessionByCapability}
          onStartNew={startNew}
        />
      )}
      {published.length > 0 && (
        <CapabilitySection
          title="能力市集"
          items={published}
          pending={createSession.isPending}
          errorById={errorById}
          sessionByCapability={sessionByCapability}
          onStartNew={startNew}
        />
      )}
    </div>
  );
}

function CapabilitySection({
  title,
  items,
  pending,
  errorById,
  sessionByCapability,
  onStartNew,
}: {
  title: string;
  items: TrialCapability[];
  pending: boolean;
  errorById: { id: string; message: string } | null;
  sessionByCapability: Map<string, SessionView>;
  onStartNew: (capability: TrialCapability) => void;
}) {
  return (
    <section className="rt-market__section">
      <h2 className="rt-market__section-title">{title}</h2>
      <div className="rt-card-grid">
        {items.map((c) => {
          const linked = sessionByCapability.get(c.id);
          return (
            <article key={c.id} className="rt-card">
              <div className="rt-card__type">{KIND_LABEL[c.kind] ?? c.kind}</div>
              <h3 className="rt-card__name">{c.name}</h3>
              <p className="rt-card__tagline">{c.summary}</p>
              <div className="rt-card__meta">
                <span className="rt-card__byline">{c.owned ? '我创作的' : '来自市集'}</span>
                <span>{linked ? '已有会话' : '尚未运行'}</span>
              </div>
              <div className="rt-card__foot">
                {linked ? (
                  <>
                    <button
                      type="button"
                      className="rt-btn"
                      disabled={pending}
                      onClick={() => onStartNew(c)}
                    >
                      {pending ? '创建中…' : '新会话'}
                    </button>
                    <Link to={`/session/${linked.id}`} className="rt-btn rt-btn--accent">
                      继续会话
                    </Link>
                  </>
                ) : (
                  <button
                    type="button"
                    className="rt-btn rt-btn--accent"
                    disabled={pending}
                    onClick={() => onStartNew(c)}
                  >
                    {pending ? '创建中…' : '开始会话'}
                  </button>
                )}
              </div>
              {errorById?.id === c.id && <div className="rt-card__error">{errorById.message}</div>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function EmptyMarket({
  mode,
  onModeChange,
}: {
  mode: EmptyMarketMode;
  onModeChange: (mode: EmptyMarketMode) => void;
}) {
  const me = useRuntimeMe();
  const isCreator = Boolean(me?.roles?.includes('creator'));
  return (
    <div className="rt-market-empty">
      <div className="rt-market-empty__intro">
        <div className="rt-market-empty__kicker">当前没有可试用的能力</div>
        <h3 className="rt-market-empty__title">市集还在等第一个真实能力上架</h3>
        <p className="rt-market-empty__copy">
          能力只会在创作者上传任务、提取并确认后出现在这里。未提取的候选和原始会话不会进入试用视角。
        </p>
        <div className="rt-market-empty__actions" aria-label="空市集操作">
          {/* 提取能力是创作端动作，只对创作者渲染；消费者不该被引去登录门（#27）。 */}
          {isCreator && (
            <a className="rt-btn rt-btn--accent" href="/tasks">
              去提取第一个能力
            </a>
          )}
          <button
            type="button"
            className="rt-btn"
            aria-pressed={mode === 'examples'}
            onClick={() => onModeChange('examples')}
          >
            查看示例能力
          </button>
          <button
            type="button"
            className="rt-btn"
            aria-pressed={mode === 'guide'}
            onClick={() => onModeChange('guide')}
          >
            了解如何发布
          </button>
        </div>
      </div>

      {mode === 'examples' ? (
        <div className="rt-market-empty__examples" aria-label="示例能力">
          {exampleCapabilities.map((item) => (
            <article className="rt-example-card" key={item.name}>
              <div className="rt-example-card__head">
                <span className="rt-card__type">{item.typeLabel}</span>
                <span className="rt-example-card__badge">示例，不可运行</span>
              </div>
              <h4 className="rt-example-card__title">{item.name}</h4>
              <dl className="rt-example-card__facts">
                <div>
                  <dt>帮助谁</dt>
                  <dd>{item.audience}</dd>
                </div>
                <div>
                  <dt>交付什么</dt>
                  <dd>{item.outcome}</dd>
                </div>
                <div>
                  <dt>为什么独特</dt>
                  <dd>{item.context}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <ol className="rt-market-empty__steps" aria-label="发布流程">
          <li>
            <span className="rt-market-empty__step-index">1</span>
            <div>
              <strong>上传真实会话</strong>
              <p>从创作者自己的长 session 开始，保留足够上下文让系统识别独特经验。</p>
            </div>
          </li>
          <li>
            <span className="rt-market-empty__step-index">2</span>
            <div>
              <strong>提取能力项</strong>
              <p>系统按会话聚出候选能力，只留下和创作者经验强相关、能帮助他人的。</p>
            </div>
          </li>
          <li>
            <span className="rt-market-empty__step-index">3</span>
            <div>
              <strong>确认后发布</strong>
              <p>创作者发布后，其他用户才能在市集开聊；未发布内容不会展示。</p>
            </div>
          </li>
        </ol>
      )}
    </div>
  );
}
