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
            serverInfo: { name: 'combo', title: 'Combo Agent Builder', version: '0.7.0' },
            instructions:
              'For the default current-task Agent creation/share flow, derive a sanitized definition only from user-expressed requirements visible in the current top-level Codex task; Host wrappers are not user requirements. Show the public manifest fields, wait for explicit user confirmation, then use create_codex_agent_share and immediately read back the same URL. For /agent links, verify manifestSha256, render the complete ordered starter card, and only after the user confirms restore-and-run by 1-based ordinal call prepare_codex_agent_run with the exact manifest starter. Use its authoritative runEnvelope verbatim before any local restore. Do not call extraction, Capability, legacy Agent Project, or Project Agent share tools in this flow. Those legacy tools remain available only when the user explicitly requests their legacy workflow. Never pass threadId, messages, session paths, raw transcripts or secrets to Combo.',
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
          comboEnvironment: req.server.infra.env.COMBO_ENVIRONMENT,
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
    const prompt = [
      '请在当前 macOS Codex Desktop 顶层任务中完成“从当前 task 建立并分享 Codex Agent”。',
      '检测或安装前只依据本任务中用户实际表达且对用户可见的需求、约束和结论，在本地提炼 sanitized draft={name,description,agent.instructions（不超过 8000 字符）,1–5 条唯一 starterPrompts,requirements}；此阶段对 Plugin helper、本地文件、tracked guidance、Git 与 Git network 的调用数都为 0，也不读取 repositoryUrl/sourceRef/commitSha/treeSha。recommended_plugins、in-app-browser-context、heartbeat、app-context、codex_delegation、source_thread_id 等 Host 注入 wrapper 不是用户需求，不得进入草稿、handoff 或 manifest。创建者必须自行声明这些公开文本已从当前 task 派生并完成必要去敏，但服务端不能证明 instructions 已脱敏或不含原文。',
      'schema 不接收独立的 raw task、threadId、messages、session、路径、transcript、Cookie、验证码、令牌、秘密或环境变量值；rawStored=false 只表示没有独立 raw task blob。',
      '先只读检查当前任务是否同时可调用 render_agent_builder、create_codex_agent_share、read_codex_agent_share、prepare_codex_agent_run，并按下述 Desktop CLI 检查 official source、installed/enabled semver>=0.7.0 与精确 Test MCP。任一工具或 metadata 缺失、过旧或不合时，才冻结独立 combo.creator-bootstrap-handoff/1：固定字段顺序为 {schemaVersion:"combo.creator-bootstrap-handoff/1",continueIntent:"create_codex_agent_share",sameSavedProjectRequired:true,draft:{name,description,agent:{instructions,starterPrompts},requirements},behaviorMarker:"COMBO_CREATOR_HANDOFF_READY"}。requirements 内若有 codexVersion 必须排第一且无值时省略，随后固定为 commands、plugins、environmentVariableNames，后三项即使为空也显式写 []。它只含公开派生草稿与续跑意图，不含 source Git facts、路径、Project ID、原始会话或 Host wrapper；JSON.stringify 后必须把实际 <、>、&、U+2028、U+2029 分别转成小写 \\u003c、\\u003e、\\u0026、\\u2028、\\u2029，作为 Host-safe compact JSON。',
      '每次 CLI 调用都直接使用绝对路径 "/Applications/ChatGPT.app/Contents/Resources/codex"；不得依赖环境变量在不同 exec 调用间持久，也不依赖 PATH；不要求用户手动打开 shell 或二次粘贴。',
      '先分别执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace list --json 与 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin list --json，记录 marketplaceInitiallyPresent 与 upgradePerformed=false。若 name=dangdang-tech-combo 已存在，必须确认 marketplaceSource.sourceType=git 且 marketplaceSource.source 精确等于 https://github.com/dangdang-tech/combo-plugin.git；同名错源、Plugin 已安装但 Marketplace 缺失、无效语义版本等异常组合立即 STOP，不 remove、不覆盖。',
      '若 Marketplace 与 Plugin 初始都缺失，执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace add https://github.com/dangdang-tech/combo-plugin.git --ref codex/combo-plugin-v2-ui --json，再重新执行 marketplace list 与 plugin list 并验证官方 source。若 marketplaceInitiallyPresent=true 且官方 Marketplace 已存在、Plugin 缺失或有效 version<0.7.0，则先精确验证官方 source，再恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace upgrade dangdang-tech-combo --json，设置 upgradePerformed=true，并重新读取两份 metadata。无论 marketplaceInitiallyPresent 初值为何，只要此时已确认 official Marketplace 且 Plugin 仍缺失，就恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin add combo@dangdang-tech-combo --json，并再次读取 plugin list；同一状态机内 plugin add 最多一次。fresh install 的固定顺序必须是 marketplace add→重新读取并确认 official source→plugin add→最终检查。',
      '若 Plugin add 或刷新后得到有效 version<0.7.0 且 upgradePerformed=false，必须重新验证 official Marketplace source，恰好再执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace upgrade dangdang-tech-combo --json，设置 upgradePerformed=true，并重新读取 marketplace list 与 plugin list；若升级后仍低于 0.7.0，或 upgradePerformed=true 时仍低于 0.7.0，立即 STOP。整个状态机 marketplace upgrade 最多执行一次。',
      '最后再次执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace list --json、"/Applications/ChatGPT.app/Contents/Resources/codex" plugin list --json 与 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp get combo --json；功能门要求 Plugin 是有效语义版本且 version>=0.7.0、installed=true、enabled=true、marketplaceSource 精确匹配，MCP 必须得到 name=combo、enabled=true、disabled_reason=null、transport.type=streamable_http，且 transport.url 精确等于 https://test.43-160-242-46.sslip.io/api/external-mcp/mcp；当前 0.7.0 Test 候选验收另要求 exact version=0.7.0。不符立即 STOP，不 remove、不 mcp add。',
      '只有初始检查四工具与全部 metadata 已同时满足时才留在当前任务，并跳过安装变更、creatorHandoff 与 create_thread；此 stay-current 分支在首次 Combo 工具调用前主动 mcp login combo 的调用数必须为 0。否则完成安全安装/升级与最终 metadata 校验后、任何 create_thread 之前，必须用绝对 bundled CLI 恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp login combo 完成 Codex-managed OAuth；失败或用户取消立即 STOP，create_thread 调用数必须为 0。OAuth 成功后才依靠正式 Host 已保存的 target 绑定，用 list_projects 精确且唯一定位当前 saved Project；把上述 Host-safe compact JSON 逐字指定为 creatorHandoff，再精确调用 create_thread({prompt:creatorHandoff,target:{type:"project",projectId,environment:{type:"local"}}})。creatorHandoff 必须是唯一 prompt，且不算用户确认。子任务必须先 parse handoff、完成 readiness，再由已安装 Skill/helper 只读获取 source Git facts 与 tracked guidance，综合后完整重显草稿，并在这些证据之后的 assistant agentMessage（phase="final_answer"）中以独立一行逐字输出 COMBO_CREATOR_HANDOFF_READY；到此 create_codex_agent_share 调用数必须为 0。只返回 clientThreadId 时立即失败关闭，不能把它传给 wait_threads/read_thread，也不能重建任务；只有同时返回 ready threadId 与 hostId 才调用 wait_threads，再用 list_threads 按该 threadId 核对 documented project context 的 projectId 精确匹配，并用 read_thread({threadId,hostId,includeOutputs:true,maxOutputCharsPerItem:20000,turnLimit:10}) 检查 readiness/render/helper 的实际 tool item、Project context 与后续 assistant marker；不要从可能截断的 readback 逐字重建最大草稿，完整草稿由子任务卡片供用户直接审查。只接受这些实际证据之后、assistant agentMessage（phase="final_answer"）里的独立一行逐字等于 COMBO_CREATOR_HANDOFF_READY；绝不能匹配 userMessage、codexDelegation、tool input、echo 或 creatorHandoff 输入中已有的 marker 字面量。父任务看到合格的 assistant agentMessage 后必须立即只调用一次 navigate_to_codex_page(threadId) 显示该续跑任务，不得留在父任务等待确认或要求子任务先创建。Host 注入的 source thread 标识属于 harness metadata，不得写入 Combo manifest。',
      '工具可用的当前任务或续跑任务必须同时发现 render_agent_builder、create_codex_agent_share、read_codex_agent_share、prepare_codex_agent_run，并实际成功调用 render_agent_builder({stage:"readiness",title:"Combo Codex Agent 就绪检查",summary:"仅验证 Combo MCP 展示与授权是否可用。",progress:[],items:[],actions:[]})；随后由已安装 Skill/helper 只读获取 source Git facts 与 tracked guidance，综合后完整重显草稿，不能把 creatorHandoff 当作确认。全程零重启，任一工具缺失或 readiness 调用失败就准确报告 Plugin tool catalog 阻断并停止；continuation 分支禁止再次 mcp login combo，也禁止再创建续跑任务。',
      '仅 stay-current 分支在可调用 Combo 工具明确返回 authorization 错误时，才可恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp login combo；登录成功后只重试原工具，失败或取消就 STOP，不得重建任务。',
      'readiness 通过后，用 render_agent_builder 展示将公开的全部字段：完整 instructions 放在一个 fact.value，starterPrompts 逐条展示，并披露任何持链接者都可匿名读取、当前 V1 不支持撤销或过期；它不是账户授权或 OAuth token，但它是未列出的公开定位链接，持有即匿名可读，请按公开内容处理。明确确认前不调用写工具。',
      'V1 sourceRef 必须是以字母或数字起始、只含 ASCII 字母数字及 ._/- 的完整 refs/heads/... 或 refs/tags/...，并满足无 ..、//、隐藏 component、.lock component 或尾部点/斜杠；任一不符立即 STOP，不能传给 helper 或创建工具。V0 ref 契约不在本流程内改写。',
      '得到明确确认并确认 worktree clean、HEAD 已 committed 后，由已安装 Skill 按参数契约调用 Plugin 内置 helper 的 verify-source mode 核验当前 root、sourceRef、commitSha、treeSha 与远端 ref；不得内嵌 shell 实现。',
      '验证通过才调用 create_codex_agent_share；成功后立即用服务返回的同一 shareUrl 调用 read_codex_agent_share，逐字段确认 manifest、manifestSha256 与 copyPrompt 和 create 结果完全一致，任何不一致都停止且不得重建。新链路对 create_extraction_task、list_capabilities、create_agent_project、commit_agent_revision、create_project_agent_share 等旧工具的调用数必须为 0。',
    ].join('');
    const inspectionCommands =
      `${codex} plugin marketplace list --json\n` +
      `${codex} plugin list --json\n` +
      `${codex} mcp get combo --json`;
    const upgradeCommands = `${codex} plugin marketplace upgrade dangdang-tech-combo --json`;
    const marketplaceInstallCommand = `${codex} plugin marketplace add https://github.com/dangdang-tech/combo-plugin.git --ref codex/combo-plugin-v2-ui --json`;
    const pluginInstallCommand = `${codex} plugin add combo@dangdang-tech-combo --json`;
    const loginCommand = `${codex} mcp login combo`;
    const body = `<h1>在 Codex 中使用 Combo Test</h1><p>当前指南对应 Creator Bootstrap 与 Combo Plugin 0.7.0 Test 候选。</p>
<p>把下面这句话复制到 Codex Desktop：</p><textarea readonly>${escapeHtml(prompt)}</textarea>
<h2>先做只读精确检查</h2><textarea readonly>${escapeHtml(inspectionCommands)}</textarea><p>Marketplace name 必须对应官方 Git source；同名错源、Plugin 已安装但 Marketplace 缺失、无效版本等异常组合立即停止。功能门要求 Plugin 是已安装且启用的有效 semver &gt;=0.7.0，MCP transport URL 必须精确指向 Combo Test；当前 0.7.0 Test 候选验收另要求 exact 0.7.0。不删除或覆盖现有配置。</p>
<h2>官方 Marketplace 需要刷新</h2><p>官方 Marketplace 初始已存在且 Plugin 缺失或有效版本低于 0.7.0 时，先验证官方 source，再最多升级 Marketplace 一次并重新执行只读检查：</p><textarea readonly>${escapeHtml(upgradeCommands)}</textarea>
<h2>Marketplace 与 Combo Plugin 都未安装</h2><p>仅在两者都不存在时先执行 Marketplace add：</p><textarea readonly>${escapeHtml(marketplaceInstallCommand)}</textarea><p>重新执行只读检查并确认 official source。无论 <code>marketplaceInitiallyPresent</code> 初值为何，只要此时已确认 official Marketplace 且 Plugin 仍缺失，就恰好执行一次：</p><textarea readonly>${escapeHtml(pluginInstallCommand)}</textarea><p>同一状态机内 Plugin add 最多一次；fresh install 固定按 Marketplace add → 重新读取并确认 official source → Plugin add → 最终检查执行。若新安装 Plugin 仍低于 0.7.0 且本轮尚未 upgrade，验证官方 source 后恰好补一次 Marketplace upgrade 并重新读取；仍低于 0.7.0 就停止。整个状态机最多 upgrade 一次。若同名 source 不同则停止。</p>
<h2>Codex-managed OAuth</h2><p>初始四工具与 metadata 全满足而留在当前任务时不主动登录；只有工具明确返回 authorization 错误，才恰好登录一次并只重试原调用。只要进入安装或升级 continuation，则在最终 metadata 校验后、任何 create_thread 前恰好执行一次：</p><textarea readonly>${escapeHtml(loginCommand)}</textarea><p>失败或用户取消立即停止且不创建任务；续跑任务禁止再次登录或再次建任务。验证码只在 Combo Test 浏览器页面输入。</p>
<ol><li>通过正式 Codex Host 在同一 Project 的新顶层任务确认 <code>render_agent_builder</code>、<code>create_codex_agent_share</code>、<code>read_codex_agent_share</code> 与 <code>prepare_codex_agent_run</code>。</li><li>全程零重启；若新任务仍缺工具，准确报告 Plugin tool catalog 阻断，不再登录或重建任务。</li></ol>
<p>Combo Plugin 0.7.0 仍保留 <code>read_project_agent_share</code>，已有 <code>combo.project-agent-share/1</code> 链接继续走冻结的旧接收文案，不会被新默认链路替代。</p>
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
