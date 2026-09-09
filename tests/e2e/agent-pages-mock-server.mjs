/** Local synthetic UI fixture only. Never proxies API requests or reads an account. */
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { log } from 'node:console';
const webRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url));
const requireWeb = createRequire(webRoot + 'package.json');
const { createServer } = await import(requireWeb.resolve('vite'));
const { default: react } = await import(requireWeb.resolve('@vitejs/plugin-react'));
const port = Number(process.env.AGENT_UI_MOCK_PORT ?? 5190);
const origin = `http://127.0.0.1:${port}`;
const id = '11111111-1111-4111-8111-111111111111';
const releaseId = `release.agent-package.${'a'.repeat(32)}`;
const digest = `sha256:${'b'.repeat(64)}`;
const fingerprint = `sha256:${'c'.repeat(64)}`;
const transferPath = `/agent-transfers/${id}`;
const releasePath = `/agents/${releaseId}`;
const user = {
  id,
  account: 'creator-mockuser',
  email: 'synthetic@example.test',
  roles: ['creator'],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};
const files = [
  {
    path: 'AGENT.md',
    text: '# 项目复核助手（合成示例）\n\n帮助核对证据、明确边界，并给出下一步。\n\n不读取原始对话，不代替用户批准发布。\n\n<img src="synthetic-only" onerror="not_executed()">',
  },
  {
    path: 'skills/review/SKILL.md',
    text: '---\nname: review\ndescription: 核对项目证据\n---\n\n# 工作方法\n\n1. 先确认本次任务和材料。\n2. 对照证据，区分已证实和待确认。\n3. 给出结论与可执行的下一步。',
  },
];
const review = {
  manifestText: JSON.stringify(
    {
      protocol: 'combo.agent-package/1',
      name: '项目复核助手（合成示例）',
      description: '把分散材料整理成有依据、能行动的结论。',
    },
    null,
    2,
  ),
  packageDigest: digest,
  files,
};
const release = {
  releaseId,
  packageDigest: digest,
  shareUrl: origin + releasePath,
  acquirePrompt:
    '这是本地合成验收指令，不是真实安装链接。请在当前对话中核对这一固定版本的方法；复制不等于安装或运行。',
};
let phase = 'pending_approval';
let scenario = 'home';
let loggedIn = true;
let expiresAt = '';
let loseNextPost = false;
let approvedAt = 0;
const calls = [];
function reset(value) {
  scenario = value;
  phase = ['approved', 'uploaded', 'published', 'rejected'].includes(value)
    ? value
    : value === 'unknown'
      ? 'uploaded'
      : 'pending_approval';
  loggedIn = value !== 'login';
  expiresAt = new Date(Date.now() + (value === 'expired' ? -1000 : 600_000)).toISOString();
  loseNextPost = value === 'unknown';
  approvedAt = value === 'approved' ? Date.now() : 0;
  calls.length = 0;
}
reset('home');
function receipt() {
  const result = {
    protocol: 'combo.agent-transfer/1',
    transferId: id,
    phase,
    approvalUrl: origin + transferPath,
    verificationCode: 'AB12CD34',
    expiresAt,
  };
  if (phase === 'uploaded' || phase === 'published')
    result.saved = {
      draftId: 'synthetic-draft',
      revision: 1,
      draftFingerprint: fingerprint,
      packageDigest: digest,
    };
  if (phase === 'published') result.release = release;
  return result;
}
function send(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ data, meta: { traceId: 'synthetic-local-only' } }));
}
const scenarios = [
  'home',
  'login',
  'pending',
  'expired',
  'approved',
  'uploaded',
  'unknown',
  'published',
  'release',
  'error',
];
const banner =
  '<aside style="position:relative;z-index:10000;background:#fff3b0;color:#272318;padding:8px 16px;font:12px system-ui;text-align:center">本地合成验收 · Mock API · 无真实账号/上传/发布 · 确认码 AB12CD34 · OTP 004271 · <a href="/__mock" style="color:inherit">切换测试状态</a></aside>';
export function createAgentPagesMockServer() {
  return createServer({
    root: webRoot,
    configFile: false,
    envFile: false,
    server: { host: '127.0.0.1', port, strictPort: true, proxy: {} },
    plugins: [
      react(),
      {
        name: 'local-agent-ui-mock',
        enforce: 'pre',
        configResolved(config) {
          if (
            config.server.host !== '127.0.0.1' ||
            Object.keys(config.server.proxy ?? {}).length > 0
          )
            throw new Error('Synthetic UI must remain loopback-only with no backend proxies.');
        },
        transformIndexHtml(html) {
          return html.replace('<body>', '<body>' + banner);
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url, origin);
            if (url.pathname === '/__mock') {
              res.setHeader('content-type', 'text/html;charset=utf-8');
              res.end(
                `<html lang="zh-CN"><title>合成验收状态</title><body style="font:18px system-ui;padding:40px"><h1>本地合成验收</h1><p>仅 Mock API，不访问外部服务。浏览器操作会改变临时内存，不保存数据。</p>${scenarios.map((item) => `<p><a href="/__mock/start?scenario=${item}">${item}</a></p>`).join('')}</body></html>`,
              );
              return;
            }
            if (url.pathname === '/__mock/start') {
              const value = url.searchParams.get('scenario');
              if (!scenarios.includes(value)) return send(res, {}, 400);
              reset(value);
              res.writeHead(302, {
                location:
                  value === 'home'
                    ? '/'
                    : ['release', 'error'].includes(value)
                      ? releasePath
                      : transferPath,
              });
              return res.end();
            }
            if (url.pathname === '/__mock/evidence')
              return send(res, { scenario, phase, loggedIn, calls });
            if (['/api', '/health', '/ready'].includes(url.pathname)) return send(res, {}, 404);
            if (!url.pathname.startsWith('/api/')) return next();
            let body = {};
            try {
              let text = '';
              for await (const chunk of req) text += chunk;
              if (text) body = JSON.parse(text);
            } catch {
              return send(res, {}, 400);
            }
            calls.push({ method: req.method, path: url.pathname, body });
            if (url.pathname === '/api/v1/me')
              return send(res, loggedIn ? user : {}, loggedIn ? 200 : 401);
            if (url.pathname === '/api/v1/auth/email/challenges')
              return send(
                res,
                { accepted: true, expiresInSeconds: 300, resendAfterSeconds: 60 },
                202,
              );
            if (url.pathname === '/api/v1/auth/email/verifications') {
              if (body.code !== '004271') return send(res, {}, 401);
              loggedIn = true;
              return send(res, { user, returnTo: transferPath });
            }
            if (url.pathname.startsWith('/api/v1/agent-package-transfers/')) {
              if (!loggedIn) return send(res, {}, 401);
              if (req.method === 'POST') {
                if (body.draftFingerprint !== fingerprint || body.packageDigest !== digest)
                  return send(res, {}, 409);
                if (
                  url.pathname.endsWith('/approval') &&
                  body.verificationCode === 'AB12CD34' &&
                  phase === 'pending_approval'
                ) {
                  phase = body.decision === 'approve' ? 'approved' : 'rejected';
                  approvedAt = Date.now();
                } else if (
                  url.pathname.endsWith('/publication') &&
                  body.confirmPublic === true &&
                  phase === 'uploaded'
                )
                  phase = 'published';
                else return send(res, {}, 409);
                if (loseNextPost) {
                  loseNextPost = false;
                  // Commit succeeded but its receipt is unavailable. A 503 avoids browser-level
                  // transparent socket retries hiding the application's unknown-result branch.
                  return send(res, {}, 503);
                }
                return send(res, receipt());
              }
              if (phase === 'approved' && Date.now() - approvedAt > 8000) phase = 'uploaded';
              return send(res, {
                transfer: receipt(),
                name: '项目复核助手（合成示例）',
                draftFingerprint: fingerprint,
                packageDigest: digest,
                ...(['uploaded', 'published'].includes(phase) ? { review } : {}),
              });
            }
            if (url.pathname === `/api/v1/agent-package-publications/${releaseId}`) {
              if (scenario === 'error') return send(res, {}, 404);
              return send(res, {
                protocol: 'combo.agent-publication/1',
                release: {
                  protocol: 'combo.agent-package-release/1',
                  releaseId,
                  packageDigest: digest,
                },
                publishedAt: '2026-09-09T08:00:00.000Z',
                name: '项目复核助手（合成示例）',
                description: '把分散材料整理成有依据、能行动的结论。',
                publisher: { account: user.account },
                sourceVerification: 'not_verified',
                package: review,
                shareUrl: release.shareUrl,
                acquirePrompt: release.acquirePrompt,
              });
            }
            // No API request can fall through to a real dev backend.
            return send(res, {}, 404);
          });
        },
      },
    ],
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createAgentPagesMockServer();
  await server.listen();
  log(`Synthetic-only UI: ${origin}/__mock`);
}
