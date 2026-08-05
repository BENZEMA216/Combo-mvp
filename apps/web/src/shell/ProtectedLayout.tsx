// 受保护布局——RequireAuth 放行后渲染：用真实会话身份喂 AccountProvider，再挂外壳 Shell。
// 守卫保证只有已登录用户到这里，故外壳账号区永远是真实登录人。Shell 内自带 <Outlet> 渲染子页。
import type { ReactElement } from 'react';
import { Shell } from './Shell.js';
import { AccountProvider, accountFromMe } from './account.js';
import { useAuth } from './auth.js';
import { useCreationResume } from './useCreationResume.js';

export function ProtectedLayout(): ReactElement {
  const { me } = useAuth();
  const creationResume = useCreationResume();
  // me 必非空：本布局只在 RequireAuth 判定 authed 后渲染。兜底取默认账号，绝不裸崩。
  const account = me ? accountFromMe(me) : undefined;
  return (
    <AccountProvider {...(account ? { account } : {})}>
      <Shell creationResume={creationResume} />
    </AccountProvider>
  );
}
