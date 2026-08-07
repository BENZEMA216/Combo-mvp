import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  CODEX_PLUGIN_GUIDE_PATH,
  EXTERNAL_MCP_PATH,
  McpInitializeParamsSchema,
  MCP_OAUTH_SCOPES,
  McpJsonRpcMessageSchema,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
  OAUTH_MCP_PROTECTED_RESOURCE_METADATA_PATH,
  OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  OAUTH_REGISTRATION_PATH,
  OAUTH_TOKEN_PATH,
  type OAuthAuthorizationServerMetadata,
  type OAuthErrorResponse,
  type OAuthProtectedResourceMetadata,
} from '@cb/shared';
import { asTxPool } from '../../platform/infra/db-tx.js';
import { authSessionCookieName } from '@cb/shared';
import { externalMcpPublicOrigin, mcpRuntimeInternalBaseUrl } from '../../platform/config/env.js';
import { resolveAuthSession } from '../../platform/infra/auth-session.js';
import { isTrustedMutationRequest } from '../../platform/http/browser-origin.js';
import {
  beginAuthorization,
  createOAuthCleanupScheduler,
  decideAuthorization,
  externalMcpResourceUri,
  getPendingAuthorization,
  issueTokens,
  registerDynamicClient,
  resolveMcpBearer,
} from './service.js';
import { EXTERNAL_MCP_TOOLS, executeExternalMcpTool, toolTxPool } from './tools.js';
import {
  AGENT_BUILDER_APP_RESOURCE,
  AGENT_BUILDER_APP_URI,
  agentBuilderAppResourceContents,
} from './agent-builder-app.js';
import { McpRuntimeClient } from './runtime-client.js';

const NO_STORE = 'no-store';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const MCP_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const LATEST_MCP_PROTOCOL_VERSION = '2025-11-25';
const maybeCleanupOAuthArtifacts = createOAuthCleanupScheduler();

async function runScheduledOAuthCleanup(req: FastifyRequest): Promise<void> {
  try {
    await maybeCleanupOAuthArtifacts(req.server.infra.db);
  } catch {
    // 清理是有界的流量驱动维护；失败不能改变 OAuth/MCP 主请求语义，下个时间窗再试。
    req.log.warn({ traceId: req.id }, 'bounded oauth cleanup unavailable');
  }
}

function publicOrigin(req: FastifyRequest): string {
  return externalMcpPublicOrigin(req.server.infra.env);
}

function resourceUri(req: FastifyRequest): string {
  return externalMcpResourceUri(publicOrigin(req));
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', NO_STORE);
  reply.header('pragma', 'no-cache');
}

function htmlSecurityHeaders(
  reply: FastifyReply,
  options: {
    referrerPolicy?: 'no-referrer' | 'strict-origin';
    formActionOrigin?: string;
  } = {},
): void {
  const formAction = [
    "'self'",
    ...(options.formActionOrigin ? [options.formActionOrigin] : []),
  ].join(' ');
  noStore(reply);
  reply.header(
    'content-security-policy',
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
  );
  reply.header('referrer-policy', options.referrerPolicy ?? 'no-referrer');
  reply.header('x-content-type-options', 'nosniff');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{margin:0;background:#f6f7f9;color:#172033;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}.card{max-width:680px;margin:8vh auto;padding:32px;background:#fff;border:1px solid #dde2ea;border-radius:18px;box-shadow:0 12px 40px #16203314}h1{margin:0 0 12px;font-size:28px}p{color:#4b5567}.scope{padding:12px 16px;background:#f1f5f9;border-radius:10px}button,.button{display:inline-block;border:0;border-radius:10px;padding:11px 18px;font:inherit;font-weight:650;text-decoration:none;cursor:pointer}.primary{background:#171e2c;color:#fff}.secondary{background:#e8edf4;color:#172033;margin-left:8px}code,textarea{font-family:ui-monospace,SFMono-Regular,monospace}textarea{box-sizing:border-box;width:100%;min-height:120px;padding:12px;border:1px solid #ccd4df;border-radius:10px;resize:vertical}ol{padding-left:22px}
</style></head><body><main class="card">${body}</main></body></html>`;
}

function oauthError(
  reply: FastifyReply,
  status: number,
  error: OAuthErrorResponse['error'],
  description: string,
): FastifyReply {
  noStore(reply);
  const body: OAuthErrorResponse = { error, error_description: description };
  return reply.code(status).type(JSON_CONTENT_TYPE).send(body);
}

function authorizationFailurePage(
  reply: FastifyReply,
  status: number,
  message: string,
): FastifyReply {
  htmlSecurityHeaders(reply);
  return reply
    .code(status)
    .type(HTML_CONTENT_TYPE)
    .send(page('Combo 授权未完成', `<h1>授权未完成</h1><p>${escapeHtml(message)}</p>`));
}

export function protectedResourceMetadataHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    const origin = publicOrigin(req);
    const body: OAuthProtectedResourceMetadata = {
      resource: externalMcpResourceUri(origin),
      authorization_servers: [origin],
      scopes_supported: [...MCP_OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
    };
    return reply.code(200).type(JSON_CONTENT_TYPE).send(body);
  };
}

export function authorizationServerMetadataHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    const origin = publicOrigin(req);
    const body: OAuthAuthorizationServerMetadata = {
      issuer: origin,
      authorization_endpoint: `${origin}${OAUTH_AUTHORIZE_PATH}`,
      token_endpoint: `${origin}${OAUTH_TOKEN_PATH}`,
      registration_endpoint: `${origin}${OAUTH_REGISTRATION_PATH}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...MCP_OAUTH_SCOPES],
    };
    return reply.code(200).type(JSON_CONTENT_TYPE).send(body);
  };
}

export function dynamicClientRegistrationHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    if (req.headers.authorization !== undefined) {
      return oauthError(
        reply,
        400,
        'invalid_request',
        'Public clients must register without credentials.',
      );
    }
    try {
      const outcome = await registerDynamicClient(req.server.infra.db, req.body);
      if (outcome.kind === 'invalid_request') {
        return oauthError(reply, 400, 'invalid_request', 'Dynamic client metadata is invalid.');
      }
      if (outcome.kind === 'capacity_exceeded') {
        return oauthError(
          reply,
          503,
          'temporarily_unavailable',
          'Registration capacity is temporarily unavailable.',
        );
      }
      return reply.code(201).type(JSON_CONTENT_TYPE).send(outcome.response);
    } catch {
      req.log.warn({ traceId: req.id }, 'oauth dynamic registration unavailable');
      return oauthError(
        reply,
        503,
        'temporarily_unavailable',
        'Registration is temporarily unavailable.',
      );
    }
  };
}

function authorizationResumePath(requestToken: string): string {
  return `${OAUTH_AUTHORIZE_PATH}?request=${encodeURIComponent(requestToken)}`;
}

function authorizationCallbackPresentation(redirectUri: string): {
  label: string;
  origin: string;
} {
  const callback = new URL(redirectUri);
  return {
    label: `${callback.hostname}${callback.pathname}`,
    origin: callback.origin,
  };
}

function queryValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// RFC 8707 allows resource to occur more than once. Codex can send the same single resource from
// both the Plugin's oauth_resource and protected-resource discovery; accept only identical values.
function queryResourceValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  return typeof first === 'string' && value.every((item) => item === first) ? first : undefined;
}

export function authorizationGetHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const requestToken = queryValue(query.request);
    if (!requestToken) {
      let outcome;
      try {
        outcome = await beginAuthorization(
          req.server.infra.db,
          {
            responseType: queryValue(query.response_type),
            clientId: queryValue(query.client_id),
            redirectUri: queryValue(query.redirect_uri),
            scope: queryValue(query.scope),
            state: queryValue(query.state),
            codeChallenge: queryValue(query.code_challenge),
            codeChallengeMethod: queryValue(query.code_challenge_method),
            resource: queryResourceValue(query.resource),
          },
          resourceUri(req),
        );
      } catch {
        return authorizationFailurePage(reply, 503, '授权服务暂时不可用，请回到 Codex 重试。');
      }
      if (outcome.kind !== 'created') {
        return authorizationFailurePage(
          reply,
          400,
          outcome.kind === 'invalid_scope'
            ? 'Codex 请求的授权范围不受支持。'
            : 'Codex 发来的授权请求无效，请重新运行登录命令。',
        );
      }
      return reply.redirect(authorizationResumePath(outcome.requestToken), 303);
    }

    let pending;
    try {
      pending = await getPendingAuthorization(req.server.infra.db, requestToken);
    } catch {
      return authorizationFailurePage(reply, 503, '授权服务暂时不可用，请稍后重试。');
    }
    if (!pending)
      return authorizationFailurePage(reply, 400, '授权请求已失效，请回到 Codex 重试。');

    let session;
    try {
      const cookieName = authSessionCookieName(req.server.infra.env.SESSION_COOKIE_SECURE);
      session = await resolveAuthSession(req.server.infra.db, req.cookies?.[cookieName]);
    } catch {
      return authorizationFailurePage(reply, 503, '暂时无法确认登录状态，请稍后重试。');
    }
    if (session.kind === 'disabled') {
      return authorizationFailurePage(reply, 403, '当前 Combo 账号已停用。');
    }
    if (session.kind !== 'valid') {
      const returnTo = authorizationResumePath(requestToken);
      return reply.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`, 303);
    }

    const callback = authorizationCallbackPresentation(pending.redirectUri);
    // The same-origin POST is guarded by exact Origin. Its redirect remains a form navigation,
    // so CSP must also admit only this already-validated loopback origin for the Codex callback.
    htmlSecurityHeaders(reply, {
      referrerPolicy: 'strict-origin',
      formActionOrigin: callback.origin,
    });
    const scopes = pending.scope
      .split(' ')
      .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
      .join('');
    const body = `<h1>授权 Codex 使用 Combo</h1>
<p><strong>${escapeHtml(pending.clientName)}</strong> 请求以账号 <code>${escapeHtml(session.context.account)}</code> 使用你的 Combo Agent Builder。</p>
<p>授权结果只会返回到本机回调 <code>${escapeHtml(callback.label)}</code>。</p>
<div class="scope"><strong>授权范围</strong><ul>${scopes}</ul></div>
<p>授权后，Codex 只获得绑定 Combo MCP 地址的短期 Bearer Token；浏览器 Session Cookie 不会交给 Codex。</p>
<form method="post" action="${OAUTH_AUTHORIZE_PATH}">
<input type="hidden" name="request" value="${escapeHtml(requestToken)}">
<button class="primary" type="submit" name="decision" value="approve">允许</button>
<button class="secondary" type="submit" name="decision" value="deny">取消</button>
</form>`;
    return reply.code(200).type(HTML_CONTENT_TYPE).send(page('授权 Codex 使用 Combo', body));
  };
}

function formBody(body: unknown): URLSearchParams | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  try {
    return new URLSearchParams(body);
  } catch {
    return null;
  }
}

export function authorizationPostHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    if (!isTrustedMutationRequest(req)) {
      return authorizationFailurePage(reply, 403, '授权确认来源无效，请回到 Codex 重试。');
    }
    const form = formBody(req.body);
    const requestValues = form?.getAll('request') ?? [];
    const decisionValues = form?.getAll('decision') ?? [];
    const requestToken = requestValues[0];
    const decision = decisionValues[0];
    if (
      requestValues.length !== 1 ||
      decisionValues.length !== 1 ||
      !requestToken ||
      (decision !== 'approve' && decision !== 'deny')
    ) {
      return authorizationFailurePage(reply, 400, '授权确认内容无效。');
    }

    let session;
    try {
      const cookieName = authSessionCookieName(req.server.infra.env.SESSION_COOKIE_SECURE);
      session = await resolveAuthSession(req.server.infra.db, req.cookies?.[cookieName]);
    } catch {
      return authorizationFailurePage(reply, 503, '暂时无法确认登录状态，请稍后重试。');
    }
    if (session.kind !== 'valid') {
      return reply.redirect(
        `/login?returnTo=${encodeURIComponent(authorizationResumePath(requestToken))}`,
        303,
      );
    }
    try {
      const outcome = await decideAuthorization(asTxPool(req.server.infra.db), {
        requestToken,
        decision,
        ownerUserId: session.context.userId,
      });
      if (outcome.kind === 'invalid') {
        return authorizationFailurePage(reply, 400, '授权请求已失效，请回到 Codex 重试。');
      }
      return reply.redirect(outcome.redirectUrl, 303);
    } catch {
      return authorizationFailurePage(reply, 503, '授权服务暂时不可用，请稍后重试。');
    }
  };
}

export function tokenHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    if (req.headers.authorization !== undefined) {
      return oauthError(reply, 401, 'invalid_client', 'This endpoint accepts public clients only.');
    }
    const form = formBody(req.body);
    if (!form) return oauthError(reply, 400, 'invalid_request', 'The token request is invalid.');
    try {
      const outcome = await issueTokens(asTxPool(req.server.infra.db), form, resourceUri(req));
      if (outcome.kind === 'issued') {
        return reply.code(200).type(JSON_CONTENT_TYPE).send(outcome.response);
      }
      const status = outcome.kind === 'invalid_client' ? 401 : 400;
      return oauthError(
        reply,
        status,
        outcome.kind,
        outcome.kind === 'invalid_grant'
          ? 'The authorization grant is invalid, expired, or already used.'
          : 'The token request is invalid.',
      );
    } catch {
      req.log.warn({ traceId: req.id }, 'oauth token exchange unavailable');
      return oauthError(
        reply,
        503,
        'temporarily_unavailable',
        'Token issuance is temporarily unavailable.',
      );
    }
  };
}

function bearerChallenge(req: FastifyRequest, reply: FastifyReply): void {
  const metadata = `${publicOrigin(req)}${OAUTH_MCP_PROTECTED_RESOURCE_METADATA_PATH}`;
  reply.header(
    'www-authenticate',
    `Bearer resource_metadata="${metadata}", scope="${MCP_OAUTH_SCOPES.join(' ')}"`,
  );
  reply.header('access-control-expose-headers', 'WWW-Authenticate');
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function acceptsMcpResponse(req: FastifyRequest): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== 'string') return false;
  const values = accept.toLowerCase();
  return values.includes('application/json') && values.includes('text/event-stream');
}

async function authenticateMcp(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authorization =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const resolution = await resolveMcpBearer(req.server.infra.db, authorization, resourceUri(req));
    if (resolution.kind === 'valid') return resolution.principal;
    bearerChallenge(req, reply);
    reply
      .code(resolution.kind === 'disabled' ? 403 : 401)
      .type(JSON_CONTENT_TYPE)
      .send({
        error: resolution.kind === 'disabled' ? 'account_disabled' : 'invalid_token',
      });
    return null;
  } catch {
    reply.code(503).type(JSON_CONTENT_TYPE).send({ error: 'temporarily_unavailable' });
    return null;
  }
}

function trustedMcpOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === publicOrigin(req);
}

export function mcpGetHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    if (!trustedMcpOrigin(req)) return reply.code(403).send();
    const principal = await authenticateMcp(req, reply);
    if (!principal) return reply;
    reply.header('allow', 'POST');
    return reply.code(405).send();
  };
}

export function mcpPostHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    if (!trustedMcpOrigin(req)) return reply.code(403).send();
    const principal = await authenticateMcp(req, reply);
    if (!principal) return reply;
    if (!acceptsMcpResponse(req)) {
      return reply
        .code(406)
        .type(JSON_CONTENT_TYPE)
        .send(
          jsonRpcError(null, -32600, 'Accept must include application/json and text/event-stream.'),
        );
    }
    if (Array.isArray(req.body)) {
      return reply
        .code(400)
        .type(JSON_CONTENT_TYPE)
        .send(jsonRpcError(null, -32600, 'JSON-RPC batching is not supported.'));
    }
    const parsed = McpJsonRpcMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .type(JSON_CONTENT_TYPE)
        .send(jsonRpcError(null, -32600, 'Invalid JSON-RPC request.'));
    }
    const message = parsed.data;
    const id = message.id ?? null;
    const headerVersion = req.headers['mcp-protocol-version'];
    if (typeof headerVersion === 'string' && !MCP_PROTOCOL_VERSIONS.has(headerVersion)) {
      return reply
        .code(400)
        .type(JSON_CONTENT_TYPE)
        .send(jsonRpcError(id, -32600, 'Unsupported MCP-Protocol-Version.'));
    }

    if (message.method === 'notifications/initialized') return reply.code(202).send();
    if (message.id === undefined) return reply.code(202).send();

    if (message.method === 'initialize') {
      const params = McpInitializeParamsSchema.safeParse(message.params);
      if (!params.success) {
        return reply
          .code(200)
          .type(JSON_CONTENT_TYPE)
          .send(jsonRpcError(id, -32602, 'Invalid initialize params.'));
      }
      const negotiatedProtocolVersion = MCP_PROTOCOL_VERSIONS.has(params.data.protocolVersion)
        ? params.data.protocolVersion
        : LATEST_MCP_PROTOCOL_VERSION;
      return reply
        .code(200)
        .type(JSON_CONTENT_TYPE)
        .send(
          jsonRpcResult(id, {
            protocolVersion: negotiatedProtocolVersion,
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false },
            },
            serverInfo: { name: 'combo', title: 'Combo Agent Builder', version: '0.5.0' },
            instructions:
              'Call list_agent_projects first. This server is stateless, so pass every Project identity explicitly. Use render_agent_builder only after the required reads or authorized analysis; its buttons send user messages but never persist, review, or release by themselves.',
          }),
        );
    }
    if (message.method === 'ping') {
      return reply.code(200).type(JSON_CONTENT_TYPE).send(jsonRpcResult(id, {}));
    }
    if (message.method === 'tools/list') {
      return reply
        .code(200)
        .type(JSON_CONTENT_TYPE)
        .send(
          jsonRpcResult(id, {
            tools: EXTERNAL_MCP_TOOLS.map(({ requiredScope: _requiredScope, ...tool }) => tool),
          }),
        );
    }
    if (message.method === 'resources/list') {
      return reply
        .code(200)
        .type(JSON_CONTENT_TYPE)
        .send(jsonRpcResult(id, { resources: [AGENT_BUILDER_APP_RESOURCE] }));
    }
    if (message.method === 'resources/read') {
      const params = message.params as { uri?: unknown } | undefined;
      if (!params || params.uri !== AGENT_BUILDER_APP_URI) {
        return reply
          .code(200)
          .type(JSON_CONTENT_TYPE)
          .send(jsonRpcError(id, -32602, 'Unknown Combo UI resource.'));
      }
      return reply
        .code(200)
        .type(JSON_CONTENT_TYPE)
        .send(jsonRpcResult(id, agentBuilderAppResourceContents()));
    }
    if (message.method === 'tools/call') {
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      if (!params || typeof params.name !== 'string') {
        return reply
          .code(200)
          .type(JSON_CONTENT_TYPE)
          .send(jsonRpcError(id, -32602, 'Tool name is required.'));
      }
      const result = await executeExternalMcpTool(
        {
          db: req.server.infra.db,
          txPool: toolTxPool(req.server.infra.db),
          objectStore: req.server.infra.objectStore,
          principal,
          publicOrigin: publicOrigin(req),
          runtime: new McpRuntimeClient({
            baseUrl: mcpRuntimeInternalBaseUrl(req.server.infra.env),
            authorization: req.headers.authorization!,
          }),
          traceId: req.id,
        },
        params.name,
        params.arguments,
      );
      return reply.code(200).type(JSON_CONTENT_TYPE).send(jsonRpcResult(id, result));
    }
    return reply
      .code(200)
      .type(JSON_CONTENT_TYPE)
      .send(jsonRpcError(id, -32601, 'Method not found.'));
  };
}

export function codexPluginGuideHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    htmlSecurityHeaders(reply);
    const environment = req.server.infra.env.COMBO_ENVIRONMENT;
    if (environment !== 'test') {
      const explanation =
        environment === 'preview'
          ? 'Preview 环境不提供 Codex Plugin 安装。插件内的 MCP 地址是静态配置，不能用 Test 分支跨环境连接 Preview。'
          : environment === 'production'
            ? 'Production 安装尚未开放。只有独立插件版本把 MCP 地址切到 Production、合并 main 并完成验收后，这里才会提供稳定安装命令。'
            : '当前开发环境不提供可复制的 Codex Plugin 安装命令。请使用已验收的 Test 安装页。';
      const body = `<h1>Combo Codex 插件暂不可安装</h1><p>${escapeHtml(explanation)}</p>
<p>此页面不会提供指向其他环境的命令，也不要求 Cookie、验证码或访问令牌。</p>`;
      return reply.code(200).type(HTML_CONTENT_TYPE).send(page('Combo Codex 插件', body));
    }

    const codex = '"/Applications/ChatGPT.app/Contents/Resources/codex"';
    const prompt =
      '请在 macOS Codex Desktop 中使用内置 CLI 安装 Combo Test 插件，运行 OAuth 登录并在浏览器用邮箱验证码授权；然后完全退出并重开 Codex Desktop，新建一个顶层任务，先调用 list_agent_projects，再用 Combo Agent Builder 卡片完成建议、草稿、测试与发布确认。不要在聊天中发送 Cookie、验证码或访问令牌。';
    const commands =
      `${codex} plugin remove combo@dangdang-tech-combo\n` +
      `${codex} plugin marketplace remove dangdang-tech-combo\n` +
      `${codex} plugin marketplace add https://github.com/dangdang-tech/combo-plugin.git --ref codex/combo-plugin-v2-ui\n` +
      `${codex} plugin add combo@dangdang-tech-combo\n` +
      `${codex} mcp login combo`;
    const body = `<h1>在 Codex 中使用 Combo Test</h1>
<p>把下面这句话复制到 Codex Desktop：</p><textarea readonly>${escapeHtml(prompt)}</textarea>
<h2>手动升级并安装</h2><ol><li>移除旧插件和 Marketplace 缓存，再安装固定 Test 分支。</li><li>执行 OAuth 登录；验证码只在 Combo Test 浏览器页面输入。</li><li>完全新建一个任务并调用 <code>list_agent_projects</code>。</li></ol>
<textarea readonly>${escapeHtml(commands)}</textarea>
<p>Combo 不要求你在聊天中粘贴 Cookie、验证码或访问令牌。</p>`;
    return reply.code(200).type(HTML_CONTENT_TYPE).send(page('Combo Codex 插件安装', body));
  };
}

export const EXTERNAL_MCP_PUBLIC_PATHS = {
  protectedResource: OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceForMcp: OAUTH_MCP_PROTECTED_RESOURCE_METADATA_PATH,
  authorizationServer: OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
  authorize: OAUTH_AUTHORIZE_PATH,
  token: OAUTH_TOKEN_PATH,
  registration: OAUTH_REGISTRATION_PATH,
  mcp: EXTERNAL_MCP_PATH,
  guide: CODEX_PLUGIN_GUIDE_PATH,
} as const;
