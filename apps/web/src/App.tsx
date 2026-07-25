// 创作端前端路由树：受保护组（创作者外壳）+ 公开组（裸壳），中间隔一道登录守卫。
//
// 受保护组（RequireAuth → ProtectedLayout）：任务页（默认）/ 任务详情 / 能力页。
//   守卫在路由层堵住未登录直达：anon → 裸登录闸门，error → 人话重试（绝不裸转圈/裸错误码）。
// 公开组（PublicLayout 裸壳，无侧栏/账号）：公开能力页 /a/:slug、公开创作者页 /c/:slug
//   （两页数据走前端 mock 层）、登录页（承接 OIDC 失败回跳 ?failureId=）+ 404 兜底。
//   在 AuthProvider 之外——匿名访问公开页不发 /me。
import type { ReactElement } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './shell/auth.js';
import { ProtectedLayout } from './shell/ProtectedLayout.js';
import { PublicLayout } from './shell/PublicLayout.js';
import { LoginPage, NotFoundPage } from './pages/index.js';
import { TasksPage } from './pages/tasks/TasksPage.js';
import { TaskDetailPage } from './pages/tasks/TaskDetailPage.js';
import { CapabilitiesPage } from './pages/capabilities/CapabilitiesPage.js';
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
            </Route>
          </Route>
        </Route>

        <Route element={<PublicLayout />}>
          <Route index element={<LandingPage />} />
          {/* 公开能力页 / 公开创作者主页：匿名可读，数据走前端 mock 层（publicApi）。 */}
          <Route path="/a/:slug" element={<PublicCapabilityPage />} />
          <Route path="/c/:slug" element={<PublicCreatorPage />} />
          {/* 登录页：承接 OIDC 回调失败回跳 /login?failureId=<opaque> + 通用登录引导。 */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
