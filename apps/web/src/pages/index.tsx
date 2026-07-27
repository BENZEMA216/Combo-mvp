// 公开组页面出口。登录页使用仓库内邮箱验证码表单；业务页在各自子目录。
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../shell/useDocumentTitle.js';

export { LoginPage } from './LoginPage.js';
export { TasksPage } from './tasks/TasksPage.js';
export { TaskDetailPage } from './tasks/TaskDetailPage.js';
export { CapabilitiesPage } from './capabilities/CapabilitiesPage.js';

/** 人话 404：给回首页和站内登录两条退路，不暴露内部信息。 */
export function NotFoundPage(): ReactElement {
  useDocumentTitle('页面不存在 · Combo');
  return (
    <section className="cb-page cb-public" aria-labelledby="cb-notfound-title">
      <div className="cb-public__notice">
        <h1 className="cb-public__title" id="cb-notfound-title">
          页面不存在或已失效
        </h1>
        <p className="cb-public__lead">你访问的链接可能已变更或不再可用。</p>
        <div className="cb-public__actions">
          <Link to="/" className="cb-public__action">
            回到首页
          </Link>
          <Link to="/login" className="cb-public__action cb-public__action--ghost">
            去登录
          </Link>
        </div>
      </div>
    </section>
  );
}
