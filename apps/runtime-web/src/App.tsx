import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './shell/AppShell.js';
import { AuthGate } from './shell/AuthGate.js';
import { ChatPage } from './pages/ChatPage.js';
import { CapabilityDeepLink } from './pages/CapabilityDeepLink.js';
import { ReleaseIdentityBadge } from './shell/releaseIdentity.js';

export const CLOSED_MARKET_TARGET = '/capabilities';

function replaceLocation(target: string): void {
  window.location.replace(target);
}

/** 市集关闭期间跨 bundle 返回创作端，不挂载任何市集数据查询。 */
export function ClosedMarketRedirect({
  replace = replaceLocation,
}: {
  replace?: (target: string) => void;
}) {
  useEffect(() => {
    replace(CLOSED_MARKET_TARGET);
  }, [replace]);

  return <p className="rt-deeplink">正在返回我的 Agent…</p>;
}

export function App() {
  return (
    <BrowserRouter basename="/try">
      <ReleaseIdentityBadge />
      <Routes>
        {/* 市集暂未开放：在登录探针之前直接回创作端，不读取任何试用端数据。 */}
        <Route index element={<ClosedMarketRedirect />} />
        <Route path="market" element={<ClosedMarketRedirect />} />
        <Route
          element={
            <AuthGate>
              <AppShell />
            </AuthGate>
          }
        >
          {/* 对话页（已存在会话 id；新会话由能力深链或会话侧栏创建）。 */}
          <Route path="session/:sessionId" element={<ChatPage />} />
          {/* 创作端「去试用」深链：为该能力建会话并转入对话页 */}
          <Route path="c/:capabilityId" element={<CapabilityDeepLink />} />
        </Route>
        <Route path="*" element={<ClosedMarketRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}
