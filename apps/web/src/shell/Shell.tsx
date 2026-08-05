// 导航外壳 Shell：左侧固定侧栏 + 主内容区，全流程恒定结构（无顶栏，内容直接从主区顶部开始）。
//
// 侧栏：顶部 Combo 品牌字标 + 收起/展开开关；中段三项导航（任务 / 能力 / 市集）；底部当前账号常驻区。
// 子页经 <Outlet> 渲染。
import type { ReactElement } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { CREATOR_NAV, type NavItem } from './routes.js';
import { useCollapse } from './useCollapse.js';
import { useAccount } from './account.js';
import { ComboMark, ComboWordmark } from './brand.js';
import { IconChevrons } from './icons.js';
import { AccountMenu } from './AccountMenu.js';
import { useReleaseMetadata } from './releaseIdentity.js';
import type { CreationResumeSummary } from './creationResume.js';

export interface ShellProps {
  /** 最近一项可继续的创作；数据由受保护布局读取，Shell 只负责稳定展示。 */
  creationResume?: CreationResumeSummary;
}

export function Shell({ creationResume }: ShellProps = {}): ReactElement {
  const { collapsed, toggle: toggleCollapse } = useCollapse();
  const account = useAccount();
  const releaseMetadata = useReleaseMetadata();

  return (
    <div className="cb-shell" data-collapsed={collapsed ? 'true' : 'false'}>
      {/* 左侧栏：恒定结构。收起时整体收窄为纯图标态。 */}
      <aside className="cb-shell__sidebar" aria-label="侧边导航">
        <div className="cb-shell__brand">
          <Link to="/tasks" className="cb-shell__brand-link" aria-label="Combo 创作者中心 首页">
            <ComboMark className="cb-shell__brand-mark" />
            <ComboWordmark className="cb-shell__brand-word" />
          </Link>
          <button
            type="button"
            className="cb-shell__collapse"
            onClick={toggleCollapse}
            aria-pressed={collapsed}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
          >
            <IconChevrons
              className="cb-shell__collapse-icon"
              style={collapsed ? { transform: 'rotate(180deg)' } : undefined}
            />
          </button>
        </div>

        <Link
          to="/tasks?create=1"
          className="cb-shell__create-agent"
          aria-label="创建 Agent"
          title={collapsed ? '创建 Agent' : undefined}
        >
          <span className="cb-shell__create-agent-icon" aria-hidden="true">
            ＋
          </span>
          <span className="cb-shell__create-agent-label">创建 Agent</span>
        </Link>

        <nav className="cb-shell__nav" aria-label="主导航">
          <ul className="cb-shell__navlist">
            {CREATOR_NAV.map((n) => (
              <NavItemLink key={n.path} item={n} collapsed={collapsed} />
            ))}
          </ul>
        </nav>

        {creationResume && (
          <section className="cb-shell__resume" aria-label="当前创作">
            <Link
              to={creationResume.href}
              className="cb-shell__resume-primary"
              aria-label={`继续创作：${creationResume.title}，${creationResume.stage}`}
              title={
                collapsed
                  ? `${creationResume.title} · ${creationResume.stage} · 继续创作`
                  : undefined
              }
            >
              <span className="cb-shell__resume-signal" aria-hidden="true">
                <span />
                {creationResume.total > 1 && (
                  <span className="cb-shell__resume-badge">{creationResume.total}</span>
                )}
              </span>
              <span className="cb-shell__resume-copy">
                <span className="cb-shell__resume-eyebrow">当前创作</span>
                <strong className="cb-shell__resume-title">{creationResume.title}</strong>
                <span className="cb-shell__resume-stage">{creationResume.stage}</span>
              </span>
              <span className="cb-shell__resume-action" aria-hidden="true">
                继续 →
              </span>
            </Link>
            {creationResume.total > 1 && (
              <Link to="/creation/tasks" className="cb-shell__resume-summary">
                另有 {creationResume.total - 1} 个创作
              </Link>
            )}
          </section>
        )}

        {/* 侧栏底部：当前账号常驻区；点击整行（收起态为头像）打开账号菜单。 */}
        <AccountMenu account={account} environment={releaseMetadata.environment} />
      </aside>

      {/* 主区：仅内容 Outlet（无顶栏，账号常驻区在侧栏底部）。 */}
      <div className="cb-shell__main">
        <main className="cb-shell__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** 单条侧栏导航项：展开显图标+文字；收起仅图标，文字降级为 title tooltip。 */
function NavItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }): ReactElement {
  const Icon = item.icon;
  const content = (
    <>
      <Icon className="cb-shell__navicon" />
      <span className="cb-shell__navlabel">{item.label}</span>
    </>
  );
  if (item.external) {
    return (
      <li>
        <a
          href={item.path}
          className="cb-shell__navlink"
          title={collapsed ? item.label : undefined}
        >
          {content}
        </a>
      </li>
    );
  }
  return (
    <li>
      <NavLink
        to={item.path}
        className={({ isActive }) =>
          isActive ? 'cb-shell__navlink cb-shell__navlink--active' : 'cb-shell__navlink'
        }
        title={collapsed ? item.label : undefined}
      >
        {content}
      </NavLink>
    </li>
  );
}
