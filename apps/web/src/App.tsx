// 创作端前端路由树：受保护组（创作者外壳）+ 公开组（裸壳），中间隔一道登录守卫。
//
// 受保护组（RequireAuth → ProtectedLayout）：任务页（默认）/ 任务详情 / 能力页。
//   守卫在路由层堵住未登录直达：anon → /login（保留 returnTo），error → 人话重试。
// 公开组（PublicLayout 裸壳，无侧栏/账号）：公开能力页 /a/:slug、公开创作者页 /c/:slug、
//   完全自定义的邮箱验证码登录页和 404。登录页自行探测一次 /me，其余公开页不发会话请求。
import type { ReactElement } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './shell/auth.js';
import { ProtectedLayout } from './shell/ProtectedLayout.js';
import { PublicLayout } from './shell/PublicLayout.js';
import { LoginPage, NotFoundPage } from './pages/index.js';
import { TasksPage } from './pages/tasks/TasksPage.js';
import { TaskDetailPage } from './pages/tasks/TaskDetailPage.js';
import { CapabilitiesPage } from './pages/capabilities/CapabilitiesPage.js';
import { ReleasePage } from './pages/release/ReleasePage.js';
import { PublicCapabilityPage } from './pages/public/PublicCapabilityPage.js';
import { PublicCreatorPage } from './pages/public/PublicCreatorPage.js';
import { LandingPage } from './pages/landing/LandingPage.js';
import { ReleaseIdentityBadge } from './shell/releaseIdentity.js';

/** 受保护组根：AuthProvider 只包受保护子树，公开页匿名访问根本不发 /me。 */
function ProtectedRoot(): ReactElement {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <ReleaseIdentityBadge />
      <Routes>
        <Route element={<ProtectedRoot />}>
          <Route element={<RequireAuth />}>
            <Route element={<ProtectedLayout />}>
              {/* 旧 IA 别名：/creator 是重构前的工作台路径，旧书签/外链落过来不该 404。 */}
              <Route path="/creator" element={<Navigate to="/tasks" replace />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
              <Route path="/capabilities" element={<CapabilitiesPage />} />
              <Route path="/capabilities/:capabilityId/release" element={<ReleasePage />} />
              <Route path="/capabilities/:capabilityId/release/:step" element={<ReleasePage />} />
            </Route>
          </Route>
        </Route>

        <Route element={<PublicLayout />}>
          <Route index element={<LandingPage />} />
          {/* 公开能力页 / 公开创作者主页：匿名可读，数据走前端 mock 层（publicApi）。 */}
          <Route path="/a/:slug" element={<PublicCapabilityPage />} />
          <Route path="/c/:slug" element={<PublicCreatorPage />} />
          {/* 登录页：两步邮箱验证码表单，只接受共享契约允许的站内 returnTo。 */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
