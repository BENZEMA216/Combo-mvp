// 对外裸壳 PublicLayout——公开/404 页用：无创作者外壳（侧栏 / 账号 / 视角开关一律不出现）。
//
// Landing、公开能力页 /a/:slug、公开创作者主页 /c/:slug、404 都渲染在这里。只留公开品牌
// 导航，避免创作者后台账号（如 Wayne）/ 侧栏在对外页面渗漏（BUG-005/006）。
import type { ReactElement } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ComboMark, ComboWordmark } from './brand.js';

export function PublicLayout(): ReactElement {
  const { pathname } = useLocation();
  const showAgentEntry = pathname !== '/login';
  const shellClass =
    pathname === '/' ? 'cb-public-shell cb-public-shell--landing' : 'cb-public-shell';

  return (
    <div className={shellClass}>
      <header className="cb-public-shell__top">
        <Link to="/" className="cb-public-shell__brand" aria-label="Combo 首页">
          <ComboMark className="cb-public-shell__brand-mark" />
          <ComboWordmark className="cb-public-shell__brand-word" />
        </Link>
        {showAgentEntry && (
          <Link to="/capabilities" className="cb-public-shell__agent-entry">
            查看我的 Agent
            <span aria-hidden="true">→</span>
          </Link>
        )}
      </header>
      <main className="cb-public-shell__content">
        <Outlet />
      </main>
    </div>
  );
}
